use std::{
    collections::HashMap,
    iter::FromIterator,
    sync::{Arc, Mutex},
};

use sciter::Value;

use hbb_common::{
    allow_err,
    config::{LocalConfig, PeerConfig},
    log,
};

#[cfg(not(any(feature = "flutter", feature = "cli")))]
use crate::ui_session_interface::Session;
use crate::{common::get_app_name, ipc, ui_interface::*};

mod cm;
#[cfg(feature = "inline")]
pub mod inline;
pub mod remote;

#[allow(dead_code)]
type Status = (i32, bool, i64, String);

lazy_static::lazy_static! {
    // stupid workaround for https://sciter.com/forums/topic/crash-on-latest-tis-mac-sdk-sometimes/
    static ref STUPID_VALUES: Mutex<Vec<Arc<Vec<Value>>>> = Default::default();
}

#[cfg(not(any(feature = "flutter", feature = "cli")))]
lazy_static::lazy_static! {
    pub static ref CUR_SESSION: Arc<Mutex<Option<Session<remote::SciterHandler>>>> = Default::default();
}

struct UIHostHandler;

pub fn start(args: &mut [String]) {
    #[cfg(target_os = "macos")]
    crate::platform::delegate::show_dock();
    #[cfg(all(target_os = "linux", feature = "inline"))]
    {
        let app_dir = std::env::var("APPDIR").unwrap_or("".to_string());
        let mut so_path = "/usr/share/rustdesk/libsciter-gtk.so".to_owned();
        for (prefix, dir) in [
            ("", "/usr"),
            ("", "/app"),
            (&app_dir, "/usr"),
            (&app_dir, "/app"),
        ]
        .iter()
        {
            let path = format!("{prefix}{dir}/share/rustdesk/libsciter-gtk.so");
            if std::path::Path::new(&path).exists() {
                so_path = path;
                break;
            }
        }
        sciter::set_library(&so_path).ok();
    }
    #[cfg(windows)]
    // Check if there is a sciter.dll nearby.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sciter_dll_path = parent.join("sciter.dll");
            if sciter_dll_path.exists() {
                // Try to set the sciter dll.
                let p = sciter_dll_path.to_string_lossy().to_string();
                log::debug!("Found dll:{}, \n {:?}", p, sciter::set_library(&p));
            }
        }
    }
    // https://github.com/c-smile/sciter-sdk/blob/master/include/sciter-x-types.h
    // https://github.com/rustdesk/rustdesk/issues/132#issuecomment-886069737
    #[cfg(windows)]
    allow_err!(sciter::set_options(sciter::RuntimeOptions::GfxLayer(
        sciter::GFX_LAYER::WARP
    )));
    use sciter::SCRIPT_RUNTIME_FEATURES::*;
    allow_err!(sciter::set_options(sciter::RuntimeOptions::ScriptFeatures(
        ALLOW_FILE_IO as u8 | ALLOW_SOCKET_IO as u8 | ALLOW_EVAL as u8 | ALLOW_SYSINFO as u8
    )));
    let mut frame = sciter::WindowBuilder::main_window().create();
    #[cfg(windows)]
    allow_err!(sciter::set_options(sciter::RuntimeOptions::UxTheming(true)));
    frame.set_title(&crate::get_app_name());
    #[cfg(target_os = "macos")]
    crate::platform::delegate::make_menubar(frame.get_host(), args.is_empty());
    #[cfg(windows)]
    crate::platform::try_set_window_foreground(frame.get_hwnd() as _);
    let page;
    if args.len() > 1 && args[0] == "--play" {
        args[0] = "--connect".to_owned();
        let path: std::path::PathBuf = (&args[1]).into();
        let id = path
            .file_stem()
            .map(|p| p.to_str().unwrap_or(""))
            .unwrap_or("")
            .to_owned();
        args[1] = id;
    }
    if args.is_empty() {
        std::thread::spawn(move || check_zombie());
        crate::common::check_software_update();
        frame.event_handler(UI {});
        frame.sciter_handler(UIHostHandler {});
        page = "index.html";
        // Start pulse audio local server.
        #[cfg(target_os = "linux")]
        std::thread::spawn(crate::ipc::start_pa);
    } else if args[0] == "--install" {
        frame.event_handler(UI {});
        frame.sciter_handler(UIHostHandler {});
        page = "install.html";
    } else if args[0] == "--cm" {
        frame.register_behavior("connection-manager", move || {
            Box::new(cm::SciterConnectionManager::new())
        });
        page = "cm.html";
        *cm::HIDE_CM.lock().unwrap() = crate::ipc::get_config("hide_cm")
            .ok()
            .flatten()
            .unwrap_or_default()
            == "true";
    } else if (args[0] == "--connect"
        || args[0] == "--file-transfer"
        || args[0] == "--port-forward"
        || args[0] == "--rdp")
        && args.len() > 1
    {
        #[cfg(windows)]
        {
            let hw = frame.get_host().get_hwnd();
            crate::platform::windows::enable_lowlevel_keyboard(hw as _);
        }
        let mut iter = args.iter();
        let Some(cmd) = iter.next() else {
            log::error!("Failed to get cmd arg");
            return;
        };
        let cmd = cmd.to_owned();
        let Some(id) = iter.next() else {
            log::error!("Failed to get id arg");
            return;
        };
        let id = id.to_owned();
        let pass = iter.next().unwrap_or(&"".to_owned()).clone();
        let args: Vec<String> = iter.map(|x| x.clone()).collect();
        frame.set_title(&id);
        frame.register_behavior("native-remote", move || {
            let handler =
                remote::SciterSession::new(cmd.clone(), id.clone(), pass.clone(), args.clone());
            #[cfg(not(any(feature = "flutter", feature = "cli")))]
            {
                *CUR_SESSION.lock().unwrap() = Some(handler.inner());
            }
            Box::new(handler)
        });
        page = "remote.html";
    } else {
        log::error!("Wrong command: {:?}", args);
        return;
    }
    #[cfg(feature = "inline")]
    {
        let html = if page == "index.html" {
            inline::get_index()
        } else if page == "cm.html" {
            inline::get_cm()
        } else if page == "install.html" {
            inline::get_install()
        } else {
            inline::get_remote()
        };
        frame.load_html(html.as_bytes(), Some(page));
    }
    #[cfg(not(feature = "inline"))]
    frame.load_file(&format!(
        "file://{}/src/ui/{}",
        std::env::current_dir()
            .map(|c| c.display().to_string())
            .unwrap_or("".to_owned()),
        page
    ));
    let hide_cm = *cm::HIDE_CM.lock().unwrap();
    if !args.is_empty() && args[0] == "--cm" && hide_cm {
        // run_app calls expand(show) + run_loop, we use collapse(hide) + run_loop instead to create a hidden window
        frame.collapse(true);
        frame.run_loop();
        return;
    }
    frame.run_app();
}

