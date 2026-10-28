import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const vendor = { '/vendor/jszip.min.js': '../node_modules/jszip/dist/jszip.min.js', '/vendor/sha256.min.js': '../node_modules/js-sha256/build/sha256.min.js' };
    const file = vendor[pathname] ? path.resolve(root, vendor[pathname]) : path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!vendor[pathname] && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => {
  console.log(`看房日记原型：http://localhost:${port}`);
  for (const interfaces of Object.values(os.networkInterfaces())) for (const item of interfaces || []) if (item.family === 'IPv4' && !item.internal) console.log(`同一 Wi-Fi 手机访问：http://${item.address}:${port}`);
});
