import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker, { sanitizePuzzle, mergePuzzle, timingSafeEqual, createPasswordRecord, verifyPassword, validateUsername, computeStats, scorePuzzle, answeredCount, isFinished, ANSWERS, HttpError, TIMED_DURATION_MS, TIMED_GRACE_MS } from '../worker/src/index.js';
import { createD1 } from './helpers/d1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'worker', 'migrations');
const schema = fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(migrations, f), 'utf8')).join('\n');

const OWNER_KEY = 'test-owner-key-0123456789';

function makeEnv() {
  return { DB: createD1(schema), ALLOWED_ORIGINS: 'https://game.example', PBKDF2_ITERATIONS: '10000', ADMIN_KEY_HASH: createHash('sha256').update(OWNER_KEY).digest('hex') };
}

async function call(env, method, pathname, { body, token, ip = '1.2.3.4', origin, headers = {}, now } = {}) {
  const h = { ...headers, 'CF-Connecting-IP': ip };
  if (origin) h.Origin = origin;
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const request = new Request(`https://api.example${pathname}`, { method, headers: h, body: payload });
  let res;
  if (now !== undefined) {
    const { handle } = await import('../worker/src/index.js');
    try {
      res = await handle(request, env, now);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res = new Response(JSON.stringify({ error: err.message }), { status: err.status });
    }
  } else res = await worker.fetch(request, env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const signupUser = async (env, username, ip) => (await call(env, 'POST', '/api/signup', { body: { username, password: 'estimate123' }, ip })).body.token;

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
  assert.deepEqual(sanitizePuzzle({ guesses: [1, 2], ids: ['a', 'b'], units: ['miles', 7], completedAt: 5, notes: 'x' }), { guesses: [1, 2], completedAt: 5, ids: ['a', 'b'], units: ['miles', null], notes: 'x' });
  assert.deepEqual(sanitizePuzzle({ guesses: [null, 2, null] }), { guesses: [null, 2], completedAt: null }, 'gaps are kept, trailing gaps dropped');
  assert.equal(sanitizePuzzle({ guesses: [] }), null);
  assert.equal(sanitizePuzzle({ guesses: [null, null] }), null);
  assert.equal(sanitizePuzzle({ guesses: [1, 2, 3, 4, 5, 6] }), null);
  assert.equal(sanitizePuzzle({ guesses: [0] }), null);
  assert.equal(sanitizePuzzle({ guesses: ['7'] }), null);
  assert.equal(sanitizePuzzle('nope'), null);
  assert.equal(sanitizePuzzle({ guesses: [1], notes: 'a'.repeat(5000) }).notes.length, 4000);
  assert.equal(answeredCount({ guesses: [null, 2, null, 4] }), 2);
  assert.equal(isFinished({ guesses: [1, 2, 3, 4, 5] }), true);
  assert.equal(isFinished({ guesses: [1, 2, 3, 4, null] }), false);

  const a = { guesses: [1], completedAt: null };
  const b = { guesses: [1, 2], completedAt: null };
  assert.equal(mergePuzzle(null, a), a);
  assert.deepEqual(mergePuzzle(a, b), b);
  assert.equal(mergePuzzle(b, a), b, 'nothing new keeps the stored object');
  // answers to different questions are combined; what is stored wins on a clash
  const left = { guesses: [10, null, 30], ids: ['a', 'b', 'c', 'd', 'e'], units: [null, null, 'miles'], completedAt: null };
  const right = { guesses: [11, 20, null, null, 50], ids: ['a', 'b', 'c', 'd', 'e'], completedAt: null };
  assert.deepEqual(mergePuzzle(left, right, 99), { guesses: [10, 20, 30, null, 50], ids: ['a', 'b', 'c', 'd', 'e'], units: [null, null, 'miles', null, null], completedAt: null });
  // a merge that finishes the puzzle stamps the completion time
  const done = mergePuzzle({ guesses: [1, 2, 3, 4, null], completedAt: null }, { guesses: [null, null, null, null, 5], completedAt: 77 }, 99);
  assert.equal(done.completedAt, 77);
  assert.equal(mergePuzzle({ guesses: [1, 2, 3, 4, null], completedAt: null }, { guesses: [null, null, null, null, 5], completedAt: null }, 99).completedAt, 99);
  // different question ids: the record with more answers wins outright
  const other = { guesses: [1, 2, 3], ids: ['x', 'y', 'z', 'w', 'v'], completedAt: null };
  assert.equal(mergePuzzle(left, other), other);
  assert.equal(mergePuzzle(other, left), other);
  // notes: the latest write wins, clearing included
  assert.equal(mergePuzzle({ guesses: [1], completedAt: null, notes: 'old' }, { guesses: [1], completedAt: null, notes: 'new' }).notes, 'new');
  assert.equal(mergePuzzle({ guesses: [1], completedAt: null, notes: 'old' }, { guesses: [1], completedAt: null }).notes, 'old');
  assert.equal(mergePuzzle({ guesses: [1], completedAt: null, notes: 'old' }, { guesses: [1], completedAt: null, notes: '' }).notes, '');
});

