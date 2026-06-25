const http = require('http');
const cfg  = require('./config');
const db   = require('./db');
const adminAuth = require('./routes/admin-auth');
const adminApi  = require('./routes/admin-api');
const clientApi = require('./routes/client-api');

db.init();

http.createServer(async (req, res) => {
  const p = (req.url || '/').split('?')[0];
  console.log(`[${new Date().toISOString()}] ${req.method} ${p}`);

  if (p.startsWith('/admin/api/')) return adminApi.handle(req, res, p);
  if (p.startsWith('/admin'))      return adminAuth.handle(req, res, p);
  if (p.startsWith('/api/'))       return clientApi.handle(req, res, p);

  res.writeHead(404); res.end('Not found');
}).listen(3000, '0.0.0.0', () => {
  console.log(`Gateway running at http://${cfg.VM_HOST}`);
  console.log(`Admin UI:         http://${cfg.VM_HOST}/admin`);
});
