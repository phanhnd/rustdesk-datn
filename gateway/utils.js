const url_module = require('url');
const cfg = require('./config');

// ── Session stores ────────────────────────────────────────────────────────────
const adminSessions    = new Map(); // session token → { sub, username, roles, expiresAt }
const adminLoginStates = new Map(); // CSRF state → expiresAt
const clientSessions   = new Map(); // session_code → { pending, createdAt, access_token?, error? }

const SESSION_TTL_MS = 10 * 60 * 1000;

function sweepStaleSessions() {
  const now = Date.now();
  for (const [code, s] of clientSessions) {
    if (now - s.createdAt > SESSION_TTL_MS) clientSessions.delete(code);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
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
      headers: { ...headers, ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}) },
    };
    const req = mod.request(options, res => {
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

// ── Response helpers ──────────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function renderAdminAuthError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h2>${message}</h2><p><a href="/admin/login">Quay lại đăng nhập</a></p></body></html>`);
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

// ── Auth middleware ───────────────────────────────────────────────────────────
// allowedRoles=null: chỉ cần đăng nhập. admin tối cao (cfg.ADMIN_ROLE) bypass mọi tier-check.
function requireAdminAuth(req, res, allowedRoles = null) {
  const cookies = parseCookies(req);
  const session = cookies.admin_session ? adminSessions.get(cookies.admin_session) : null;
  if (!session || Date.now() > session.expiresAt) {
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return false;
  }
  if (allowedRoles && !session.roles.includes(cfg.ADMIN_ROLE) &&
      !allowedRoles.some(r => session.roles.includes(r))) {
    jsonResponse(res, 403, { error: 'Forbidden: insufficient admin tier' });
    return false;
  }
  return true;
}

function requireSuperAdmin(req, res) {
  const cookies = parseCookies(req);
  const session = cookies.admin_session ? adminSessions.get(cookies.admin_session) : null;
  if (!session || Date.now() > session.expiresAt) {
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return false;
  }
  if (!session.roles.includes(cfg.ADMIN_ROLE)) {
    jsonResponse(res, 403, { error: 'Forbidden: super admin required' });
    return false;
  }
  return true;
}

module.exports = {
  adminSessions, adminLoginStates, clientSessions,
  sweepStaleSessions,
  readBody, httpRequest, httpPost,
  jsonResponse, renderAdminAuthError, parseCookies,
  requireAdminAuth, requireSuperAdmin,
};