struct UI {}

impl UI {
    fn recent_sessions_updated(&self) -> bool {
        recent_sessions_updated()
    }

    fn get_id(&self) -> String {
        ipc::get_id()
    }

    fn temporary_password(&mut self) -> String {
        temporary_password()
    }

    fn update_temporary_password(&self) {
        update_temporary_password()
    }

    fn set_permanent_password(&self, password: String) {
        let _ = set_permanent_password_with_result(password);
    }

    fn is_local_permanent_password_set(&self) -> bool {
        is_local_permanent_password_set()
    }

    fn is_permanent_password_set(&self) -> bool {
        is_permanent_password_set()
    }

    fn get_remote_id(&mut self) -> String {
        LocalConfig::get_remote_id()
    }

    fn set_remote_id(&mut self, id: String) {
        LocalConfig::set_remote_id(&id);
    }

    fn goto_install(&mut self) {
        goto_install();
    }

    fn install_me(&mut self, _options: String, _path: String) {
        install_me(_options, _path, false, false);
    }

    fn update_me(&self, _path: String) {
        update_me(_path);
    }

    fn run_without_install(&self) {
        run_without_install();
    }

    fn show_run_without_install(&self) -> bool {
        show_run_without_install()
    }

    fn get_license(&self) -> String {
        get_license()
    }

    fn get_option(&self, key: String) -> String {
        get_option(key)
    }

    fn get_local_option(&self, key: String) -> String {
        get_local_option(key)
    }

    fn set_local_option(&self, key: String, value: String) {
        set_local_option(key, value);
    }

    fn peer_has_password(&self, id: String) -> bool {
        peer_has_password(id)
    }

