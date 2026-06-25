const cfg = require('../config');
const { readBody, jsonResponse, requireAdminAuth, requireSuperAdmin } = require('../utils');
const { keycloakAdminGet, keycloakAdminRequest, getClientUuid, listGroups, createGroup, deleteGroupById, getGroupMembers, addUserToGroup, removeUserFromGroup } = require('../keycloak');
const db = require('../db');

async function handle(req, res, p) {
  const raw = await readBody(req);
  let body = {};
  try { if (raw) body = JSON.parse(raw); } catch (_) {}

  // ── Users ──────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && p === '/admin/api/users') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_USERS])) return;
    try {
      const usersRes = await keycloakAdminGet('/users?max=200');
      const users = JSON.parse(usersRes.body);
      const adminUuid = await getClientUuid(cfg.ADMIN_CLIENT_ID);
      const enriched = await Promise.all(users.map(async u => {
        let groups = [], adminRoles = [];
        try {
          const gp = JSON.parse((await keycloakAdminGet(`/users/${u.id}/groups`)).body);
          if (Array.isArray(gp)) groups = gp.map(g => g.name);
        } catch (_) {}
        try {
          const rp = JSON.parse((await keycloakAdminGet(`/users/${u.id}/role-mappings/clients/${adminUuid}`)).body);
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
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_USERS])) return;
    const { username, email, firstName, lastName, password } = body;
    if (!username || !password) { jsonResponse(res, 400, { error: 'username và password là bắt buộc' }); return; }
    try {
      const r = await keycloakAdminRequest('POST', '/users', {
        username, email: email || '', firstName: firstName || '', lastName: lastName || '',
        enabled: true, credentials: [{ type: 'password', value: password, temporary: false }],
      });
      if (r.status === 201) {
        const newId = r.headers && r.headers.location ? r.headers.location.split('/').pop() : null;
        jsonResponse(res, 200, { ok: true, id: newId });
      } else {
        let errMsg = r.body;
        try { const e = JSON.parse(r.body); errMsg = e.errorMessage || e.error || r.body; } catch (_) {}
        jsonResponse(res, r.status, { error: errMsg });
      }
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  const userGroupsMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/groups$/);
  if (userGroupsMatch) {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_USERS])) return;
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
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  const userAdminRolesMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/admin-roles$/);
  if (userAdminRolesMatch) {
    if (!requireSuperAdmin(req, res)) return;
    const userId = userAdminRolesMatch[1];
    const names = Array.isArray(body.roles) ? body.roles : [];
    try {
      const uuid = await getClientUuid(cfg.ADMIN_CLIENT_ID);
      const allRoles = JSON.parse((await keycloakAdminGet(`/clients/${uuid}/roles`)).body);
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
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  const userEnabledMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/enabled$/);
  if (userEnabledMatch && req.method === 'PUT') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_USERS])) return;
    try {
      await keycloakAdminRequest('PUT', `/users/${userEnabledMatch[1]}`, { enabled: body.enabled });
      jsonResponse(res, 200, { ok: true });
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  const userDeleteMatch = p.match(/^\/admin\/api\/users\/([^/]+)$/);
  if (userDeleteMatch && req.method === 'DELETE') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_USERS])) return;
    try {
      const r = await keycloakAdminRequest('DELETE', `/users/${userDeleteMatch[1]}`, null);
      jsonResponse(res, r.status === 204 || r.status === 200 ? 200 : r.status,
        r.status === 204 || r.status === 200 ? { ok: true } : { error: r.body });
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  // ── Groups ─────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && p === '/admin/api/groups') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_USERS, cfg.ADMIN_ROLE_MACHINES])) return;
    let kcGroupsList = [], kcError = null;
    try {
      kcGroupsList = await listGroups();
    } catch (err) {
      kcError = err.message;
      kcGroupsList = Object.keys(db.getGroupsMap()).map(name => ({ id: null, name }));
    }

    const groupsMap = db.getGroupsMap();
    const allMachinesById = new Map(db.getAllMachines().map(m => [m.id, m]));
    const groups = await Promise.all(kcGroupsList.map(async kcGroup => {
      const machine_ids = groupsMap[kcGroup.name] || [];
      const machines = machine_ids.map(id => allMachinesById.get(id)).filter(Boolean)
        .map(m => ({ id: m.id, alias: m.alias, rustdesk_id: m.rustdesk_id }));
      let users = [];
      if (!kcError && kcGroup.id) {
        try {
          users = (await getGroupMembers(kcGroup.id)).map(u => ({
            id: u.id, username: u.username,
            firstName: u.firstName || '', lastName: u.lastName || '', email: u.email || '',
          }));
        } catch (_) {}
      }
      return { id: kcGroup.id, name: kcGroup.name, machine_ids, machines, users };
    }));
    jsonResponse(res, 200, { groups, kcError });
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
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  if (req.method === 'PUT' && p === '/admin/api/groups') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_MACHINES])) return;
    for (const [groupName, ids] of Object.entries(body)) {
      if (Array.isArray(ids)) db.setGroupMachineIds(groupName, ids);
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
        if (groupName) db.deleteGroupMapping(groupName);
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, delRes.status, { error: delRes.body });
      }
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }

  // ── Machines ───────────────────────────────────────────────────────────────

  if (req.method === 'GET' && p === '/admin/api/machines') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_MACHINES])) return;
    jsonResponse(res, 200, db.getAllMachines());
    return;
  }

  if (req.method === 'POST' && p === '/admin/api/machines') {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_MACHINES])) return;
    const id = db.insertMachine({
      alias:       (body.alias       || '').trim(),
      rustdesk_id: (body.rustdesk_id || '').trim(),
      note:        (body.note        || '').trim(),
    });
    if (Array.isArray(body.groups)) db.setMachineGroups(id, body.groups);
    jsonResponse(res, 200, { ok: true, id });
    return;
  }

  const machineMatch = p.match(/^\/admin\/api\/machines\/([^/]+)$/);
  if (machineMatch) {
    if (!requireAdminAuth(req, res, [cfg.ADMIN_ROLE_MACHINES])) return;
    const mid = decodeURIComponent(machineMatch[1]);

    if (req.method === 'PUT') {
      const updated = db.updateMachine(mid, {
        alias:       body.alias       !== undefined ? String(body.alias).trim()       : undefined,
        rustdesk_id: body.rustdesk_id !== undefined ? String(body.rustdesk_id).trim() : undefined,
        note:        body.note        !== undefined ? String(body.note).trim()        : undefined,
      });
      if (!updated) { jsonResponse(res, 404, { error: 'Machine not found' }); return; }
      if (Array.isArray(body.groups)) db.setMachineGroups(mid, body.groups);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      db.deleteMachine(mid);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    jsonResponse(res, 405, { error: 'Method not allowed' });
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

module.exports = { handle };
