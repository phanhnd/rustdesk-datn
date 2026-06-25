const crypto      = require('crypto');
const querystring = require('querystring');
const cfg  = require('../config');
const { readBody, jsonResponse, clientSessions, sweepStaleSessions, httpPost } = require('../utils');
const kc   = require('../keycloak');
const db   = require('../db');

async function handle(req, res, p) {
  // ── Logout ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/auth/logout') {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    let revoked = true;
    if (token) {
      const body = querystring.stringify({
        client_id: cfg.CLIENT_ID, client_secret: cfg.CLIENT_SECRET,
        token, token_type_hint: 'access_token',
      });
      try {
        const result = await httpPost(`${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/revoke`, body);
        revoked = result.status >= 200 && result.status < 300;
        if (!revoked) console.error('Token revoke failed: HTTP', result.status, result.body);
      } catch (err) {
        revoked = false;
        console.error('Token revoke failed:', err.message);
      }
      kc.clearIntrospectionCache(token);
    }
    jsonResponse(res, 200, { ok: true, revoked });
    return;
  }

  // ── Init auth flow ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/auth/init') {
    sweepStaleSessions();
    const session_code = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: cfg.CLIENT_ID, redirect_uri: cfg.REDIRECT_URI,
      response_type: 'code', scope: 'openid', state: session_code, prompt: 'login',
    });
    const url = `${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/auth?${params}`;
    clientSessions.set(session_code, { pending: true, createdAt: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url, session_code }));
    return;
  }

  // ── Auth callback (browser redirect) ────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/auth/callback') {
    const qs    = new URLSearchParams(req.url.split('?')[1] || '');
    const code  = qs.get('code');
    const state = qs.get('state');
    if (!code || !state) { res.writeHead(400); res.end('Missing code or state'); return; }
    const createdAt = (clientSessions.get(state) || {}).createdAt || Date.now();
    try {
      const body = querystring.stringify({
        grant_type: 'authorization_code', code, redirect_uri: cfg.REDIRECT_URI,
        client_id: cfg.CLIENT_ID, client_secret: cfg.CLIENT_SECRET,
      });
      const result    = await httpPost(`${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/token`, body);
      const tokenData = JSON.parse(result.body);
      if (tokenData.access_token) {
        clientSessions.set(state, { access_token: tokenData.access_token, pending: false, createdAt });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Login thành công, đóng tab này.</h2></body></html>');
      } else {
        clientSessions.set(state, { pending: false, error: tokenData.error_description || 'Token exchange failed', createdAt });
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Login thất bại.</h2></body></html>');
      }
    } catch (err) {
      clientSessions.set(state, { pending: false, error: err.message, createdAt });
      res.writeHead(500); res.end('Token exchange error');
    }
    return;
  }

  // ── Poll auth status ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/auth/status') {
    const rawBody = await readBody(req);
    let session_code;
    try { session_code = JSON.parse(rawBody).session_code; } catch (_) {}
    const session = clientSessions.get(session_code);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!session || session.pending) {
      res.end(JSON.stringify({ pending: true }));
    } else {
      clientSessions.delete(session_code);
      res.end(JSON.stringify(session.access_token
        ? { access_token: session.access_token }
        : { pending: false, error: session.error }));
    }
    return;
  }

  // ── Check access ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/check-access') {
    const token    = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const rawBody  = await readBody(req);
    let checkBody  = {};
    try { if (rawBody) checkBody = JSON.parse(rawBody); } catch (_) {}
    const rustdesk_id = checkBody.rustdesk_id;
    if (!rustdesk_id) { jsonResponse(res, 400, { error: 'missing rustdesk_id' }); return; }

    const machine = db.getMachineByRustdeskId(rustdesk_id);
    if (!machine) { jsonResponse(res, 200, { allowed: true }); return; }
    if (!token)   { jsonResponse(res, 200, { allowed: false, reason: 'login_required' }); return; }

    const introspection = await kc.introspectTokenCached(token);
    if (!introspection.active) { jsonResponse(res, 200, { allowed: false, reason: 'login_required' }); return; }

    const userGroups = kc.getGroupsFromPayload(introspection.payload);
    const allowedIds = db.getMachinesForGroups(userGroups).map(m => m.id);
    const allowed    = allowedIds.includes(machine.id);
    console.log(`[check-access] rustdesk_id=${rustdesk_id} groups=${userGroups} allowed=${allowed}`);
    jsonResponse(res, 200, { allowed, reason: allowed ? null : 'no_permission' });
    return;
  }

  // ── Address books ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/address-books') {
    const token         = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const introspection = token ? await kc.introspectTokenCached(token) : { active: false, payload: {} };
    const groups        = introspection.active ? kc.getGroupsFromPayload(introspection.payload) : [];
    const machines      = introspection.active ? db.getMachinesForGroups(groups) : [];
    console.log('[address-books DEBUG]', {
      rawGroupsClaim:   introspection.payload.groups,
      normalizedGroups: groups,
      groupsMapInDb:    db.getGroupsMap(),
      machinesReturned: machines.map(m => m.id),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ machines }));
    return;
  }

  res.writeHead(404); res.end('Not found');
}

module.exports = { handle };
