const http = require('http');
const fs = require('fs');
const path = require('path');
const url_module = require('url');
const crypto = require('crypto');
const querystring = require('querystring');
const { DatabaseSync } = require('node:sqlite');

const VM_HOST       = 'localhost:3000';
const KEYCLOAK_HOST = 'localhost:8080';
const KEYCLOAK_URL  = `http://${KEYCLOAK_HOST}`;
const REALM         = 'rustdesk';
const CLIENT_ID     = 'rustdesk-client';
const CLIENT_SECRET = 'wzZwDnLFW02kkOS3gyCdKWNErENBaEEN';
const REDIRECT_URI  = `http://${VM_HOST}/api/auth/callback`;

// Admin web UI — Keycloak SSO login, role "admin" required, 2FA enforced
// server-side via Keycloak Conditional OTP Form bound to this client's flow.
const ADMIN_CLIENT_ID      = 'rocky-admin';
const ADMIN_CLIENT_SECRET  = '272LGI6gmuvA7ppbMDDefHBoehhSvxEA';
const ADMIN_REDIRECT_URI   = `http://${VM_HOST}/admin/auth/callback`;
const ADMIN_ROLE           = 'admin';          // admin tối cao
const ADMIN_ROLE_USERS     = 'manage_users';    // quản trị người dùng + phân quyền (gán group)
const ADMIN_ROLE_MACHINES  = 'manage_machines'; // quản trị máy trạm + gán máy↔group
const ADMIN_TIER_ROLES     = [ADMIN_ROLE, ADMIN_ROLE_USERS, ADMIN_ROLE_MACHINES];
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map(); // session token -> { sub, username, roles, expiresAt }
const adminLoginStates = new Map(); // CSRF state -> expiresAt, short-lived during redirect round-trip

// Keycloak service account token cache
let serviceToken = null;
let serviceTokenExpiry = 0;

// ── Database (SQLite via node:sqlite) ───────────────────────────────────────

const DATA_DIR  = path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'rocky.db');
const JSON_FILE = path.join(__dirname, 'data.json'); // chỉ dùng để migrate 1 lần

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id          TEXT PRIMARY KEY,
    alias       TEXT NOT NULL DEFAULT '',
    rustdesk_id TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS machine_groups (
    group_name TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    PRIMARY KEY (group_name, machine_id)
  );
  CREATE INDEX IF NOT EXISTS idx_machine_groups_machine ON machine_groups(machine_id);
