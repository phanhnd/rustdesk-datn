const fs   = require('fs');
const path = require('path');

(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
})();

const VM_HOST       = process.env.VM_HOST       || 'localhost:3000';
const KEYCLOAK_HOST = process.env.KEYCLOAK_HOST || 'localhost:8080';

module.exports = {
  VM_HOST,
  KEYCLOAK_HOST,
  KEYCLOAK_URL:         `http://${KEYCLOAK_HOST}`,
  REALM:                process.env.REALM               || 'rustdesk',
  CLIENT_ID:            process.env.CLIENT_ID           || 'rustdesk-client',
  CLIENT_SECRET:        process.env.CLIENT_SECRET       || '',
  REDIRECT_URI:         `http://${VM_HOST}/api/auth/callback`,
  ADMIN_CLIENT_ID:      process.env.ADMIN_CLIENT_ID     || 'rocky-admin',
  ADMIN_CLIENT_SECRET:  process.env.ADMIN_CLIENT_SECRET || '',
  ADMIN_REDIRECT_URI:   `http://${VM_HOST}/admin/auth/callback`,
  ADMIN_ROLE:           'admin',
  ADMIN_ROLE_USERS:     'manage_users',
  ADMIN_ROLE_MACHINES:  'manage_machines',
  ADMIN_SESSION_TTL_MS: Number(process.env.ADMIN_SESSION_TTL_MS) || 8 * 60 * 60 * 1000,
  DB_FILE:              process.env.DB_FILE || './data/rocky.db',
};
