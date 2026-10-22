import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { sanitizePuzzle, mergePuzzle, timingSafeEqual, createPasswordRecord, verifyPassword, validateUsername, HttpError } from '../worker/src/index.js';
import { createD1 } from './helpers/d1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = fs.readFileSync(path.join(root, 'worker', 'migrations', '0001_init.sql'), 'utf8');

function makeEnv() {
  return { DB: createD1(schema), ALLOWED_ORIGINS: 'https://game.example', PBKDF2_ITERATIONS: '10000' };
}

async function call(env, method, pathname, { body, token, ip = '1.2.3.4', origin, headers = {} } = {}) {
  const h = { ...headers, 'CF-Connecting-IP': ip };
  if (origin) h.Origin = origin;
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(`https://api.example${pathname}`, { method, headers: h, body: payload }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

test('password hashing verifies and rejects', async () => {
  const record = await createPasswordRecord('correct horse battery', 1000);
  assert.equal(record.pw_iterations, 1000);
  assert.equal(await verifyPassword('correct horse battery', record), true);
  assert.equal(await verifyPassword('correct horse batter', record), false);
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
});

test('validation and merge helpers', () => {
  assert.equal(validateUsername('  Alice_1 '), 'alice_1');
  assert.throws(() => validateUsername('al'), HttpError);
  assert.throws(() => validateUsername('has space'), HttpError);
  assert.deepEqual(sanitizePuzzle({ guesses: [1, 2], ids: ['a', 'b'], units: ['miles', 7], completedAt: 5 }), { guesses: [1, 2], completedAt: 5, ids: ['a', 'b'], units: ['miles', null] });
  assert.equal(sanitizePuzzle({ guesses: [] }), null);
  assert.equal(sanitizePuzzle({ guesses: [1, 2, 3, 4, 5, 6] }), null);
  assert.equal(sanitizePuzzle({ guesses: [0] }), null);
  assert.equal(sanitizePuzzle('nope'), null);
  const a = { guesses: [1] };
  const b = { guesses: [1, 2] };
  assert.equal(mergePuzzle(a, b), b);
  assert.equal(mergePuzzle(b, a), b);
  assert.equal(mergePuzzle(null, a), a);
});

test('signup, login, me, logout and session expiry', async () => {
  const env = makeEnv();
  let r = await call(env, 'POST', '/api/signup', { body: { username: 'Fermi_Fan', password: 'estimate123' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.username, 'fermi_fan');
  const token = r.body.token;
  assert.match(token, /^[A-Za-z0-9_-]{40,50}$/);

  r = await call(env, 'POST', '/api/signup', { body: { username: 'fermi_fan', password: 'another-pass' } });
  assert.equal(r.status, 409);
  r = await call(env, 'POST', '/api/signup', { body: { username: 'short', password: 'tiny' } });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/signup', { body: { username: 'bad name', password: 'estimate123' } });
  assert.equal(r.status, 400);

  r = await call(env, 'GET', '/api/me', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.username, 'fermi_fan');

  r = await call(env, 'POST', '/api/login', { body: { username: 'FERMI_FAN', password: 'wrong-password' } });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/login', { body: { username: 'nobody_here', password: 'wrong-password' } });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/login', { body: { username: 'fermi_fan', password: 'estimate123' } });
  assert.equal(r.status, 200);
  const token2 = r.body.token;
  assert.notEqual(token2, token);

  r = await call(env, 'POST', '/api/logout', { token });
  assert.equal(r.status, 204);
  r = await call(env, 'GET', '/api/me', { token });
  assert.equal(r.status, 401);
  r = await call(env, 'GET', '/api/me', { token: token2 });
  assert.equal(r.status, 200);

  // tokens are stored hashed
  const rows = env.DB.raw.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(rows.every((row) => row.token_hash !== token2 && /^[0-9a-f]{64}$/.test(row.token_hash)));

  // expiry
  env.DB.raw.prepare('UPDATE sessions SET expires_at = 1').run();
  r = await call(env, 'GET', '/api/me', { token: token2 });
  assert.equal(r.status, 401);
  r = await call(env, 'GET', '/api/me', {});
  assert.equal(r.status, 401);
  r = await call(env, 'GET', '/api/me', { token: 'not-a-real-token-value-at-all-1234567' });
  assert.equal(r.status, 401);
});

test('puzzles merge: more guesses win, junk is dropped, other users are isolated', async () => {
  const env = makeEnv();
  const a = (await call(env, 'POST', '/api/signup', { body: { username: 'alice', password: 'estimate123' } })).body.token;
  const b = (await call(env, 'POST', '/api/signup', { body: { username: 'bob_b', password: 'estimate123' } })).body.token;

  let r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [10, 20] }, 2: { guesses: [5, 5, 5, 5, 5], ids: ['x', 'y', 'z', 'w', 'v'], completedAt: 123 }, junk: { guesses: [1] }, 0: { guesses: [1] }, 3: 'nope' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.puzzles).sort(), ['1', '2']);

  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [99] }, 2: { guesses: [1, 2, 3, 4, 5] } } } });
  assert.deepEqual(r.body.puzzles[1].guesses, [10, 20], 'fewer guesses never overwrite');
  assert.deepEqual(r.body.puzzles[2].guesses, [5, 5, 5, 5, 5], 'equal count keeps stored');

  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [10, 20, 30] } } } });
  assert.deepEqual(r.body.puzzles[1].guesses, [10, 20, 30]);

  r = await call(env, 'GET', '/api/puzzles', { token: a });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.puzzles).sort(), ['1', '2']);
  assert.equal(r.body.puzzles[2].completedAt, 123);

  r = await call(env, 'GET', '/api/puzzles', { token: b });
  assert.deepEqual(r.body.puzzles, {});

  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { nope: 1 } });
  assert.equal(r.status, 400);
  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: '{bad json' });
  assert.equal(r.status, 400);
  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: {} }, headers: { 'content-length': String(300 * 1024) } });
  assert.equal(r.status, 413);
  const big = {};
  for (let i = 1; i <= 501; i++) big[i] = { guesses: [1] };
  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: big } });
  assert.equal(r.status, 413);
});

