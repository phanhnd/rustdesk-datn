const querystring = require('querystring');
const cfg = require('./config');
const { httpRequest, httpPost } = require('./utils');

// ── Service account token cache ───────────────────────────────────────────────
let serviceToken = null;
let serviceTokenExpiry = 0;

async function getServiceToken() {
  if (serviceToken && Date.now() < serviceTokenExpiry) return serviceToken;
  const body = querystring.stringify({
    grant_type:    'client_credentials',
    client_id:     cfg.CLIENT_ID,
    client_secret: cfg.CLIENT_SECRET,
  });
  const result = await httpPost(`${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/token`, body);
  const data = JSON.parse(result.body);
  if (!data.access_token) throw new Error('Failed to get service token: ' + (data.error_description || result.body));
  serviceToken = data.access_token;
  serviceTokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
  return serviceToken;
}

// Cache UUID theo clientId để tránh gọi KC nhiều lần
const cachedClientUuids = new Map();
async function getClientUuid(clientId = cfg.CLIENT_ID) {
  if (cachedClientUuids.has(clientId)) return cachedClientUuids.get(clientId);
  const r = await keycloakAdminGet(`/clients?clientId=${encodeURIComponent(clientId)}`);
  const clients = JSON.parse(r.body);
  if (!Array.isArray(clients) || !clients.length) throw new Error('Client not found: ' + clientId);
  cachedClientUuids.set(clientId, clients[0].id);
  return clients[0].id;
}

async function keycloakAdminGet(path) {
  const token = await getServiceToken();
  return httpRequest(
    `${cfg.KEYCLOAK_URL}/admin/realms/${cfg.REALM}${path}`,
    'GET', null,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
}

async function keycloakAdminRequest(method, path, body) {
  const token = await getServiceToken();
  const bodyStr = body ? JSON.stringify(body) : null;
  return httpRequest(
    `${cfg.KEYCLOAK_URL}/admin/realms/${cfg.REALM}${path}`,
    method, bodyStr,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
}

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

function getRolesFromPayload(payload, clientId = cfg.CLIENT_ID) {
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

// Đọc Group Keycloak từ claim "groups" trong JWT; strip dấu "/" đầu nếu có.
function getGroupsFromPayload(payload) {
  const raw = Array.isArray(payload.groups) ? payload.groups : [];
  return raw.map(g => (typeof g === 'string' ? g.replace(/^\/+/, '') : '')).filter(Boolean);
}

async function introspectToken(token, clientId, clientSecret) {
  const body = querystring.stringify({ token, client_id: clientId, client_secret: clientSecret });
  const result = await httpPost(`${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/token/introspect`, body);
  return JSON.parse(result.body);
}

// Cache introspect 30 giây để giảm tải Keycloak; không cache lỗi tạm thời (fail-closed).
const INTROSPECTION_CACHE_TTL_MS = 30 * 1000;
const introspectionCache = new Map();

async function introspectTokenCached(token) {
  const cached = introspectionCache.get(token);
  if (cached && Date.now() < cached.cachedUntil) return cached;
  let entry;
  try {
    const result = await introspectToken(token, cfg.CLIENT_ID, cfg.CLIENT_SECRET);
    entry = { active: !!result.active, payload: result, cachedUntil: Date.now() + INTROSPECTION_CACHE_TTL_MS };
  } catch (err) {
    console.error('Token introspection failed:', err.message);
    return { active: false, payload: {}, cachedUntil: 0 };
  }
  introspectionCache.set(token, entry);
  return entry;
}

function clearIntrospectionCache(token) {
  introspectionCache.delete(token);
}

function buildKeycloakLogoutUrl(postLogoutPath) {
  const params = new URLSearchParams({
    client_id: cfg.ADMIN_CLIENT_ID,
    post_logout_redirect_uri: `http://${cfg.VM_HOST}${postLogoutPath}`,
  });
  return `${cfg.KEYCLOAK_URL}/realms/${cfg.REALM}/protocol/openid-connect/logout?${params}`;
}

module.exports = {
  getServiceToken, getClientUuid,
  keycloakAdminGet, keycloakAdminRequest,
  listGroups, createGroup, deleteGroupById, getGroupMembers,
  addUserToGroup, removeUserFromGroup,
  getRolesFromPayload, getGroupsFromPayload,
  introspectToken, introspectTokenCached, clearIntrospectionCache,
  buildKeycloakLogoutUrl,
};