    fn forget_password(&self, id: String) {
        forget_password(id)
    }

    fn get_peer_option(&self, id: String, name: String) -> String {
        get_peer_option(id, name)
    }

    fn set_peer_option(&self, id: String, name: String, value: String) {
        set_peer_option(id, name, value)
    }

    fn using_public_server(&self) -> bool {
        crate::using_public_server()
    }

    fn is_incoming_only(&self) -> bool {
        hbb_common::config::is_incoming_only()
    }

    pub fn is_outgoing_only(&self) -> bool {
        hbb_common::config::is_outgoing_only()
    }

    pub fn is_custom_client(&self) -> bool {
        crate::common::is_custom_client()
    }

    pub fn is_disable_settings(&self) -> bool {
        hbb_common::config::is_disable_settings()
    }

    pub fn is_disable_account(&self) -> bool {
        hbb_common::config::is_disable_account()
    }

    pub fn is_disable_installation(&self) -> bool {
        hbb_common::config::is_disable_installation()
    }

    pub fn is_disable_ab(&self) -> bool {
        hbb_common::config::is_disable_ab()
    }

    fn get_options(&self) -> Value {
        let hashmap: HashMap<String, String> =
            serde_json::from_str(&get_options()).unwrap_or_default();
        let mut m = Value::map();
        for (k, v) in hashmap {
            m.set_item(k, v);
        }
        m
    }

    fn test_if_valid_server(&self, host: String, test_with_proxy: bool) -> String {
        test_if_valid_server(host, test_with_proxy)
    }

    fn get_sound_inputs(&self) -> Value {
        Value::from_iter(get_sound_inputs())
    }

    fn set_options(&self, v: Value) {
        let mut m = HashMap::new();
        for (k, v) in v.items() {
            if let Some(k) = k.as_string() {
                if let Some(v) = v.as_string() {
                    if !v.is_empty() {
                        m.insert(k, v);
                    }
                }
            }
        }
        set_options(m);
    }

    fn set_option(&self, key: String, value: String) {
        set_option(key, value);
    }

    fn install_path(&mut self) -> String {
        install_path()
    }

    fn install_options(&self) -> String {
        install_options()
    }

    fn get_socks(&self) -> Value {
        Value::from_iter(get_socks())
    }

    fn set_socks(&self, proxy: String, username: String, password: String) {
        set_socks(proxy, username, password)
    }

    fn is_installed(&self) -> bool {
        is_installed()
    }

    fn get_supported_privacy_mode_impls(&self) -> String {
        serde_json::to_string(&crate::privacy_mode::get_supported_privacy_mode_impl())
            .unwrap_or_default()
    }

    fn is_root(&self) -> bool {
        is_root()
    }

    fn is_release(&self) -> bool {
        #[cfg(not(debug_assertions))]
        return true;
        #[cfg(debug_assertions)]
        return false;
    }

    fn is_share_rdp(&self) -> bool {
        is_share_rdp()
    }

    fn set_share_rdp(&self, _enable: bool) {
        set_share_rdp(_enable);
    }

    fn is_installed_lower_version(&self) -> bool {
        is_installed_lower_version()
    }

    fn closing(&mut self, x: i32, y: i32, w: i32, h: i32) {
        crate::server::input_service::fix_key_down_timeout_at_exit();
        LocalConfig::set_size(x, y, w, h);
    }

    fn get_size(&mut self) -> Value {
        let s = LocalConfig::get_size();
        let mut v = Vec::new();
        v.push(s.0);
        v.push(s.1);
        v.push(s.2);
        v.push(s.3);
        Value::from_iter(v)
    }

    fn get_mouse_time(&self) -> f64 {
        get_mouse_time()
    }

    fn check_mouse_time(&self) {
        check_mouse_time()
    }

    fn get_connect_status(&mut self) -> Value {
        let mut v = Value::array(0);
        let x = get_connect_status();
        v.push(x.status_num);
        v.push(x.key_confirmed);
        v.push(x.id);
        v
    }

    #[inline]
    fn get_peer_value(id: String, p: PeerConfig) -> Value {
        let values = vec![
            id,
            p.info.username.clone(),
            p.info.hostname.clone(),
            p.info.platform.clone(),
            p.options.get("alias").unwrap_or(&"".to_owned()).to_owned(),
        ];
        Value::from_iter(values)
    }

