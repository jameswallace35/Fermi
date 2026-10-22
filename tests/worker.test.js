import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { sanitizePuzzle, mergePuzzle, timingSafeEqual, createPasswordRecord, verifyPassword, validateUsername, computeStats, scorePuzzle, ANSWERS, HttpError } from '../worker/src/index.js';
import { createD1 } from './helpers/d1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'worker', 'migrations');
const schema = fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(migrations, f), 'utf8')).join('\n');

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

test('computeStats measures in decades and compares against other players', () => {
  const empty = computeStats([], 100, 100);
  assert.equal(empty.count, 0);
  assert.equal(empty.histogram.length, 12);
  const s = computeStats([100, 1000, 10, 100000, 0.001], 100, 1000);
  assert.equal(s.count, 5);
  assert.ok(Math.abs(s.typical - 100 * 10 ** ((0 + 1 - 1 + 3 - 5) / 5)) < 1e-6);
  assert.equal(s.median, 100);
  assert.equal(s.histogram.reduce((a, b) => a + b, 0), 5);
  assert.equal(s.histogram[6], 1); // exact answer sits in the first bucket above the centre
  assert.equal(s.histogram[11], 1); // 1000x folds into the top bucket
  assert.equal(s.histogram[0], 1); // 100000x too low folds into the bottom bucket
  assert.equal(s.within2x, 0.2);
  // my guess (1000, one decade off) beats the players at 3 and 5 decades off, not the exact one or the 10 (also one decade)
  assert.equal(s.beat, 0.5);
  assert.equal(computeStats([100], 100, 100).beat, null); // alone: nobody to compare against
  assert.equal(computeStats([100, 5], 100).beat, null);
});

test('guess stats endpoints: one guess per player, anonymous or signed in', async () => {
  const env = makeEnv();
  const token = (await call(env, 'POST', '/api/signup', { body: { username: 'stats_user', password: 'estimate123' } })).body.token;
  const q = 'geography-abc123';
  let r = await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: 1000, answer: 100 } });
  assert.equal(r.status, 400, 'anonymous guesses need a player id');
  r = await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: 1000, answer: 100, player: 'anon_player_0000000001' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.beat, null);
  r = await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: 5, answer: 100, player: 'anon_player_0000000001' } });
  assert.equal(r.body.count, 1, 'a second guess from the same player is ignored');
  r = await call(env, 'POST', '/api/guesses', { token, body: { question_id: q, guess: 120, answer: 100 } });
  assert.equal(r.body.count, 2);
  assert.ok(Math.abs(r.body.beat - 1) < 1e-9, 'the signed-in player (1.2x off) beats the anonymous one (10x off)');
  r = await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: 10, answer: 100, player: 'anon_player_0000000002' } });
  assert.equal(r.body.count, 3);
  assert.ok(Math.abs(r.body.beat - 0) < 1e-9, 'ties do not count as beating');
  r = await call(env, 'GET', `/api/stats?question_id=${q}&answer=100&guess=120`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
  assert.ok(Math.abs(r.body.beat - 1) < 1e-9);
  assert.ok(Math.abs(r.body.typical - 100 * 10 ** ((1 + Math.log10(1.2) - 1) / 3)) < 1e-6);
  r = await call(env, 'GET', `/api/stats?question_id=${q}&answer=100`, {});
  assert.equal(r.body.beat, null);
  r = await call(env, 'GET', '/api/stats?question_id=nope!&answer=100', {});
  assert.equal(r.status, 400);
  r = await call(env, 'GET', `/api/stats?question_id=${q}&answer=0`, {});
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: -1, answer: 100, player: 'anon_player_0000000003' } });
  assert.equal(r.status, 400);
  // deleting the account removes its guesses
  await call(env, 'DELETE', '/api/account', { token, body: { password: 'estimate123' } });
  r = await call(env, 'GET', `/api/stats?question_id=${q}&answer=100`, {});
  assert.equal(r.body.count, 2);
});

