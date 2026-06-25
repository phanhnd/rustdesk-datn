const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

const DATA_DIR  = path.join(__dirname, path.dirname(cfg.DB_FILE));
const DB_FILE   = path.resolve(__dirname, cfg.DB_FILE);
const JSON_FILE = path.join(__dirname, 'data.json');

let db;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
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
  _migrateFromJsonIfNeeded();
}

function _migrateFromJsonIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM machines').get().n;
  if (count > 0) return;

  let legacy = null;
  try { legacy = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); } catch (_) {}

  const insertM = db.prepare('INSERT INTO machines (id, alias, rustdesk_id, note) VALUES (?, ?, ?, ?)');
  const insertG = db.prepare('INSERT OR IGNORE INTO machine_groups (group_name, machine_id) VALUES (?, ?)');

  if (legacy && Array.isArray(legacy.machines)) {
    for (const m of legacy.machines) {
      insertM.run(m.id || crypto.randomBytes(8).toString('hex'), m.alias || '', m.rustdesk_id || '', m.note || '');
    }
  } else {
    const demo = [
      { id: 'demo-01', alias: 'Build Server',  rustdesk_id: '', note: '' },
      { id: 'demo-02', alias: 'Marketing PC',  rustdesk_id: '', note: '' },
      { id: 'demo-03', alias: 'K8s Node',      rustdesk_id: '', note: '' },
    ];
    for (const m of demo) insertM.run(m.id, m.alias, m.rustdesk_id, m.note);
    insertG.run('demo-group', 'demo-01');
    insertG.run('demo-group', 'demo-02');
    insertG.run('demo-group', 'demo-03');
  }
}

function attachGroups(machines) {
  const rows = db.prepare('SELECT group_name, machine_id FROM machine_groups').all();
  const byMachine = {};
  for (const row of rows) {
    (byMachine[row.machine_id] = byMachine[row.machine_id] || []).push(row.group_name);
  }
  return machines.map(m => ({ ...m, groups: byMachine[m.id] || [] }));
}

function getAllMachines() {
  return attachGroups(db.prepare('SELECT id, alias, rustdesk_id, note FROM machines').all());
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
  db.prepare('INSERT INTO machines (id, alias, rustdesk_id, note) VALUES (?, ?, ?, ?)').run(id, alias || '', rustdesk_id || '', note || '');
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
  for (const g of (groupNames || [])) stmt.run(g, machineId);
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
  for (const id of ids) { if (machineExists(id)) stmt.run(groupName, id); }
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

module.exports = {
  init,
  getAllMachines, getMachineById, getMachineByRustdeskId, machineExists,
  insertMachine, updateMachine, deleteMachine,
  setMachineGroups, getGroupsMap, setGroupMachineIds, deleteGroupMapping,
  getMachinesForGroups,
};