    fn get_peer(&self, id: String) -> Value {
        let c = get_peer(id.clone());
        Self::get_peer_value(id, c)
    }

    fn get_fav(&self) -> Value {
        Value::from_iter(get_fav())
    }

    fn store_fav(&self, fav: Value) {
        let mut tmp = vec![];
        fav.values().for_each(|v| {
            if let Some(v) = v.as_string() {
                if !v.is_empty() {
                    tmp.push(v);
                }
            }
        });
        store_fav(tmp);
    }

    fn get_recent_sessions(&mut self) -> Value {
        // to-do: limit number of recent sessions, and remove old peer file
        let peers: Vec<Value> = PeerConfig::peers(None)
            .drain(..)
            .map(|p| Self::get_peer_value(p.0, p.2))
            .collect();
        Value::from_iter(peers)
    }

    fn get_icon(&mut self) -> String {
        get_icon()
    }

    fn remove_peer(&mut self, id: String) {
        PeerConfig::remove(&id);
    }

    fn remove_discovered(&mut self, id: String) {
        remove_discovered(id);
    }

    fn send_wol(&mut self, id: String) {
        crate::lan::send_wol(id)
    }

    fn new_remote(&mut self, id: String, remote_type: String, force_relay: bool) {
        new_remote(id, remote_type, force_relay)
    }

