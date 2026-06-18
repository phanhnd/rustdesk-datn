const http = require('http');
const fs = require('fs');
const path = require('path');
const url_module = require('url');
const crypto = require('crypto');
const querystring = require('querystring');
const { DatabaseSync } = require('node:sqlite');

const KEYCLOAK_URL  = 'http://192.168.1.16:8080';
const REALM         = 'rustdesk';
const CLIENT_ID     = 'rustdesk-client';
const CLIENT_SECRET = 'wzZwDnLFW02kkOS3gyCdKWNErENBaEEN';
const REDIRECT_URI  = 'http://192.168.1.16:3000/api/auth/callback';

// Admin credentials
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';
const adminSessions = new Set();

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
  CREATE TABLE IF NOT EXISTS machine_roles (
    role_name  TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    PRIMARY KEY (role_name, machine_id)
  );
  CREATE INDEX IF NOT EXISTS idx_machine_roles_machine ON machine_roles(machine_id);
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
  const insertRoleStmt = db.prepare(
    'INSERT OR IGNORE INTO machine_roles (role_name, machine_id) VALUES (?, ?)'
  );

  if (legacy && Array.isArray(legacy.machines)) {
    // Di trú từ data.json (bỏ field "tag")
    for (const m of legacy.machines) {
      insertMachineStmt.run(
        m.id || crypto.randomBytes(8).toString('hex'),
        m.alias || '',
        m.rustdesk_id || '',
        m.note || ''
      );
    }
    for (const [roleName, ids] of Object.entries(legacy.roles || {})) {
      for (const mid of ids) insertRoleStmt.run(roleName, mid);
    }
  } else {
    // Không có data.json cũ → seed demo machines
    const demo = [
      { id: 'demo-01', alias: 'Build Server', rustdesk_id: '', note: '' },
      { id: 'demo-02', alias: 'Marketing PC', rustdesk_id: '', note: '' },
      { id: 'demo-03', alias: 'K8s Node',     rustdesk_id: '', note: '' },
    ];
    for (const m of demo) insertMachineStmt.run(m.id, m.alias, m.rustdesk_id, m.note);
    insertRoleStmt.run('admin', 'demo-01');
    insertRoleStmt.run('admin', 'demo-02');
    insertRoleStmt.run('admin', 'demo-03');
    insertRoleStmt.run('viewer', 'demo-01');
  }
}

migrateFromJsonIfNeeded();

function attachRoles(machines) {
  const rows = db.prepare('SELECT role_name, machine_id FROM machine_roles').all();
  const rolesByMachine = {};
  for (const row of rows) {
    (rolesByMachine[row.machine_id] = rolesByMachine[row.machine_id] || []).push(row.role_name);
  }
  return machines.map(m => ({ ...m, roles: rolesByMachine[m.id] || [] }));
}

function getAllMachines() {
  const machines = db.prepare('SELECT id, alias, rustdesk_id, note FROM machines').all();
  return attachRoles(machines);
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
  db.prepare('DELETE FROM machine_roles WHERE machine_id = ?').run(id);
  db.prepare('DELETE FROM machines WHERE id = ?').run(id);
}

function setMachineRoles(machineId, roleNames) {
  db.prepare('DELETE FROM machine_roles WHERE machine_id = ?').run(machineId);
  const stmt = db.prepare('INSERT OR IGNORE INTO machine_roles (role_name, machine_id) VALUES (?, ?)');
  for (const roleName of (roleNames || [])) stmt.run(roleName, machineId);
}

function getRolesMap() {
  const rows = db.prepare('SELECT role_name, machine_id FROM machine_roles').all();
  const map = {};
  for (const row of rows) {
    (map[row.role_name] = map[row.role_name] || []).push(row.machine_id);
  }
  return map;
}

function setRoleMachineIds(roleName, ids) {
  db.prepare('DELETE FROM machine_roles WHERE role_name = ?').run(roleName);
  const stmt = db.prepare('INSERT OR IGNORE INTO machine_roles (role_name, machine_id) VALUES (?, ?)');
  for (const id of ids) {
    if (machineExists(id)) stmt.run(roleName, id);
  }
}

function deleteRoleMapping(roleName) {
  db.prepare('DELETE FROM machine_roles WHERE role_name = ?').run(roleName);
}