`);

function migrateFromJsonIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM machines').get().n;
  if (count > 0) return;

  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  } catch (_) {
    legacy = null;
  }

  const insertMachineStmt = db.prepare(
    'INSERT INTO machines (id, alias, rustdesk_id, note) VALUES (?, ?, ?, ?)'
  );
  const insertGroupStmt = db.prepare(
    'INSERT OR IGNORE INTO machine_groups (group_name, machine_id) VALUES (?, ?)'
  );

  if (legacy && Array.isArray(legacy.machines)) {
    // Di trú máy từ data.json (bỏ field "tag"); không di trú "roles" cũ —
    // role Keycloak cũ (admin/viewer/guest) không tương ứng Group nào.
    for (const m of legacy.machines) {
      insertMachineStmt.run(
        m.id || crypto.randomBytes(8).toString('hex'),
        m.alias || '',
        m.rustdesk_id || '',
        m.note || ''
      );
    }
  } else {
    // Không có data.json cũ → seed demo machines + 1 group demo
    const demo = [
      { id: 'demo-01', alias: 'Build Server', rustdesk_id: '', note: '' },
      { id: 'demo-02', alias: 'Marketing PC', rustdesk_id: '', note: '' },
      { id: 'demo-03', alias: 'K8s Node',     rustdesk_id: '', note: '' },
    ];
    for (const m of demo) insertMachineStmt.run(m.id, m.alias, m.rustdesk_id, m.note);
    insertGroupStmt.run('demo-group', 'demo-01');
    insertGroupStmt.run('demo-group', 'demo-02');
    insertGroupStmt.run('demo-group', 'demo-03');
  }
}

migrateFromJsonIfNeeded();

function attachGroups(machines) {
  const rows = db.prepare('SELECT group_name, machine_id FROM machine_groups').all();
  const groupsByMachine = {};
  for (const row of rows) {
    (groupsByMachine[row.machine_id] = groupsByMachine[row.machine_id] || []).push(row.group_name);
  }
  return machines.map(m => ({ ...m, groups: groupsByMachine[m.id] || [] }));
}

function getAllMachines() {
  const machines = db.prepare('SELECT id, alias, rustdesk_id, note FROM machines').all();
  return attachGroups(machines);
}

function getMachineById(id) {
  return db.prepare('SELECT id, alias, rustdesk_id, note FROM machines WHERE id = ?').get(id) || null;
}

function getMachineByRustdeskId(rustdeskId) {
  return db.prepare('SELECT id, alias, rustdesk_id, note FROM machines WHERE rustdesk_id = ?').get(rustdeskId) || null;
}

function machineExists(id) {
  return !!db.prepare('SELECT 1 FROM machines WHERE id = ?').get(id);
}

function insertMachine({ alias, rustdesk_id, note }) {
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO machines (id, alias, rustdesk_id, note) VALUES (?, ?, ?, ?)')
    .run(id, alias || '', rustdesk_id || '', note || '');
  return id;
}

function updateMachine(id, { alias, rustdesk_id, note }) {
  const existing = getMachineById(id);
  if (!existing) return false;
  db.prepare('UPDATE machines SET alias = ?, rustdesk_id = ?, note = ? WHERE id = ?').run(
    alias       !== undefined ? alias       : existing.alias,
    rustdesk_id !== undefined ? rustdesk_id : existing.rustdesk_id,
    note        !== undefined ? note        : existing.note,
    id
  );
  return true;
}

function deleteMachine(id) {
  db.prepare('DELETE FROM machine_groups WHERE machine_id = ?').run(id);
  db.prepare('DELETE FROM machines WHERE id = ?').run(id);
}

function setMachineGroups(machineId, groupNames) {
  db.prepare('DELETE FROM machine_groups WHERE machine_id = ?').run(machineId);
  const stmt = db.prepare('INSERT OR IGNORE INTO machine_groups (group_name, machine_id) VALUES (?, ?)');
  for (const groupName of (groupNames || [])) stmt.run(groupName, machineId);
}

function getGroupsMap() {
  const rows = db.prepare('SELECT group_name, machine_id FROM machine_groups').all();
  const map = {};
  for (const row of rows) {
    (map[row.group_name] = map[row.group_name] || []).push(row.machine_id);
  }
  return map;
}

function setGroupMachineIds(groupName, ids) {
  db.prepare('DELETE FROM machine_groups WHERE group_name = ?').run(groupName);
  const stmt = db.prepare('INSERT OR IGNORE INTO machine_groups (group_name, machine_id) VALUES (?, ?)');
  for (const id of ids) {
    if (machineExists(id)) stmt.run(groupName, id);
  }
}

function deleteGroupMapping(groupName) {
  db.prepare('DELETE FROM machine_groups WHERE group_name = ?').run(groupName);
}

function getMachinesForGroups(groupNames) {
  if (!groupNames || !groupNames.length) return [];
  const placeholders = groupNames.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT m.id, m.alias, m.rustdesk_id, m.note
       FROM machines m
       JOIN machine_groups mg ON mg.machine_id = m.id
      WHERE mg.group_name IN (${placeholders})`
  ).all(...groupNames);
  return attachGroups(rows);
}