    fn check_access_blocking(&mut self, rustdesk_id: String) -> String {
        use hbb_common::config::LocalConfig;
        let token = LocalConfig::get_option("access_token");
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(800))
            .build()
        {
            Ok(c) => c,
            Err(_) => return "".to_owned(), // failopen
        };
        let mut builder = client
            .post("http://192.168.1.16:3000/api/check-access")
            .json(&serde_json::json!({ "rustdesk_id": rustdesk_id }));
        if !token.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", token));
        }
        match builder.send() {
            Ok(resp) => match resp.json::<serde_json::Value>() {
                Ok(v) => {
                    if v["allowed"].as_bool().unwrap_or(true) {
                        return "".to_owned();
                    }
                    match v["reason"].as_str().unwrap_or("no_permission") {
                        "login_required" => "Bạn cần đăng nhập để kết nối máy này".to_owned(),
                        _ => "Bạn không có quyền truy cập máy này".to_owned(),
                    }
                }
                Err(_) => "".to_owned(), // failopen
            },
            Err(_) => "".to_owned(), // server offline → failopen
        }
    }

    fn is_process_trusted(&mut self, _prompt: bool) -> bool {
        is_process_trusted(_prompt)
    }

    fn is_can_screen_recording(&mut self, _prompt: bool) -> bool {
        is_can_screen_recording(_prompt)
    }

    fn is_installed_daemon(&mut self, _prompt: bool) -> bool {
        is_installed_daemon(_prompt)
    }

    fn get_error(&mut self) -> String {
        get_error()
    }

    fn is_login_wayland(&mut self) -> bool {
        is_login_wayland()
    }

    fn current_is_wayland(&mut self) -> bool {
        current_is_wayland()
    }

    fn get_software_update_url(&self) -> String {
        crate::SOFTWARE_UPDATE_URL.lock().unwrap().clone()
    }

    fn get_new_version(&self) -> String {
        get_new_version()
    }

    fn get_version(&self) -> String {
        get_version()
    }

    fn get_fingerprint(&self) -> String {
        get_fingerprint()
    }

    fn get_app_name(&self) -> String {
        get_app_name()
    }

    fn get_software_ext(&self) -> String {
        #[cfg(windows)]
        let p = "exe";
        #[cfg(target_os = "macos")]
        let p = "dmg";
        #[cfg(target_os = "linux")]
        let p = "deb";
        p.to_owned()
    }

    fn get_software_store_path(&self) -> String {
        let mut p = std::env::temp_dir();
        let name = crate::SOFTWARE_UPDATE_URL
            .lock()
            .unwrap()
            .split("/")
            .last()
            .map(|x| x.to_owned())
            .unwrap_or(crate::get_app_name());
        p.push(name);
        format!("{}.{}", p.to_string_lossy(), self.get_software_ext())
    }

    fn create_shortcut(&self, _id: String) {
        #[cfg(windows)]
        create_shortcut(_id)
    }

    fn discover(&self) {
        std::thread::spawn(move || {
            allow_err!(crate::lan::discover());
        });
    }

    fn get_lan_peers(&self) -> String {
        // let peers = get_lan_peers()
        //     .into_iter()
        //     .map(|mut peer| {
        //         (
        //             peer.remove("id").unwrap_or_default(),
        //             peer.remove("username").unwrap_or_default(),
        //             peer.remove("hostname").unwrap_or_default(),
        //             peer.remove("platform").unwrap_or_default(),
        //         )
        //     })
        //     .collect::<Vec<(String, String, String, String)>>();
        serde_json::to_string(&get_lan_peers()).unwrap_or_default()
    }

    fn get_uuid(&self) -> String {
        get_uuid()
    }

    fn open_url(&self, url: String) {
        #[cfg(windows)]
        let p = "explorer";
        #[cfg(target_os = "macos")]
        let p = "open";
        #[cfg(target_os = "linux")]
        let p = if std::path::Path::new("/usr/bin/firefox").exists() {
            "firefox"
        } else {
            "xdg-open"
        };
        allow_err!(std::process::Command::new(p).arg(url).spawn());
    }

    fn change_id(&self, id: String) {
        reset_async_job_status();
        let old_id = self.get_id();
        change_id_shared(id, old_id);
    }

    fn http_request(&self, url: String, method: String, body: Option<String>, header: String) {
        http_request(url, method, body, header)
    }

    fn post_request(&self, url: String, body: String, header: String) {
        post_request(url, body, header)
    }

    fn is_ok_change_id(&self) -> bool {
        hbb_common::machine_uid::get().is_ok()
    }

    fn get_async_job_status(&self) -> String {
        get_async_job_status()
    }

    fn get_http_status(&self, url: String) -> Option<String> {
        get_async_http_status(url)
    }

    fn t(&self, name: String) -> String {
        crate::client::translate(name)
    }

    fn is_xfce(&self) -> bool {
        crate::platform::is_xfce()
    }

    fn get_api_server(&self) -> String {
        get_api_server()
    }

    fn has_hwcodec(&self) -> bool {
        has_hwcodec()
    }

    fn has_vram(&self) -> bool {
        has_vram()
    }

    fn get_langs(&self) -> String {
        get_langs()
    }

    fn video_save_directory(&self, root: bool) -> String {
        video_save_directory(root)
    }

    fn handle_relay_id(&self, id: String) -> String {
        handle_relay_id(&id).to_owned()
    }

    fn get_login_device_info(&self) -> String {
        get_login_device_info_json()
    }

    fn support_remove_wallpaper(&self) -> bool {
        support_remove_wallpaper()
    }

    fn has_valid_2fa(&self) -> bool {
        has_valid_2fa()
    }

    fn generate2fa(&self) -> String {
        generate2fa()
    }

    pub fn verify2fa(&self, code: String) -> bool {
        verify2fa(code)
    }

    fn verify_login(&self, raw: String, id: String) -> bool {
        crate::verify_login(&raw, &id)
    }

    fn generate_2fa_img_src(&self, data: String) -> String {
        let v = qrcode_generator::to_png_to_vec(data, qrcode_generator::QrCodeEcc::Low, 128)
            .unwrap_or_default();
        let s = hbb_common::sodiumoxide::base64::encode(
            v,
            hbb_common::sodiumoxide::base64::Variant::Original,
        );
        format!("data:image/png;base64,{s}")
    }

    pub fn check_hwcodec(&self) {
        check_hwcodec()
    }

    fn is_option_fixed(&self, key: String) -> bool {
        crate::ui_interface::is_option_fixed(&key)
    }

    fn get_builtin_option(&self, key: String) -> String {
        crate::ui_interface::get_builtin_option(&key)
    }

    fn is_remote_modify_enabled_by_control_permissions(&self) -> String {
        match crate::ui_interface::is_remote_modify_enabled_by_control_permissions() {
            Some(true) => "true",
            Some(false) => "false",
            None => "",
        }
        .to_string()
    }
}