const REAL_IDS = Object.keys(ANSWERS).slice(0, 5);
const exactGuesses = () => REAL_IDS.map((id) => ANSWERS[id]);

test('scorePuzzle uses the server answers and refuses unknown ids', () => {
  const perfect = scorePuzzle({ ids: REAL_IDS, guesses: exactGuesses() });
  assert.equal(perfect.score, 1);
  assert.deepEqual(perfect.multiples, [1, 1, 1, 1, 1]);
  const doubled = scorePuzzle({ ids: REAL_IDS, guesses: exactGuesses().map((a) => a * 2) });
  assert.equal(doubled.score, 2);
  assert.equal(scorePuzzle({ ids: ['nope-1', ...REAL_IDS.slice(1)], guesses: exactGuesses() }), null);
  assert.equal(scorePuzzle({ ids: REAL_IDS, guesses: [1, 2] }), null);
  assert.equal(scorePuzzle({ guesses: exactGuesses() }), null);
});

test('leaderboards rank finished puzzles by server-computed score', async () => {
  const env = makeEnv();
  const signup = async (u) => (await call(env, 'POST', '/api/signup', { body: { username: u, password: 'estimate123' } })).body.token;
  const [alice, bob, carol] = await Promise.all([signup('alice'), signup('bob_b'), signup('carol')]);
  const finish = (token, n, factor) => call(env, 'PUT', '/api/puzzles', { token, body: { puzzles: { [n]: { guesses: exactGuesses().map((a) => a * factor), ids: REAL_IDS, completedAt: 5 } } } });
  await finish(alice, 1, 3);
  await finish(bob, 1, 1.5);
  await finish(carol, 1, 10);
  await finish(alice, 2, 1);
  await finish(alice, 3, 1);
  await finish(bob, 2, 4);
  // an unfinished puzzle never scores
  await call(env, 'PUT', '/api/puzzles', { token: carol, body: { puzzles: { 2: { guesses: [1, 2], ids: REAL_IDS.slice(0, 2) } } } });

  let r = await call(env, 'GET', '/api/leaderboard?n=1', {});
  assert.equal(r.status, 401, 'leaderboards need a session');
  r = await call(env, 'GET', '/api/leaderboard?n=1', { token: alice });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.players.map((p) => p.username), ['bob_b', 'alice', 'carol']);
  assert.deepEqual(r.body.players.map((p) => p.score), [1.5, 3, 10]);
  assert.deepEqual(r.body.players.map((p) => p.you), [false, true, false]);
  assert.deepEqual(r.body.players[0].multiples, [1.5, 1.5, 1.5, 1.5, 1.5]);
  r = await call(env, 'GET', '/api/leaderboard?n=2', { token: carol });
  assert.deepEqual(r.body.players.map((p) => p.username), ['alice', 'bob_b']);
  r = await call(env, 'GET', '/api/leaderboard?n=abc', { token: alice });
  assert.equal(r.status, 400);

  r = await call(env, 'GET', '/api/leaderboard?scope=all', { token: bob });
  assert.equal(r.status, 200);
  const names = r.body.players.map((p) => `${p.username}:${p.played}:${p.ranked}`);
  assert.deepEqual(names, ['alice:3:true', 'bob_b:2:false', 'carol:1:false'], 'ranked players first, then by puzzles played');
  const aliceRow = r.body.players[0];
  assert.ok(Math.abs(aliceRow.average - (3 + 1 + 1) / 3) < 1e-9);
  assert.equal(aliceRow.best, 1);
  assert.equal(r.body.players[1].you, true);

  // GET /api/puzzles backfills a missing score
  env.DB.raw.prepare('UPDATE puzzles SET score = NULL WHERE n = 1').run();
  r = await call(env, 'GET', '/api/leaderboard?n=1', { token: alice });
  assert.equal(r.body.players.length, 0);
  await call(env, 'GET', '/api/puzzles', { token: bob });
  r = await call(env, 'GET', '/api/leaderboard?n=1', { token: alice });
  assert.deepEqual(r.body.players.map((p) => p.username), ['bob_b']);
});