const sessions = new Map();

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function httpRequest(urlStr, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url_module.parse(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? require('https') : require('http');
    const bodyBuf = body ? Buffer.from(body) : null;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.path,
      method,
      headers: {
        ...headers,
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
      },
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function httpPost(urlStr, body) {
  return httpRequest(urlStr, 'POST', body, { 'Content-Type': 'application/x-www-form-urlencoded' });
}

async function getServiceToken() {
  if (serviceToken && Date.now() < serviceTokenExpiry) return serviceToken;
  const body = querystring.stringify({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const tokenUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
  const result = await httpPost(tokenUrl, body);
  const data = JSON.parse(result.body);
  if (!data.access_token) throw new Error('Failed to get service token: ' + (data.error_description || result.body));
  serviceToken = data.access_token;
  serviceTokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
  return serviceToken;
}

// Cache UUID theo clientId để tránh gọi KC nhiều lần (rustdesk-client cho group-machine
// access cũ, rocky-admin cho gán role admin-tier)
const cachedClientUuids = new Map();
async function getClientUuid(clientId = CLIENT_ID) {
  if (cachedClientUuids.has(clientId)) return cachedClientUuids.get(clientId);
  const r = await keycloakAdminGet(`/clients?clientId=${encodeURIComponent(clientId)}`);
  const clients = JSON.parse(r.body);
  if (!Array.isArray(clients) || !clients.length) throw new Error('Client not found: ' + clientId);
  cachedClientUuids.set(clientId, clients[0].id);
  return clients[0].id;
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return {};
  }
}

function getRolesFromPayload(payload, clientId = CLIENT_ID) {
  const roles = [];
  if (payload.realm_access && Array.isArray(payload.realm_access.roles)) {
    roles.push(...payload.realm_access.roles);
  }
  if (payload.resource_access && payload.resource_access[clientId]) {
    const clientRoles = payload.resource_access[clientId].roles;
    if (Array.isArray(clientRoles)) roles.push(...clientRoles);
  }
  return roles;
}

// Đọc Group Keycloak từ claim "groups" trong JWT (cần protocol mapper "Group
// Membership" gắn vào rustdesk-client, xem docs/address-book.md). Keycloak có thể vẫn
// trả full path (vd. "/engineering") dù đã tắt "Full group path" ở mapper — strip 1
// dấu "/" đầu để chuẩn hoá; chỉ hỗ trợ group flat top-level cho v1, không xử lý path lồng.
function getGroupsFromPayload(payload) {
  const raw = Array.isArray(payload.groups) ? payload.groups : [];
  return raw
    .map(g => (typeof g === 'string' ? g.replace(/^\/+/, '') : ''))
    .filter(Boolean);
}

async function introspectToken(token, clientId, clientSecret) {
  const body = querystring.stringify({ token, client_id: clientId, client_secret: clientSecret });
  const introspectUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token/introspect`;
  const result = await httpPost(introspectUrl, body);
  return JSON.parse(result.body);
}

function buildKeycloakLogoutUrl(postLogoutPath) {
  const params = new URLSearchParams({
    client_id: ADMIN_CLIENT_ID,
    post_logout_redirect_uri: `http://${VM_HOST}${postLogoutPath}`,
  });
  return `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout?${params}`;
}

function renderAdminAuthError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h2>${message}</h2>
    <p><a href="/admin/login">Quay lại đăng nhập</a></p>
    </body></html>`);
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// allowedRoles=null: chỉ cần đăng nhập admin (1 trong 3 tier). allowedRoles=[...]: cần
// đúng 1 trong các tier đó — admin tối cao (ADMIN_ROLE) luôn được bypass mọi tier-check.
function requireAdminAuth(req, res, allowedRoles = null) {
  const cookies = parseCookies(req);
  const session = cookies.admin_session ? adminSessions.get(cookies.admin_session) : null;
  if (!session || Date.now() > session.expiresAt) {
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return false;
  }
  if (allowedRoles && !session.roles.includes(ADMIN_ROLE) &&
      !allowedRoles.some(r => session.roles.includes(r))) {
    jsonResponse(res, 403, { error: 'Forbidden: insufficient admin tier' });
    return false;
  }
  return true;
}

// Chỉ admin tối cao — dùng cho tạo/xoá Group và gán role admin-tier cho user khác.
function requireSuperAdmin(req, res) {
  const cookies = parseCookies(req);
  const session = cookies.admin_session ? adminSessions.get(cookies.admin_session) : null;
  if (!session || Date.now() > session.expiresAt) {
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return false;
  }
  if (!session.roles.includes(ADMIN_ROLE)) {
    jsonResponse(res, 403, { error: 'Forbidden: super admin required' });
    return false;
  }
  return true;
}

async function keycloakAdminGet(path) {
  const token = await getServiceToken();
  return httpRequest(
    `${KEYCLOAK_URL}/admin/realms/${REALM}${path}`,
    'GET', null,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
}

async function keycloakAdminRequest(method, path, body) {
  const token = await getServiceToken();
  const bodyStr = body ? JSON.stringify(body) : null;
  return httpRequest(
    `${KEYCLOAK_URL}/admin/realms/${REALM}${path}`,
    method, bodyStr,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
}

// Keycloak Groups là realm-level (không cần clientUuid như client-role trước đây).
async function listGroups() {
  const r = await keycloakAdminGet('/groups');
  let parsed;
  try { parsed = JSON.parse(r.body); } catch (_) { parsed = null; }
  return Array.isArray(parsed) ? parsed.map(g => ({ id: g.id, name: g.name })) : [];
}

async function createGroup(name) {
  return keycloakAdminRequest('POST', '/groups', { name });
}

async function deleteGroupById(groupId) {
  return keycloakAdminRequest('DELETE', `/groups/${groupId}`, null);
}

async function getGroupMembers(groupId) {
  const r = await keycloakAdminGet(`/groups/${groupId}/members`);
  let parsed;
  try { parsed = JSON.parse(r.body); } catch (_) { parsed = null; }
  return Array.isArray(parsed) ? parsed : [];
}

async function addUserToGroup(userId, groupId) {
  return keycloakAdminRequest('PUT', `/users/${userId}/groups/${groupId}`, null);
}

async function removeUserFromGroup(userId, groupId) {
  return keycloakAdminRequest('DELETE', `/users/${userId}/groups/${groupId}`, null);
}

http.createServer(async (req, res) => {
  const parsed = url_module.parse(req.url, true);
  const p = parsed.pathname;
  console.log(`[${new Date().toISOString()}] ${req.method} ${p}`);

  // ── Serve admin HTML ──────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/admin') {
    const file = path.join(__dirname, 'public', 'admin.html');
    try {
      const html = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (_) {
      res.writeHead(404); res.end('admin.html not found');
    }
    return;
  }

  // ── Admin login / logout (Keycloak SSO, role "admin" required) ────────────
  if (req.method === 'GET' && p === '/admin/login') {
    const state = crypto.randomBytes(16).toString('hex');
    adminLoginStates.set(state, Date.now() + 5 * 60 * 1000);
    const params = new URLSearchParams({
      client_id: ADMIN_CLIENT_ID,
      redirect_uri: ADMIN_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      state,
      prompt: 'login',
    });
    res.writeHead(302, { 'Location': `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth?${params}` });
    res.end();
    return;
  }

  if (req.method === 'GET' && p === '/admin/auth/callback') {
    const { code, state } = parsed.query;
    const stateExpiry = state ? adminLoginStates.get(state) : null;
    console.log('[admin/auth/callback DEBUG]', {
      receivedState: state,
      knownStates: [...adminLoginStates.keys()],
      stateExpiry,
      now: Date.now(),
      hasCode: !!code,
    });
    if (state) adminLoginStates.delete(state);
    if (!code || !state || !stateExpiry || Date.now() > stateExpiry) {
      renderAdminAuthError(res, 400, 'Đăng nhập thất bại: state không hợp lệ hoặc đã hết hạn.');
      return;
    }
    try {
      const tokenBody = querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ADMIN_REDIRECT_URI,
        client_id: ADMIN_CLIENT_ID,
        client_secret: ADMIN_CLIENT_SECRET,
      });
      const tokenUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
      const tokenResult = await httpPost(tokenUrl, tokenBody);
      const tokenData = JSON.parse(tokenResult.body);
      console.log('[admin/auth/callback DEBUG] token exchange', { status: tokenResult.status, body: tokenResult.body });
      if (!tokenData.access_token) {
        renderAdminAuthError(res, 400, 'Đăng nhập thất bại.');
        return;
      }

      const introspection = await introspectToken(tokenData.access_token, ADMIN_CLIENT_ID, ADMIN_CLIENT_SECRET);
      const roles = getRolesFromPayload(introspection, ADMIN_CLIENT_ID);
      // Cho vào admin UI nếu có ÍT NHẤT 1 trong 3 role admin-tier (admin tối cao,
      // quản trị người dùng, quản trị máy trạm) — không chỉ riêng admin tối cao.
      if (!introspection.active || !roles.some(r => ADMIN_TIER_ROLES.includes(r))) {
        renderAdminAuthError(res, 403, 'Tài khoản không có quyền quản trị.');
        return;
      }

      const sessionToken = crypto.randomBytes(24).toString('hex');
      adminSessions.set(sessionToken, {
        sub: introspection.sub,
        username: introspection.preferred_username || introspection.username || '',
        roles,
        expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
      });
      res.writeHead(302, {
        'Set-Cookie': `admin_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
        'Location': '/admin',
      });
      res.end();
    } catch (err) {
      console.error('[admin/auth/callback] lỗi đăng nhập:', err);
      renderAdminAuthError(res, 500, 'Đăng nhập thất bại do lỗi hệ thống.');
    }
    return;
  }

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

  // ── Admin API (mỗi route tự kiểm tra tier qua requireAdminAuth/requireSuperAdmin) ──
  if (p.startsWith('/admin/api/')) {
    const raw = await readBody(req);
    let body = {};
    try { if (raw) body = JSON.parse(raw); } catch (_) {}

    // ── Users ─────────────────────────────────────────────────────────────

    if (req.method === 'GET' && p === '/admin/api/users') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_USERS])) return;
      try {
        const usersRes = await keycloakAdminGet('/users?max=200');
        const users = JSON.parse(usersRes.body);
        const adminUuid = await getClientUuid(ADMIN_CLIENT_ID);
        const enriched = await Promise.all(users.map(async u => {
          let groups = [];
          let adminRoles = [];
          try {
            const groupsRes = await keycloakAdminGet(`/users/${u.id}/groups`);
            const gp = JSON.parse(groupsRes.body);
            if (Array.isArray(gp)) groups = gp.map(g => g.name);
          } catch (_) {}
          try {
            const rolesRes = await keycloakAdminGet(`/users/${u.id}/role-mappings/clients/${adminUuid}`);
            const rp = JSON.parse(rolesRes.body);
            if (Array.isArray(rp)) adminRoles = rp.map(r => r.name);
          } catch (_) {}
          return { ...u, groups, adminRoles };
        }));
        jsonResponse(res, 200, enriched);
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && p === '/admin/api/users') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_USERS])) return;
      const { username, email, firstName, lastName, password } = body;
      if (!username || !password) {
        jsonResponse(res, 400, { error: 'username và password là bắt buộc' });
        return;
      }
      try {
        const r = await keycloakAdminRequest('POST', '/users', {
          username,
          email:       email     || '',
          firstName:   firstName || '',
          lastName:    lastName  || '',
          enabled:     true,
          credentials: [{ type: 'password', value: password, temporary: false }],
        });
        if (r.status === 201) {
          const newId = r.headers && r.headers.location
            ? r.headers.location.split('/').pop()
            : null;
          jsonResponse(res, 200, { ok: true, id: newId });
        } else {
          let errMsg = r.body;
          try { const e = JSON.parse(r.body); errMsg = e.errorMessage || e.error || r.body; } catch (_) {}
          jsonResponse(res, r.status, { error: errMsg });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    // Gán/gỡ user khỏi Group (machine-access) — thay cho route role cũ
    const userGroupsMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/groups$/);
    if (userGroupsMatch) {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_USERS])) return;
      const userId = userGroupsMatch[1];
      const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
      try {
        if (req.method === 'POST') {
          await Promise.all(groupIds.map(gid => addUserToGroup(userId, gid)));
          jsonResponse(res, 200, { ok: true });
        } else if (req.method === 'DELETE') {
          await Promise.all(groupIds.map(gid => removeUserFromGroup(userId, gid)));
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, 405, { error: 'Method not allowed' });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    // Gán/gỡ role admin-tier (admin/manage_users/manage_machines) trên rocky-admin —
    // chỉ admin tối cao, để tránh leo thang quyền.
    const userAdminRolesMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/admin-roles$/);
    if (userAdminRolesMatch) {
      if (!requireSuperAdmin(req, res)) return;
      const userId = userAdminRolesMatch[1];
      const names = Array.isArray(body.roles) ? body.roles : [];
      try {
        const uuid = await getClientUuid(ADMIN_CLIENT_ID);
        const allRolesRes = await keycloakAdminGet(`/clients/${uuid}/roles`);
        const allRoles = JSON.parse(allRolesRes.body);
        const roleObjs = (Array.isArray(allRoles) ? allRoles : [])
          .filter(r => names.includes(r.name))
          .map(r => ({ id: r.id, name: r.name }));
        if (req.method === 'POST') {
          await keycloakAdminRequest('POST', `/users/${userId}/role-mappings/clients/${uuid}`, roleObjs);
          jsonResponse(res, 200, { ok: true });
        } else if (req.method === 'DELETE') {
          await keycloakAdminRequest('DELETE', `/users/${userId}/role-mappings/clients/${uuid}`, roleObjs);
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, 405, { error: 'Method not allowed' });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    const userEnabledMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/enabled$/);
    if (userEnabledMatch && req.method === 'PUT') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_USERS])) return;
      const userId = userEnabledMatch[1];
      try {
        await keycloakAdminRequest('PUT', `/users/${userId}`, { enabled: body.enabled });
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    const userDeleteMatch = p.match(/^\/admin\/api\/users\/([^/]+)$/);
    if (userDeleteMatch && req.method === 'DELETE') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_USERS])) return;
      const userId = userDeleteMatch[1];
      try {
        const r = await keycloakAdminRequest('DELETE', `/users/${userId}`, null);
        if (r.status === 204 || r.status === 200) {
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, r.status, { error: r.body });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    // ── Groups (Keycloak Group thật + mapping máy↔group ở SQLite) ─────────

    if (req.method === 'GET' && p === '/admin/api/groups') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_USERS, ADMIN_ROLE_MACHINES])) return;
      let kcGroupsList = [];
      let kcError = null;
      try {
        kcGroupsList = await listGroups();
      } catch (err) {
        kcError = err.message;
        // Fallback: dùng tên group từ local mapping (không có id Keycloak)
        kcGroupsList = Object.keys(getGroupsMap()).map(name => ({ id: null, name }));
      }

      const groupsMap = getGroupsMap();
      const allMachinesById = new Map(getAllMachines().map(m => [m.id, m]));
      const groupDetails = await Promise.all(kcGroupsList.map(async kcGroup => {
        const machine_ids = groupsMap[kcGroup.name] || [];
        const machines = machine_ids
          .map(id => allMachinesById.get(id))
          .filter(Boolean)
          .map(m => ({ id: m.id, alias: m.alias, rustdesk_id: m.rustdesk_id }));

        let users = [];
        if (!kcError && kcGroup.id) {
          try {
            const members = await getGroupMembers(kcGroup.id);
            users = members.map(u => ({
              id:        u.id,
              username:  u.username,
              firstName: u.firstName || '',
              lastName:  u.lastName  || '',
              email:     u.email     || '',
            }));
          } catch (_) {}
        }

        return { id: kcGroup.id, name: kcGroup.name, machine_ids, machines, users };
      }));

      jsonResponse(res, 200, { groups: groupDetails, kcError });
      return;
    }

    if (req.method === 'POST' && p === '/admin/api/groups') {
      if (!requireSuperAdmin(req, res)) return;
      const name = body.name && body.name.trim();
      if (!name) { jsonResponse(res, 400, { error: 'Thiếu name' }); return; }
      try {
        const r = await createGroup(name);
        if (r.status === 201) {
          jsonResponse(res, 200, { ok: true });
        } else {
          let errMsg = r.body;
          try { const e = JSON.parse(r.body); errMsg = e.errorMessage || e.error || r.body; } catch (_) {}
          jsonResponse(res, r.status, { error: errMsg });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'PUT' && p === '/admin/api/groups') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_MACHINES])) return;
      // body: { groupName: [machineIds], ... }
      for (const [groupName, ids] of Object.entries(body)) {
        if (!Array.isArray(ids)) continue;
        setGroupMachineIds(groupName, ids);
      }
      jsonResponse(res, 200, { ok: true });
      return;
    }

    const groupDeleteMatch = p.match(/^\/admin\/api\/groups\/([^/]+)$/);
    if (groupDeleteMatch && req.method === 'DELETE') {
      if (!requireSuperAdmin(req, res)) return;
      const groupId = decodeURIComponent(groupDeleteMatch[1]);
      try {
        let groupName = null;
        try {
          const groups = await listGroups();
          const target = groups.find(g => g.id === groupId);
          if (target) groupName = target.name;
        } catch (_) {}
        const delRes = await deleteGroupById(groupId);
        if (delRes.status === 204 || delRes.status === 200) {
          if (groupName) deleteGroupMapping(groupName);
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, delRes.status, { error: delRes.body });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    // ── Machines CRUD ─────────────────────────────────────────────────────

    if (req.method === 'GET' && p === '/admin/api/machines') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_MACHINES])) return;
      jsonResponse(res, 200, getAllMachines());
      return;
    }

    if (req.method === 'POST' && p === '/admin/api/machines') {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_MACHINES])) return;
      const id = insertMachine({
        alias:       (body.alias       || '').trim(),
        rustdesk_id: (body.rustdesk_id || '').trim(),
        note:        (body.note        || '').trim(),
      });
      if (Array.isArray(body.groups)) setMachineGroups(id, body.groups);
      jsonResponse(res, 200, { ok: true, id });
      return;
    }

    const machineMatch = p.match(/^\/admin\/api\/machines\/([^/]+)$/);
    if (machineMatch) {
      if (!requireAdminAuth(req, res, [ADMIN_ROLE_MACHINES])) return;
      const mid = decodeURIComponent(machineMatch[1]);

      if (req.method === 'PUT') {
        const updated = updateMachine(mid, {
          alias:       body.alias       !== undefined ? String(body.alias).trim()       : undefined,
          rustdesk_id: body.rustdesk_id !== undefined ? String(body.rustdesk_id).trim() : undefined,
          note:        body.note        !== undefined ? String(body.note).trim()        : undefined,
        });
        if (!updated) { jsonResponse(res, 404, { error: 'Machine not found' }); return; }
        if (Array.isArray(body.groups)) setMachineGroups(mid, body.groups);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE') {
        deleteMachine(mid);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      jsonResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
    return;
  }

  // ── Keycloak auth endpoints ───────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/auth/logout') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token) {
      const body = querystring.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        token,
        token_type_hint: 'access_token',
      });
      const revokeUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/revoke`;
      try { await httpPost(revokeUrl, body); } catch (err) {
        console.error('Token revoke failed:', err.message);
      }
    }
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && p === '/api/auth/init') {
    const session_code = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      state: session_code,
      prompt: 'login',
    });
    const url = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth?${params}`;
    sessions.set(session_code, { pending: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url, session_code }));
    return;
  }

  if (req.method === 'GET' && p === '/api/auth/callback') {
    const { code, state } = parsed.query;
    if (!code || !state) { res.writeHead(400); res.end('Missing code or state'); return; }
    try {
      const body = querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
      const tokenUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
      const result = await httpPost(tokenUrl, body);
      const tokenData = JSON.parse(result.body);
      if (tokenData.access_token) {
        sessions.set(state, { access_token: tokenData.access_token, pending: false });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Login thành công, đóng tab này.</h2></body></html>');
      } else {
        sessions.set(state, { pending: false, error: tokenData.error_description || 'Token exchange failed' });
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Login thất bại.</h2></body></html>');
      }
    } catch (err) {
      sessions.set(state, { pending: false, error: err.message });
      res.writeHead(500); res.end('Token exchange error');
    }
    return;
  }

  if (req.method === 'POST' && p === '/api/auth/status') {
    const rawBody = await readBody(req);
    let session_code;
    try { session_code = JSON.parse(rawBody).session_code; } catch (_) {}
    const session = sessions.get(session_code);
    if (!session || session.pending) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pending: true }));
    } else {
      sessions.delete(session_code);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session.access_token
        ? { access_token: session.access_token }
        : { pending: false, error: session.error }));
    }
    return;
  }

  if (req.method === 'POST' && p === '/api/check-access') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const rawCheckBody = await readBody(req);
    let checkBody = {};
    try { if (rawCheckBody) checkBody = JSON.parse(rawCheckBody); } catch (_) {}
    const rustdesk_id = checkBody.rustdesk_id;
    if (!rustdesk_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing rustdesk_id' }));
      return;
    }
    const machine = getMachineByRustdeskId(rustdesk_id);
    // Máy không thuộc hệ thống → không chặn
    if (!machine) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: true }));
      return;
    }
    // Máy thuộc hệ thống → bắt buộc phải login
    const payload = token ? decodeJwtPayload(token) : null;
    if (!payload) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, reason: 'login_required' }));
      return;
    }
    // Đã login → kiểm tra group
    const userGroups = getGroupsFromPayload(payload);
    const allowedIds = getMachinesForGroups(userGroups).map(m => m.id);
    const allowed = allowedIds.includes(machine.id);
    console.log(`[check-access] rustdesk_id=${rustdesk_id} groups=${userGroups} allowed=${allowed}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed, reason: allowed ? null : 'no_permission' }));
    return;
  }

  if (req.method === 'POST' && p === '/api/address-books') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = decodeJwtPayload(token);
    const groups = getGroupsFromPayload(payload);
    const machines = getMachinesForGroups(groups);
    // DEBUG tạm — gỡ sau khi xác nhận claim "groups" + mapping SQLite đúng.
    console.log('[address-books DEBUG]', {
      rawGroupsClaim: payload.groups,
      normalizedGroups: groups,
      groupsMapInDb: getGroupsMap(),
      machinesReturned: machines.map(m => m.id),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ machines }));
    return;
  }

  res.writeHead(404); res.end('Not found');
}).listen(3000, '0.0.0.0', () => {
  console.log(`Gateway running at http://${VM_HOST}`);
  console.log(`Admin UI:         http://${VM_HOST}/admin`);
});