impl sciter::EventHandler for UI {
    sciter::dispatch_script_call! {
        fn t(String);
        fn get_api_server();
        fn is_xfce();
        fn using_public_server();
        fn is_custom_client();
        fn is_outgoing_only();
        fn is_incoming_only();
        fn is_disable_settings();
        fn is_disable_account();
        fn is_disable_installation();
        fn is_disable_ab();
        fn get_id();
        fn temporary_password();
        fn update_temporary_password();
        fn set_permanent_password(String);
        fn is_local_permanent_password_set();
        fn is_permanent_password_set();
        fn get_remote_id();
        fn set_remote_id(String);
        fn closing(i32, i32, i32, i32);
        fn get_size();
        fn new_remote(String, String, bool);
        fn check_access_blocking(String);
        fn send_wol(String);
        fn remove_peer(String);
        fn remove_discovered(String);
        fn get_connect_status();
        fn get_mouse_time();
        fn check_mouse_time();
        fn get_recent_sessions();
        fn get_peer(String);
        fn get_fav();
        fn store_fav(Value);
        fn recent_sessions_updated();
        fn get_icon();
        fn install_me(String, String);
        fn is_installed();
        fn get_supported_privacy_mode_impls();
        fn is_root();
        fn is_release();
        fn set_socks(String, String, String);
        fn get_socks();
        fn is_share_rdp();
        fn set_share_rdp(bool);
        fn is_installed_lower_version();
        fn install_path();
        fn install_options();
        fn goto_install();
        fn is_process_trusted(bool);
        fn is_can_screen_recording(bool);
        fn is_installed_daemon(bool);
        fn get_error();
        fn is_login_wayland();
        fn current_is_wayland();
        fn get_options();
        fn get_option(String);
        fn get_local_option(String);
        fn set_local_option(String, String);
        fn get_peer_option(String, String);
        fn peer_has_password(String);
        fn forget_password(String);
        fn set_peer_option(String, String, String);
        fn get_license();
        fn test_if_valid_server(String, bool);
        fn get_sound_inputs();
        fn set_options(Value);
        fn set_option(String, String);
        fn get_software_update_url();
        fn get_new_version();
        fn get_version();
        fn get_fingerprint();
        fn update_me(String);
        fn show_run_without_install();
        fn run_without_install();
        fn get_app_name();
        fn get_software_store_path();
        fn get_software_ext();
        fn open_url(String);
        fn change_id(String);
        fn get_async_job_status();
        fn post_request(String, String, String);
        fn is_ok_change_id();
        fn create_shortcut(String);
        fn discover();
        fn get_lan_peers();
        fn get_uuid();
        fn has_hwcodec();
        fn has_vram();
        fn get_langs();
        fn video_save_directory(bool);
        fn handle_relay_id(String);
        fn get_login_device_info();
        fn support_remove_wallpaper();
        fn has_valid_2fa();
        fn generate2fa();
        fn generate_2fa_img_src(String);
        fn verify2fa(String);
        fn check_hwcodec();
        fn verify_login(String, String);
        fn is_option_fixed(String);
        fn get_builtin_option(String);
        fn is_remote_modify_enabled_by_control_permissions();
    }
}

impl sciter::host::HostHandler for UIHostHandler {
    fn on_graphics_critical_failure(&mut self) {
        log::error!("Critical rendering error: e.g. DirectX gfx driver error. Most probably bad gfx drivers.");
    }
}

#[cfg(not(target_os = "linux"))]
fn get_sound_inputs() -> Vec<String> {
    let mut out = Vec::new();
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    if let Ok(devices) = host.devices() {
        for device in devices {
            if device.default_input_config().is_err() {
                continue;
            }
            if let Ok(name) = device.name() {
                out.push(name);
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn get_sound_inputs() -> Vec<String> {
    crate::platform::linux::get_pa_sources()
        .drain(..)
        .map(|x| x.1)
        .collect()
}

// sacrifice some memory
pub fn value_crash_workaround(values: &[Value]) -> Arc<Vec<Value>> {
    let persist = Arc::new(values.to_vec());
    STUPID_VALUES.lock().unwrap().push(persist.clone());
    persist
}

pub fn get_icon() -> String {
    // 128x128
    #[cfg(target_os = "macos")]
    // 128x128 on 160x160 canvas, then shrink to 128, mac looks better with padding
    {
        "data:image/png;base64,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".into()
    }
    #[cfg(not(target_os = "macos"))] // 128x128 no padding
    {
        "data:image/png;base64,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".into()
    }
}

