// Run the accounts Worker locally on plain Node with an in-memory database,
// for development and the end-to-end test. Usage: node scripts/dev-api.mjs [port]
// Then set apiUrl in config.js to http://127.0.0.1:<port>.
import http from 'node:http';
import fs from 'node:fs';
import worker from '../worker/src/index.js';
import { createD1 } from '../tests/helpers/d1.js';

const port = Number(process.argv[2] || process.env.API_PORT || 8787);
const migrationsDir = new URL('../worker/migrations/', import.meta.url);
const schema = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, migrationsDir), 'utf8')).join('\n');
const env = { DB: createD1(schema), ALLOWED_ORIGINS: '*', PBKDF2_ITERATIONS: process.env.PBKDF2_ITERATIONS || '20000' };

http
  .createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'dev server error' }));
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Fermi accounts API (in-memory) at http://127.0.0.1:${port}/`));
