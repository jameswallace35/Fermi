// Minimal static file server for local development (no dependencies).
// Serves only regular files under the project root, GET and HEAD only, never
// dot-directories such as .git. Usage: node scripts/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function reply(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }).end('Method not allowed');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    reply(res, 400, 'Bad request');
    return;
  }
  if (pathname.includes('\0') || pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.')) {
    reply(res, 404, 'Not found');
    return;
  }
  let file = path.normalize(path.join(root, pathname));
  if (file !== root && !file.startsWith(root + path.sep)) {
    reply(res, 403, 'Forbidden');
    return;
  }
  let stat = null;
  try {
    stat = fs.statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = fs.statSync(file);
    }
  } catch {
    reply(res, 404, 'Not found');
    return;
  }
  if (!stat.isFile()) {
    reply(res, 404, 'Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      reply(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

http
  .createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) reply(res, 500, 'Internal error');
      else res.end();
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Ballpark is running at http://127.0.0.1:${port}/`));
