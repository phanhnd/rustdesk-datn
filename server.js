const http = require('http');
const fs = require('fs');
const path = require('path');
const url_module = require('url');
const crypto = require('crypto');
const querystring = require('querystring');

const KEYCLOAK_URL  = 'http://localhost:8080';
const REALM         = 'rustdesk';
const CLIENT_ID     = 'rustdesk-client';
const CLIENT_SECRET = 'wzZwDnLFW02kkOS3gyCdKWNErENBaEEN';
const REDIRECT_URI  = 'http://127.0.0.1:3000/api/auth/callback';

// Admin credentials
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';
const adminSessions = new Set();

// Keycloak service account token cache
let serviceToken = null;
let serviceTokenExpiry = 0;

const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_DATA = {
  machines: [
    { id: 'demo-01', alias: 'Build Server',  rustdesk_id: '', tag: 'Engineering', note: '' },
    { id: 'demo-02', alias: 'Marketing PC',  rustdesk_id: '', tag: 'Marketing',   note: '' },
    { id: 'demo-03', alias: 'K8s Node',      rustdesk_id: '', tag: 'DevOps',      note: '' },
  ],
  roles: {
    admin:  ['demo-01', 'demo-02', 'demo-03'],
    viewer: ['demo-01'],
  },
};

function loadData() {
  let data;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    data = JSON.parse(raw);
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }

  // Migration: old books structure → machines
  if (data.books && !data.machines) {
    const machines = [];
    const bookToIds = {};
    for (const [bookName, book] of Object.entries(data.books)) {
      const ids = [];
      for (const peer of (book.peers || [])) {
        const mid = crypto.randomBytes(8).toString('hex');
        machines.push({
          id:          mid,
          alias:       peer.alias || peer.name || '',
          rustdesk_id: peer.id || '',
          tag:         bookName,
          note:        '',
        });
        ids.push(mid);
      }
      bookToIds[bookName] = ids;
    }
    const newRoles = {};
    for (const [role, bookNames] of Object.entries(data.roles || {})) {
      const mids = new Set();
      for (const bn of bookNames) {
        (bookToIds[bn] || []).forEach(id => mids.add(id));
      }
      newRoles[role] = [...mids];
    }
    data.machines = machines;
    data.roles = newRoles;
    delete data.books;
    saveData(data);
  }

  if (!data.machines) data.machines = JSON.parse(JSON.stringify(DEFAULT_DATA.machines));
  if (!data.roles || Object.keys(data.roles).length === 0) {
    data.roles = JSON.parse(JSON.stringify(DEFAULT_DATA.roles));
  }

  // Normalize machine fields
  data.machines = data.machines.map(m => ({
    id:          m.id          || crypto.randomBytes(8).toString('hex'),
    alias:       m.alias       || '',
    rustdesk_id: m.rustdesk_id || '',
    tag:         m.tag         || '',
    note:        m.note        || '',
  }));

  saveData(data);
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let appData = loadData();

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

function getMachinesForRoles(roles) {
  const ids = new Set();
  for (const role of roles) {
    const mapped = appData.roles[role];
    if (mapped) mapped.forEach(id => ids.add(id));
  }
  return [...ids].map(id => appData.machines.find(m => m.id === id)).filter(Boolean);
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
          delete appData.roles[roleName];
          saveData(appData);
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
        kcRolesList = Object.keys(appData.roles).map(name => ({ name }));
      }

      const roleDetails = await Promise.all(kcRolesList.map(async kcRole => {
        const machine_ids = appData.roles[kcRole.name] || [];
        const machines = machine_ids
          .map(id => appData.machines.find(m => m.id === id))
          .filter(Boolean)
          .map(m => ({ id: m.id, alias: m.alias, rustdesk_id: m.rustdesk_id, tag: m.tag }));

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
      const newRoles = {};
      for (const [roleName, ids] of Object.entries(body)) {
        if (!Array.isArray(ids)) continue;
        newRoles[roleName] = ids.filter(id => appData.machines.some(m => m.id === id));
      }
      appData.roles = newRoles;
      saveData(appData);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ── Machines CRUD ─────────────────────────────────────────────────────

    if (req.method === 'GET' && p === '/admin/api/machines') {
      const machinesWithRoles = appData.machines.map(m => {
        const roles = Object.entries(appData.roles)
          .filter(([, ids]) => ids.includes(m.id))
          .map(([name]) => name);
        return { ...m, roles };
      });
      jsonResponse(res, 200, machinesWithRoles);
      return;
    }

    if (req.method === 'POST' && p === '/admin/api/machines') {
      const machine = {
        id:          crypto.randomBytes(8).toString('hex'),
        alias:       (body.alias       || '').trim(),
        rustdesk_id: (body.rustdesk_id || '').trim(),
        tag:         (body.tag         || '').trim(),
        note:        (body.note        || '').trim(),
      };
      appData.machines.push(machine);
      if (Array.isArray(body.roles)) {
        for (const roleName of body.roles) {
          if (!appData.roles[roleName]) appData.roles[roleName] = [];
          if (!appData.roles[roleName].includes(machine.id)) appData.roles[roleName].push(machine.id);
        }
      }
      saveData(appData);
      jsonResponse(res, 200, { ok: true, id: machine.id });
      return;
    }

    const machineMatch = p.match(/^\/admin\/api\/machines\/([^/]+)$/);
    if (machineMatch) {
      const mid = decodeURIComponent(machineMatch[1]);
      const idx = appData.machines.findIndex(m => m.id === mid);

      if (req.method === 'PUT') {
        if (idx === -1) { jsonResponse(res, 404, { error: 'Machine not found' }); return; }
        const existing = appData.machines[idx];
        appData.machines[idx] = {
          id:          mid,
          alias:       body.alias       !== undefined ? String(body.alias).trim()       : existing.alias,
          rustdesk_id: body.rustdesk_id !== undefined ? String(body.rustdesk_id).trim() : existing.rustdesk_id,
          tag:         body.tag         !== undefined ? String(body.tag).trim()         : existing.tag,
          note:        body.note        !== undefined ? String(body.note).trim()        : existing.note,
        };
        if (Array.isArray(body.roles)) {
          const wantedRoles = new Set(body.roles);
          for (const [roleName, ids] of Object.entries(appData.roles)) {
            const has  = ids.includes(mid);
            const want = wantedRoles.has(roleName);
            if (want && !has) ids.push(mid);
            if (!want && has) appData.roles[roleName] = ids.filter(id => id !== mid);
          }
          for (const roleName of wantedRoles) {
            if (!appData.roles[roleName]) appData.roles[roleName] = [mid];
          }
        }
        saveData(appData);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE') {
        if (idx !== -1) appData.machines.splice(idx, 1);
        // Remove machine id from all roles
        for (const arr of Object.values(appData.roles)) {
          const i = arr.indexOf(mid);
          if (i >= 0) arr.splice(i, 1);
        }
        saveData(appData);
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
}).listen(3000, '127.0.0.1', () => {
  console.log('Gateway running at http://127.0.0.1:3000');
  console.log('Admin UI:         http://127.0.0.1:3000/admin');
});