test('rate limiting blocks repeated failed logins', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/signup', { body: { username: 'carol', password: 'estimate123' } });
  let last;
  for (let i = 0; i < 10; i++) last = await call(env, 'POST', '/api/login', { body: { username: 'carol', password: 'wrong-password' }, ip: `10.0.0.${i}` });
  assert.equal(last.status, 401);
  last = await call(env, 'POST', '/api/login', { body: { username: 'carol', password: 'estimate123' }, ip: '10.0.0.99' });
  assert.equal(last.status, 429, 'per-username limit holds even with the right password');
  // another user from the same IP is still fine
  await call(env, 'POST', '/api/signup', { body: { username: 'dave_d', password: 'estimate123' }, ip: '10.0.0.99' });
  last = await call(env, 'POST', '/api/login', { body: { username: 'dave_d', password: 'estimate123' }, ip: '10.0.0.99' });
  assert.equal(last.status, 200);
  // signups per IP are limited too
  for (let i = 0; i < 10; i++) await call(env, 'POST', '/api/signup', { body: { username: `spam_${i}`, password: 'estimate123' }, ip: '9.9.9.9' });
  last = await call(env, 'POST', '/api/signup', { body: { username: 'spam_x', password: 'estimate123' }, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('account deletion removes everything and needs the password', async () => {
  const env = makeEnv();
  const token = (await call(env, 'POST', '/api/signup', { body: { username: 'erin', password: 'estimate123' } })).body.token;
  await call(env, 'PUT', '/api/puzzles', { token, body: { puzzles: { 1: { guesses: [1, 2, 3, 4, 5] } } } });
  let r = await call(env, 'DELETE', '/api/account', { token, body: { password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await call(env, 'DELETE', '/api/account', { token, body: { password: 'estimate123' } });
  assert.equal(r.status, 204);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM puzzles').get().c, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  r = await call(env, 'GET', '/api/me', { token });
  assert.equal(r.status, 401);
});

test('CORS, content types, unknown routes and health', async () => {
  const env = makeEnv();
  let r = await call(env, 'OPTIONS', '/api/login', { origin: 'https://game.example' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://game.example');
  r = await call(env, 'GET', '/api/health', { origin: 'https://evil.example' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const any = { ...makeEnv(), ALLOWED_ORIGINS: '*' };
  r = await call(any, 'GET', '/api/health', { origin: 'https://anything.example' });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://anything.example');
  r = await call(env, 'POST', '/api/login', { headers: { 'content-type': 'text/plain' }, body: undefined });
  assert.equal(r.status, 415);
  r = await call(env, 'GET', '/api/nothing', {});
  assert.equal(r.status, 404);
  r = await call(env, 'DELETE', '/api/login', {});
  assert.equal(r.status, 405);
});