test('signup, login, me, logout and session expiry', async () => {
  const env = makeEnv();
  let r = await call(env, 'POST', '/api/signup', { body: { username: 'Fermi_Fan', password: 'estimate123' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.username, 'fermi_fan');
  assert.equal(r.body.admin, false);
  const token = r.body.token;
  assert.match(token, /^[A-Za-z0-9_-]{40,50}$/);

  r = await call(env, 'POST', '/api/signup', { body: { username: 'fermi_fan', password: 'another-pass' } });
  assert.equal(r.status, 409);
  r = await call(env, 'POST', '/api/signup', { body: { username: 'short', password: 'tiny' } });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/signup', { body: { username: 'bad name', password: 'estimate123' } });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/signup', { body: { username: 'owner', password: 'estimate123' } });
  assert.equal(r.status, 409, 'the owner username is reserved');

  r = await call(env, 'GET', '/api/me', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.username, 'fermi_fan');
  assert.equal(r.body.admin, false);

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

test('puzzles merge: answers combine, junk is dropped, other users are isolated', async () => {
  const env = makeEnv();
  const a = await signupUser(env, 'alice');
  const b = await signupUser(env, 'bob_b');

  let r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [10, 20] }, 2: { guesses: [5, 5, 5, 5, 5], ids: ['x', 'y', 'z', 'w', 'v'], completedAt: 123 }, junk: { guesses: [1] }, 0: { guesses: [1] }, 3: 'nope' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.puzzles).sort(), ['1', '2']);

  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [99] }, 2: { guesses: [1, 2, 3, 4, 5] } } } });
  assert.deepEqual(r.body.puzzles[1].guesses, [10, 20], 'a stored answer is never overwritten');
  assert.deepEqual(r.body.puzzles[2].guesses, [5, 5, 5, 5, 5]);

  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [null, null, 30] } } } });
  assert.deepEqual(r.body.puzzles[1].guesses, [10, 20, 30], 'an answer to another question is added');
  r = await call(env, 'PUT', '/api/puzzles', { token: a, body: { puzzles: { 1: { guesses: [10, 20, 30], notes: 'working: 365 * 24' } } } });
  assert.equal(r.body.puzzles[1].notes, 'working: 365 * 24');

  r = await call(env, 'GET', '/api/puzzles', { token: a });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.puzzles).sort(), ['1', '2']);
  assert.equal(r.body.puzzles[2].completedAt, 123);
  assert.equal(r.body.puzzles[1].notes, 'working: 365 * 24');

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
  await signupUser(env, 'carol');
  let last;
  for (let i = 0; i < 10; i++) last = await call(env, 'POST', '/api/login', { body: { username: 'carol', password: 'wrong-password' }, ip: `10.0.0.${i}` });
  assert.equal(last.status, 401);
  last = await call(env, 'POST', '/api/login', { body: { username: 'carol', password: 'estimate123' }, ip: '10.0.0.99' });
  assert.equal(last.status, 429, 'per-username limit holds even with the right password');
  // another user from the same IP is still fine
  await signupUser(env, 'dave_d', '10.0.0.99');
  last = await call(env, 'POST', '/api/login', { body: { username: 'dave_d', password: 'estimate123' }, ip: '10.0.0.99' });
  assert.equal(last.status, 200);
  // signups per IP are limited too
  for (let i = 0; i < 10; i++) await signupUser(env, `spam_${i}`, '9.9.9.9');
  last = await call(env, 'POST', '/api/signup', { body: { username: 'spam_x', password: 'estimate123' }, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('account deletion removes everything and needs the password', async () => {
  const env = makeEnv();
  const token = await signupUser(env, 'erin');
  await call(env, 'PUT', '/api/puzzles', { token, body: { puzzles: { 1: { guesses: [1, 2, 3, 4, 5] } } } });
  await call(env, 'POST', '/api/plays', { token, body: { mode: 'unlimited', question_id: 'q-1', guess: 5, answer: 5 } });
  await call(env, 'POST', '/api/suggestions', { token, body: { text: 'More space questions please' } });
  let r = await call(env, 'DELETE', '/api/account', { token, body: { password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await call(env, 'DELETE', '/api/account', { token, body: { password: 'estimate123' } });
  assert.equal(r.status, 204);
  for (const table of ['users', 'puzzles', 'sessions', 'plays', 'guesses', 'suggestions']) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c, 0, table);
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
  const token = await signupUser(env, 'stats_user');
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

test('scorePuzzle uses the server answers and refuses unknown or unfinished puzzles', () => {
  const perfect = scorePuzzle({ ids: REAL_IDS, guesses: exactGuesses() });
  assert.equal(perfect.score, 1);
  assert.deepEqual(perfect.multiples, [1, 1, 1, 1, 1]);
  const doubled = scorePuzzle({ ids: REAL_IDS, guesses: exactGuesses().map((a) => a * 2) });
  assert.equal(doubled.score, 2);
  assert.equal(scorePuzzle({ ids: ['nope-1', ...REAL_IDS.slice(1)], guesses: exactGuesses() }), null);
  assert.equal(scorePuzzle({ ids: REAL_IDS, guesses: [1, 2] }), null);
  assert.equal(scorePuzzle({ ids: REAL_IDS, guesses: [1, 2, null, 4, 5] }), null);
  assert.equal(scorePuzzle({ guesses: exactGuesses() }), null);
});

test('leaderboards rank finished puzzles by server-computed score', async () => {
  const env = makeEnv();
  const [alice, bob, carol] = await Promise.all([signupUser(env, 'alice'), signupUser(env, 'bob_b'), signupUser(env, 'carol')]);
  const finish = (token, n, factor) => call(env, 'PUT', '/api/puzzles', { token, body: { puzzles: { [n]: { guesses: exactGuesses().map((a) => a * factor), ids: REAL_IDS, completedAt: 5 } } } });
  await finish(alice, 1, 3);
  await finish(bob, 1, 1.5);
  await finish(carol, 1, 10);
  await finish(alice, 2, 1);
  await finish(alice, 3, 1);
  await finish(bob, 2, 4);
  // an unfinished puzzle never scores
  await call(env, 'PUT', '/api/puzzles', { token: carol, body: { puzzles: { 2: { guesses: [1, null, 3], ids: REAL_IDS } } } });

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

test('unlimited mode counts every answer; timed runs expire and rank by ballpark answers', async () => {
  const env = makeEnv();
  const [alice, bob] = await Promise.all([signupUser(env, 'alice'), signupUser(env, 'bob_b')]);
  const [q1, q2, q3] = REAL_IDS;
  const play = (token, body, extra = {}) => call(env, 'POST', '/api/plays', { token, body, ...extra });

  let r = await play(alice, { mode: 'nope', question_id: q1, guess: 1 });
  assert.equal(r.status, 400);
  r = await play(alice, { mode: 'unlimited', question_id: q1, guess: ANSWERS[q1] * 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.multiple, 2);
  assert.equal(r.body.ballpark, true);
  assert.equal(r.body.run, null);
  assert.equal(r.body.stats.count, 1, 'the answer joins the community statistics');
  r = await play(alice, { mode: 'unlimited', question_id: q2, guess: ANSWERS[q2] * 100 });
  assert.equal(r.body.ballpark, false);
  await play(bob, { mode: 'unlimited', question_id: q1, guess: ANSWERS[q1] });
  // anonymous players are counted in the community stats only
  r = await call(env, 'POST', '/api/plays', { body: { mode: 'unlimited', question_id: q1, guess: ANSWERS[q1], player: 'anon_player_0000000009' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.stats.count, 3);
  r = await call(env, 'POST', '/api/plays', { body: { mode: 'unlimited', question_id: q1, guess: ANSWERS[q1] } });
  assert.equal(r.status, 400, 'anonymous answers need a player id');

  r = await call(env, 'GET', '/api/leaderboard?scope=unlimited', { token: bob });
  assert.deepEqual(r.body.players.map((p) => [p.username, p.answered, p.ballpark, p.you]), [['alice', 2, 1, false], ['bob_b', 1, 1, true]]);
  assert.ok(Math.abs(r.body.players[0].average - 51) < 1e-9);

  // timed runs
  r = await call(env, 'POST', '/api/runs', { body: { mode: 'timed' } });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/runs', { token: alice, body: { mode: 'unlimited' } });
  assert.equal(r.status, 400);
  const t0 = 1_700_000_000_000;
  r = await call(env, 'POST', '/api/runs', { token: alice, body: { mode: 'timed' }, now: t0 });
  assert.equal(r.status, 201);
  const runId = r.body.id;
  assert.equal(r.body.durationMs, TIMED_DURATION_MS);
  r = await play(alice, { mode: 'timed', question_id: q1, guess: ANSWERS[q1] }, { now: t0 + 1000 });
  assert.equal(r.status, 400, 'timed answers need a run id');
  r = await play(alice, { mode: 'timed', run_id: runId, question_id: q1, guess: ANSWERS[q1] }, { now: t0 + 1000 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.run.answered, r.body.run.ballpark], [1, 1]);
  assert.equal(r.body.run.remainingMs, TIMED_DURATION_MS - 1000);
  r = await play(alice, { mode: 'timed', run_id: runId, question_id: q2, guess: ANSWERS[q2] * 1000 }, { now: t0 + 2000 });
  assert.deepEqual([r.body.run.answered, r.body.run.ballpark], [2, 1]);
  r = await play(bob, { mode: 'timed', run_id: runId, question_id: q3, guess: ANSWERS[q3] }, { now: t0 + 3000 });
  assert.equal(r.status, 404, 'a run belongs to one player');
  r = await play(alice, { mode: 'timed', run_id: runId, question_id: q3, guess: ANSWERS[q3] }, { now: t0 + TIMED_DURATION_MS + TIMED_GRACE_MS + 1 });
  assert.equal(r.status, 400, 'answers after the time is up are refused');
  // bob's run: two ballpark answers beats alice's one
  r = await call(env, 'POST', '/api/runs', { token: bob, body: { mode: 'timed' }, now: t0 });
  const bobRun = r.body.id;
  await play(bob, { mode: 'timed', run_id: bobRun, question_id: q1, guess: ANSWERS[q1] * 3 }, { now: t0 + 10 });
  await play(bob, { mode: 'timed', run_id: bobRun, question_id: q2, guess: ANSWERS[q2] * 3 }, { now: t0 + 20 });
  r = await call(env, 'GET', '/api/leaderboard?scope=timed', { token: alice });
  assert.deepEqual(r.body.players.map((p) => [p.username, p.ballpark, p.answered, p.you]), [['bob_b', 2, 2, false], ['alice', 1, 2, true]]);
  assert.equal(r.body.players[0].average, 3);
});

test('signing in claims the guesses and suggestions a browser made as a guest', async () => {
  const env = makeEnv();
  const anon = 'anon_player_0000000042';
  const q = REAL_IDS[0];
  await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: 10, answer: 100, player: anon } });
  await call(env, 'POST', '/api/guesses', { body: { question_id: REAL_IDS[1], guess: 10, answer: 100, player: anon } });
  await call(env, 'POST', '/api/suggestions', { body: { text: 'Questions about volcanoes please', player: anon } });
  let r = await call(env, 'POST', '/api/signup', { body: { username: 'claimer', password: 'estimate123', player: anon } });
  assert.equal(r.status, 201);
  const token = r.body.token;
  // the signed-in player already answered q as a guest, so the same guess is now theirs
  r = await call(env, 'POST', '/api/guesses', { token, body: { question_id: q, guess: 999, answer: 100 } });
  assert.equal(r.body.count, 1, 'no duplicate row for the claimed guess');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM guesses WHERE player_key LIKE 'a:%'").get().c, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM guesses WHERE player_key LIKE 'u:%'").get().c, 2);
  assert.equal(env.DB.raw.prepare("SELECT player_key FROM suggestions").get().player_key.startsWith('u:'), true);
  // signing in again from another browser with a clashing guest guess keeps the account's own
  const other = 'anon_player_0000000043';
  await call(env, 'POST', '/api/guesses', { body: { question_id: q, guess: 55, answer: 100, player: other } });
  r = await call(env, 'POST', '/api/login', { body: { username: 'claimer', password: 'estimate123', player: other } });
  assert.equal(r.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT guess FROM guesses WHERE question_id = ? AND player_key LIKE 'u:%'").get(q).guess, 10);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM guesses WHERE player_key LIKE 'a:%'").get().c, 0);
  r = await call(env, 'POST', '/api/login', { body: { username: 'claimer', password: 'estimate123', player: 'bad id!' } });
  assert.equal(r.status, 200, 'a malformed guest id is ignored');
});

test('suggestions are stored for the owner only', async () => {
  const env = makeEnv();
  const alice = await signupUser(env, 'alice');
  let r = await call(env, 'POST', '/api/suggestions', { body: { text: 'hi' , player: 'anon_player_0000000001' } });
  assert.equal(r.status, 400, 'too short');
  r = await call(env, 'POST', '/api/suggestions', { body: { text: 'How many pizzas would cover Central Park?', player: 'anon_player_0000000001' } });
  assert.equal(r.status, 201);
  r = await call(env, 'POST', '/api/suggestions', { token: alice, body: { text: 'A dark-mode icon for the share button' } });
  assert.equal(r.status, 201);
  r = await call(env, 'GET', '/api/admin/suggestions', { token: alice });
  assert.equal(r.status, 403, 'ordinary players cannot read suggestions');
  r = await call(env, 'GET', '/api/admin/suggestions', {});
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/suggestions', { body: { text: 'x'.repeat(1001), player: 'anon_player_0000000001' } });
  assert.equal(r.status, 400);
});

test('the owner login opens the admin view: players, every answer, passwords and suggestions', async () => {
  const env = makeEnv();
  const alice = await signupUser(env, 'alice');
  await call(env, 'PUT', '/api/puzzles', { token: alice, body: { puzzles: { 4: { guesses: exactGuesses().map((a) => a * 2), ids: REAL_IDS, completedAt: 5, notes: 'my working' } } } });
  await call(env, 'POST', '/api/guesses', { token: alice, body: { question_id: REAL_IDS[0], guess: ANSWERS[REAL_IDS[0]] * 2 } });
  await call(env, 'POST', '/api/guesses', { body: { question_id: REAL_IDS[0], guess: ANSWERS[REAL_IDS[0]] * 5, player: 'anon_player_0000000001' } });
  await call(env, 'POST', '/api/plays', { token: alice, body: { mode: 'unlimited', question_id: REAL_IDS[1], guess: ANSWERS[REAL_IDS[1]] } });
  await call(env, 'POST', '/api/suggestions', { token: alice, body: { text: 'More animals please' } });

  let r = await call(env, 'POST', '/api/login', { body: { username: 'owner', password: 'not-the-key-at-all' } });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/login', { body: { username: 'owner', password: OWNER_KEY } });
  assert.equal(r.status, 200);
  assert.equal(r.body.admin, true);
  const owner = r.body.token;
  r = await call(env, 'POST', '/api/login', { body: { username: 'owner', password: OWNER_KEY }, ip: '2.2.2.2' });
  assert.equal(r.status, 200, 'the owner can sign in again');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'owner'").get().c, 1);
  const noKey = { ...makeEnv(), ADMIN_KEY_HASH: '' };
  r = await call(noKey, 'POST', '/api/login', { body: { username: 'owner', password: OWNER_KEY } });
  assert.equal(r.status, 401, 'no owner login without a configured key');

  r = await call(env, 'GET', '/api/admin/players', { token: alice });
  assert.equal(r.status, 403);
  r = await call(env, 'GET', '/api/admin/players', { token: owner });
  assert.equal(r.status, 200);
  const aliceRow = r.body.players.find((p) => p.username === 'alice');
  assert.equal(aliceRow.played, 1);
  assert.equal(aliceRow.average, 2);
  assert.equal(aliceRow.answers, 2, 'the daily guess and the unlimited answer both count');
  assert.equal(aliceRow.unlimited, 1);
  assert.equal(aliceRow.admin, false);
  assert.ok(typeof aliceRow.lastActive === 'number');
  assert.equal(r.body.players.find((p) => p.username === 'owner').admin, true);
  assert.ok(!('pw_hash' in aliceRow) && !('password' in aliceRow), 'no password material is ever returned');

  r = await call(env, 'GET', `/api/admin/answers?user=${aliceRow.id}`, { token: owner });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'alice');
  assert.equal(r.body.puzzles.length, 1);
  assert.equal(r.body.puzzles[0].n, 4);
  assert.deepEqual(r.body.puzzles[0].multiples, [2, 2, 2, 2, 2]);
  assert.equal(r.body.puzzles[0].notes, 'my working');
  assert.deepEqual(r.body.plays.map((p) => [p.mode, p.questionId, p.multiple]), [['unlimited', REAL_IDS[1], 1]]);
  assert.deepEqual(r.body.guesses.map((g) => g.questionId).sort(), [REAL_IDS[0], REAL_IDS[1]].sort());
  r = await call(env, 'GET', '/api/admin/answers?user=999', { token: owner });
  assert.equal(r.status, 404);

  r = await call(env, 'GET', `/api/admin/answers?question_ids=${REAL_IDS[0]},${REAL_IDS[1]}`, { token: owner });
  assert.equal(r.status, 200);
  const key = (g) => `${g.questionId}|${g.username}|${g.guest}`;
  assert.deepEqual(r.body.guesses.map(key).sort(), [[REAL_IDS[0], 'alice', null], [REAL_IDS[0], null, 'anon_p'], [REAL_IDS[1], 'alice', null]].map(([questionId, username, guest]) => key({ questionId, username, guest })).sort());
  r = await call(env, 'GET', '/api/admin/answers', { token: owner });
  assert.equal(r.status, 400);

  r = await call(env, 'GET', '/api/admin/suggestions', { token: owner });
  assert.deepEqual(r.body.suggestions.map((s) => [s.text, s.username, s.done]), [['More animals please', 'alice', false]]);
  const sid = r.body.suggestions[0].id;
  r = await call(env, 'POST', '/api/admin/suggestion', { token: owner, body: { id: sid, done: true } });
  assert.equal(r.status, 204);
  r = await call(env, 'GET', '/api/admin/suggestions', { token: owner });
  assert.equal(r.body.suggestions[0].done, true);
  r = await call(env, 'POST', '/api/admin/suggestion', { token: owner, body: { id: sid, delete: true } });
  assert.equal(r.status, 204);
  r = await call(env, 'GET', '/api/admin/suggestions', { token: owner });
  assert.equal(r.body.suggestions.length, 0);

  // the owner can set a player's password, which signs that player out everywhere
  r = await call(env, 'POST', '/api/admin/password', { token: alice, body: { user_id: aliceRow.id, password: 'newpassword1' } });
  assert.equal(r.status, 403);
  r = await call(env, 'POST', '/api/admin/password', { token: owner, body: { user_id: aliceRow.id, password: 'short' } });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/admin/password', { token: owner, body: { user_id: aliceRow.id, password: 'newpassword1' } });
  assert.equal(r.status, 204);
  r = await call(env, 'GET', '/api/me', { token: alice });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/login', { body: { username: 'alice', password: 'estimate123' } });
  assert.equal(r.status, 401);
  r = await call(env, 'POST', '/api/login', { body: { username: 'alice', password: 'newpassword1' } });
  assert.equal(r.status, 200);
  r = await call(env, 'POST', '/api/admin/password', { token: owner, body: { user_id: 999, password: 'newpassword1' } });
  assert.equal(r.status, 404);
});
