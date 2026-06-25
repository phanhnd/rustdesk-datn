const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const querystring = require('querystring');
const cfg = require('../config');
const { httpPost, jsonResponse, renderAdminAuthError, parseCookies } = require('../utils');
const { adminSessions, adminLoginStates } = require('../utils');
const { introspectToken, getRolesFromPayload, buildKeycloakLogoutUrl } = require('../keycloak');

const ADMIN_TIER_ROLES = [cfg.ADMIN_ROLE, cfg.ADMIN_ROLE_USERS, cfg.ADMIN_ROLE_MACHINES];

async function handle(req, res, p) {
  // ── Serve admin HTML ────────────────────────────────────────────────────────
  if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) {
    const file = path.join(__dirname, '..', 'public', 'admin.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    } catch (_) {
      res.writeHead(404); res.end('admin.html not found');
    }
    return;
  }

  // ── Start SSO login ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/admin/login') {
    const state = crypto.randomBytes(16).toString('hex');
    adminLoginStates.set(state, Date.now() + 5 * 60 * 1000);
    const params = new URLSearchParams({
      client_id:     cfg.ADMIN_CLIENT_ID,
      redirect_uri:  cfg.ADMIN_REDIRECT_URI,
      response_type: 'code',
      scope:         'openid',
      state,
      prompt:        'login',
    });
    res.writeHead(302, { 'Location': `${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/auth?${params}` });
    res.end();
    return;
  }

  // ── OAuth2 callback ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/admin/auth/callback') {
    const qs    = new URLSearchParams(req.url.split('?')[1] || '');
    const code  = qs.get('code');
    const state = qs.get('state');
    const stateExpiry = state ? adminLoginStates.get(state) : null;
    console.log('[admin/auth/callback]', {
      hasCode: !!code, receivedState: state,
      knownStates: [...adminLoginStates.keys()], stateExpiry, now: Date.now(),
    });
    if (state) adminLoginStates.delete(state);
    if (!code || !state || !stateExpiry || Date.now() > stateExpiry) {
      renderAdminAuthError(res, 400, 'Đăng nhập thất bại: state không hợp lệ hoặc đã hết hạn.');
      return;
    }
    try {
      const tokenBody = querystring.stringify({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  cfg.ADMIN_REDIRECT_URI,
        client_id:     cfg.ADMIN_CLIENT_ID,
        client_secret: cfg.ADMIN_CLIENT_SECRET,
      });
      const tokenResult = await httpPost(`${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/token`, tokenBody);
      const tokenData = JSON.parse(tokenResult.body);
      if (!tokenData.access_token) { renderAdminAuthError(res, 400, 'Đăng nhập thất bại.'); return; }

      const introspection = await introspectToken(tokenData.access_token, cfg.ADMIN_CLIENT_ID, cfg.ADMIN_CLIENT_SECRET);
      const roles = getRolesFromPayload(introspection, cfg.ADMIN_CLIENT_ID);
      if (!introspection.active || !roles.some(r => ADMIN_TIER_ROLES.includes(r))) {
        renderAdminAuthError(res, 403, 'Tài khoản không có quyền quản trị.');
        return;
      }

      const sessionToken = crypto.randomBytes(24).toString('hex');
      adminSessions.set(sessionToken, {
        sub:      introspection.sub,
        username: introspection.preferred_username || introspection.username || '',
        roles,
        expiresAt: Date.now() + cfg.ADMIN_SESSION_TTL_MS,
      });
      res.writeHead(302, {
        'Set-Cookie': `admin_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(cfg.ADMIN_SESSION_TTL_MS / 1000)}`,
        'Location': '/admin',
      });
      res.end();
    } catch (err) {
      console.error('[admin/auth/callback] lỗi đăng nhập:', err);
      renderAdminAuthError(res, 500, 'Đăng nhập thất bại do lỗi hệ thống.');
    }
    return;
  }

  // ── Session check ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/admin/session') {
    const cookies = parseCookies(req);
    const session = cookies.admin_session ? adminSessions.get(cookies.admin_session) : null;
    if (!session || Date.now() > session.expiresAt) {
      if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
      jsonResponse(res, 200, { authenticated: false });
      return;
    }
    jsonResponse(res, 200, { authenticated: true, username: session.username, roles: session.roles });
    return;
  }

  // ── Logout ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/admin/logout') {
    const cookies = parseCookies(req);
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    const logoutUrl = buildKeycloakLogoutUrl('/admin');
    res.writeHead(200, {
      'Set-Cookie': 'admin_session=; Max-Age=0; Path=/',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true, logoutUrl }));
    return;
  }

  res.writeHead(404); res.end('Not found');
}

module.exports = { handle };