function getMachinesForRoles(roleNames) {
  if (!roleNames || !roleNames.length) return [];
  const placeholders = roleNames.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT m.id, m.alias, m.rustdesk_id, m.note
       FROM machines m
       JOIN machine_roles mr ON mr.machine_id = m.id
      WHERE mr.role_name IN (${placeholders})`
  ).all(...roleNames);
  return attachRoles(rows);
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

// Cache client UUID để tránh gọi KC nhiều lần
let cachedClientUuid = null;
async function getClientUuid() {
  if (cachedClientUuid) return cachedClientUuid;
  const r = await keycloakAdminGet(`/clients?clientId=${encodeURIComponent(CLIENT_ID)}`);
  const clients = JSON.parse(r.body);
  if (!Array.isArray(clients) || !clients.length) throw new Error('Client not found: ' + CLIENT_ID);
  cachedClientUuid = clients[0].id;
  return cachedClientUuid;
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

function getRolesFromPayload(payload) {
  const roles = [];
  if (payload.realm_access && Array.isArray(payload.realm_access.roles)) {
    roles.push(...payload.realm_access.roles);
  }
  if (payload.resource_access && payload.resource_access[CLIENT_ID]) {
    const clientRoles = payload.resource_access[CLIENT_ID].roles;
    if (Array.isArray(clientRoles)) roles.push(...clientRoles);
  }
  return roles;
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

function requireAdminAuth(req, res) {
  const cookies = parseCookies(req);
  if (!cookies.admin_token || !adminSessions.has(cookies.admin_token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
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

  // ── Admin login / logout ──────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/admin/login') {
    const raw = await readBody(req);
    let creds = {};
    try { creds = JSON.parse(raw); } catch (_) {}
    if (creds.username === ADMIN_USER && creds.password === ADMIN_PASS) {
      const token = crypto.randomBytes(24).toString('hex');
      adminSessions.add(token);
      res.writeHead(200, {
        'Set-Cookie': `admin_token=${token}; HttpOnly; Path=/`,
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      jsonResponse(res, 401, { error: 'Invalid credentials' });
    }
    return;
  }

  if (req.method === 'POST' && p === '/admin/logout') {
    const cookies = parseCookies(req);
    if (cookies.admin_token) adminSessions.delete(cookies.admin_token);
    res.writeHead(200, { 'Set-Cookie': 'admin_token=; Max-Age=0; Path=/', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Admin API (requires auth) ─────────────────────────────────────────────
  if (p.startsWith('/admin/api/')) {
    if (!requireAdminAuth(req, res)) return;
    const raw = await readBody(req);
    let body = {};
    try { if (raw) body = JSON.parse(raw); } catch (_) {}

    // ── Users ─────────────────────────────────────────────────────────────

    if (req.method === 'GET' && p === '/admin/api/users') {
      try {
        const usersRes = await keycloakAdminGet('/users?max=200');
        const users = JSON.parse(usersRes.body);
        const uuid = await getClientUuid();
        const withRoles = await Promise.all(users.map(async u => {
          try {
            const rolesRes = await keycloakAdminGet(`/users/${u.id}/role-mappings/clients/${uuid}`);
            const roles = JSON.parse(rolesRes.body).map(r => r.name);
            return { ...u, roles };
          } catch (_) {
            return { ...u, roles: [] };
          }
        }));
        jsonResponse(res, 200, withRoles);
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && p === '/admin/api/users') {
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

    const userRolesMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/roles$/);
    if (userRolesMatch) {
      const userId = userRolesMatch[1];
      try {
        const uuid = await getClientUuid();
        if (req.method === 'POST') {
          await keycloakAdminRequest('POST', `/users/${userId}/role-mappings/clients/${uuid}`, body.roles);
          jsonResponse(res, 200, { ok: true });
        } else if (req.method === 'DELETE') {
          await keycloakAdminRequest('DELETE', `/users/${userId}/role-mappings/clients/${uuid}`, body.roles);
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

    // ── Keycloak roles CRUD ───────────────────────────────────────────────

    if (p === '/admin/api/keycloak-roles') {
      if (req.method === 'GET') {
        try {
          const uuid = await getClientUuid();
          const r = await keycloakAdminGet(`/clients/${uuid}/roles`);
          const parsed = JSON.parse(r.body);
          if (!Array.isArray(parsed)) { jsonResponse(res, 200, []); return; }
          const roles = parsed.map(r => ({ id: r.id, name: r.name }));
          jsonResponse(res, 200, roles);
        } catch (err) {
          jsonResponse(res, 500, { error: err.message });
        }
        return;
      }
      if (req.method === 'POST') {
        const name = body.name && body.name.trim();
        if (!name) { jsonResponse(res, 400, { error: 'Thiếu name' }); return; }
        try {
          const uuid = await getClientUuid();
          const r = await keycloakAdminRequest('POST', `/clients/${uuid}/roles`, { name });
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
    }

    const kcRoleDelMatch = p.match(/^\/admin\/api\/keycloak-roles\/([^/]+)$/);
    if (kcRoleDelMatch && req.method === 'DELETE') {
      const roleName = decodeURIComponent(kcRoleDelMatch[1]);
      try {
        const uuid = await getClientUuid();
        const delRes = await keycloakAdminRequest('DELETE', `/clients/${uuid}/roles/${encodeURIComponent(roleName)}`, null);
        if (delRes.status === 204 || delRes.status === 200) {
          deleteRoleMapping(roleName);
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, delRes.status, { error: delRes.body });
        }
      } catch (err) {
        jsonResponse(res, 500, { error: err.message });
      }
      return;
    }

    // ── Roles (enriched: name + machine_ids + machines + users) ──────────

    if (req.method === 'GET' && p === '/admin/api/roles') {
      let kcRolesList = [];
      let kcError = null;
      let clientUuid = null;

      try {
        clientUuid = await getClientUuid();
        const kcRes = await keycloakAdminGet(`/clients/${clientUuid}/roles`);
        const parsed = JSON.parse(kcRes.body);
        kcRolesList = Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        kcError = err.message;
        // Fallback: dùng tên role từ local data
        kcRolesList = Object.keys(getRolesMap()).map(name => ({ name }));
      }

      const rolesMap = getRolesMap();
      const allMachinesById = new Map(getAllMachines().map(m => [m.id, m]));
      const roleDetails = await Promise.all(kcRolesList.map(async kcRole => {
        const machine_ids = rolesMap[kcRole.name] || [];
        const machines = machine_ids
          .map(id => allMachinesById.get(id))
          .filter(Boolean)
          .map(m => ({ id: m.id, alias: m.alias, rustdesk_id: m.rustdesk_id }));

        let users = [];
        if (!kcError && clientUuid) {
          try {
            const usersRes = await keycloakAdminGet(`/clients/${clientUuid}/roles/${encodeURIComponent(kcRole.name)}/users`);
            const p2 = JSON.parse(usersRes.body);
            if (Array.isArray(p2)) {
              users = p2.map(u => ({
                id:        u.id,
                username:  u.username,
                firstName: u.firstName || '',
                lastName:  u.lastName  || '',
                email:     u.email     || '',
              }));
            }
          } catch (_) {}
        }

        return { name: kcRole.name, machine_ids, machines, users };
      }));

      jsonResponse(res, 200, { roles: roleDetails, kcError });
      return;
    }

    if (req.method === 'PUT' && p === '/admin/api/roles') {
      // body: { roleName: [machineIds], ... }
      for (const [roleName, ids] of Object.entries(body)) {
        if (!Array.isArray(ids)) continue;
        setRoleMachineIds(roleName, ids);
      }
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ── Machines CRUD ─────────────────────────────────────────────────────

    if (req.method === 'GET' && p === '/admin/api/machines') {
      jsonResponse(res, 200, getAllMachines());
      return;
    }

    if (req.method === 'POST' && p === '/admin/api/machines') {
      const id = insertMachine({
        alias:       (body.alias       || '').trim(),
        rustdesk_id: (body.rustdesk_id || '').trim(),
        note:        (body.note        || '').trim(),
      });
      if (Array.isArray(body.roles)) setMachineRoles(id, body.roles);
      jsonResponse(res, 200, { ok: true, id });
      return;
    }

    const machineMatch = p.match(/^\/admin\/api\/machines\/([^/]+)$/);
    if (machineMatch) {
      const mid = decodeURIComponent(machineMatch[1]);

      if (req.method === 'PUT') {
        const updated = updateMachine(mid, {
          alias:       body.alias       !== undefined ? String(body.alias).trim()       : undefined,
          rustdesk_id: body.rustdesk_id !== undefined ? String(body.rustdesk_id).trim() : undefined,
          note:        body.note        !== undefined ? String(body.note).trim()        : undefined,
        });
        if (!updated) { jsonResponse(res, 404, { error: 'Machine not found' }); return; }
        if (Array.isArray(body.roles)) setMachineRoles(mid, body.roles);
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
    // Đã login → kiểm tra role
    const userRoles = getRolesFromPayload(payload);
    const allowedIds = getMachinesForRoles(userRoles).map(m => m.id);
    const allowed = allowedIds.includes(machine.id);
    console.log(`[check-access] rustdesk_id=${rustdesk_id} roles=${userRoles} allowed=${allowed}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed, reason: allowed ? null : 'no_permission' }));
    return;
  }

  if (req.method === 'POST' && p === '/api/address-books') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = decodeJwtPayload(token);
    const roles = getRolesFromPayload(payload);
    const machines = getMachinesForRoles(roles);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ machines }));
    return;
  }

  res.writeHead(404); res.end('Not found');
}).listen(3000, '0.0.0.0', () => {
  console.log('Gateway running at http://192.168.1.16:3000');
  console.log('Admin UI:         http://192.168.1.16:3000/admin');
});
