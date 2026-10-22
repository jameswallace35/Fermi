// Fermi accounts API: a Cloudflare Worker backed by a D1 (SQLite) database.
//
// Sessions are bearer tokens (random, stored hashed), so the game page can
// call this from any origin without cookies. Passwords are hashed with
// PBKDF2-SHA256 and a per-user salt via WebCrypto.
//
// Endpoints (JSON in and out):
//   GET    /api/health                                   -> { ok: true }
//   POST   /api/signup   { username, password }          -> 201 { token, username }
//   POST   /api/login    { username, password }          -> 200 { token, username }
//   POST   /api/logout   (Bearer)                        -> 204
//   GET    /api/me       (Bearer)                        -> { username, createdAt }
//   GET    /api/puzzles  (Bearer)                        -> { puzzles: { [n]: state } }
//   PUT    /api/puzzles  (Bearer) { puzzles: {...} }     -> { puzzles: merged }
//   DELETE /api/account  (Bearer) { password }           -> 204

export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const QUESTIONS_PER_DAY = 5;

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 256 * 1024;
const MAX_PUZZLES_PER_REQUEST = 500;
const MAX_PUZZLE_NUMBER = 100000;
const DEFAULT_ITERATIONS = 100000;
const LOGIN_LIMIT_PER_IP = 30;
const LOGIN_LIMIT_PER_USER = 10;
const SIGNUP_LIMIT_PER_IP = 10;
const LIMIT_WINDOW_MS = 15 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const enc = new TextEncoder();

// --------------------------------------------------------------- encoding

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two strings without leaking where they differ. */
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
  return diff === 0;
}

// --------------------------------------------------------------- passwords

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

export async function createPasswordRecord(password, iterations = DEFAULT_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return { pw_hash: await pbkdf2(password, salt, iterations), pw_salt: bytesToBase64(salt), pw_iterations: iterations };
}

export async function verifyPassword(password, record) {
  if (!record || typeof record.pw_hash !== 'string' || typeof record.pw_salt !== 'string') return false;
  const hash = await pbkdf2(password, base64ToBytes(record.pw_salt), Number(record.pw_iterations) || DEFAULT_ITERATIONS);
  return timingSafeEqual(hash, record.pw_hash);
}

// -------------------------------------------------------------- validation

export function validateUsername(raw) {
  const u = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new HttpError(400, 'Username must be 3-24 characters: letters, numbers and underscores');
  return u;
}

export function validatePassword(raw) {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN) throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters`);
  if (raw.length > PASSWORD_MAX) throw new HttpError(400, `Password must be at most ${PASSWORD_MAX} characters`);
  return raw;
}

/** Same rules as the game's storage: returns a clean puzzle state or null. */
export function sanitizePuzzle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.guesses)) return null;
  const guesses = raw.guesses;
  if (!guesses.length || guesses.length > QUESTIONS_PER_DAY) return null;
  if (!guesses.every((g) => typeof g === 'number' && Number.isFinite(g) && g > 0)) return null;
  const state = { guesses: guesses.slice(), completedAt: typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) ? raw.completedAt : null };
  if (Array.isArray(raw.ids) && raw.ids.length <= QUESTIONS_PER_DAY && raw.ids.every((id) => typeof id === 'string' && id.length <= 64)) state.ids = raw.ids.slice();
  if (Array.isArray(raw.units) && raw.units.length <= QUESTIONS_PER_DAY) state.units = raw.units.map((u) => (typeof u === 'string' && u.length <= 32 ? u : null));
  return state;
}

/** The record with more guesses wins; ties keep what is stored. */
export function mergePuzzle(existing, incoming) {
  if (!existing) return incoming;
  return incoming.guesses.length > existing.guesses.length ? incoming : existing;
}

// ------------------------------------------------------------------- http

function json(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const headers = {
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (!origin) return headers;
  if (allowed.includes('*') || allowed.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON with content-type: application/json');
  const length = Number(request.headers.get('content-length') || 0);
  if (length > BODY_LIMIT) throw new HttpError(413, 'Request body too large');
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new HttpError(413, 'Request body too large');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
}

// --------------------------------------------------------------- database

async function rateLimit(env, key, limit, now) {
  const row = await env.DB.prepare('SELECT count, reset_at FROM attempts WHERE key = ?').bind(key).first();
  if (!row || row.reset_at <= now) {
    await env.DB.prepare('INSERT OR REPLACE INTO attempts (key, count, reset_at) VALUES (?, 1, ?)').bind(key, now + LIMIT_WINDOW_MS).run();
    return;
  }
  if (row.count >= limit) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  await env.DB.prepare('UPDATE attempts SET count = count + 1 WHERE key = ?').bind(key).run();
}

async function issueSession(env, userId, now) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

async function requireSession(env, request, now) {
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(auth);
  if (!m) throw new HttpError(401, 'Sign in to continue');
  const tokenHash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    'SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username AS username, u.created_at AS createdAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  )
    .bind(tokenHash)
    .first();
  if (!row || row.expiresAt <= now) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  return { userId: row.userId, username: row.username, createdAt: row.createdAt, tokenHash };
}

async function loadPuzzles(env, userId) {
  const { results } = await env.DB.prepare('SELECT n, data FROM puzzles WHERE user_id = ?').bind(userId).all();
  const puzzles = {};
  for (const row of results || []) {
    try {
      const state = sanitizePuzzle(JSON.parse(row.data));
      if (state) puzzles[row.n] = state;
    } catch {
      // ignore a corrupt row
    }
  }
  return puzzles;
}

// ---------------------------------------------------------------- handlers

async function signup(request, env, now) {
  const body = await readJson(request);
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);
  await rateLimit(env, `signup:${clientIp(request)}`, SIGNUP_LIMIT_PER_IP, now);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) throw new HttpError(409, 'That username is taken');
  const iterations = Math.max(10000, Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS);
  const record = await createPasswordRecord(password, iterations);
  const result = await env.DB.prepare('INSERT INTO users (username, pw_hash, pw_salt, pw_iterations, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(username, record.pw_hash, record.pw_salt, record.pw_iterations, now)
    .run();
  const userId = result.meta?.last_row_id ?? (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()).id;
  const token = await issueSession(env, userId, now);
  return json({ token, username }, 201);
}

async function login(request, env, now) {
  const body = await readJson(request);
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);
  await rateLimit(env, `login:ip:${clientIp(request)}`, LOGIN_LIMIT_PER_IP, now);
  await rateLimit(env, `login:user:${username}`, LOGIN_LIMIT_PER_USER, now);
  const user = await env.DB.prepare('SELECT id, pw_hash, pw_salt, pw_iterations FROM users WHERE username = ?').bind(username).first();
  // Verify against a dummy record when the user is unknown so timing does not reveal which usernames exist.
  const ok = user ? await verifyPassword(password, user) : (await verifyPassword(password, DUMMY_RECORD), false);
  if (!ok) throw new HttpError(401, 'Wrong username or password');
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  const token = await issueSession(env, user.id, now);
  return json({ token, username }, 200);
}

const DUMMY_RECORD = { pw_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', pw_salt: 'AAAAAAAAAAAAAAAAAAAAAA==', pw_iterations: DEFAULT_ITERATIONS };

async function logout(request, env, now) {
  const session = await requireSession(env, request, now);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
  return json(null, 204);
}

async function me(request, env, now) {
  const session = await requireSession(env, request, now);
  return json({ username: session.username, createdAt: session.createdAt });
}

async function getPuzzles(request, env, now) {
  const session = await requireSession(env, request, now);
  return json({ puzzles: await loadPuzzles(env, session.userId) });
}

async function putPuzzles(request, env, now) {
  const session = await requireSession(env, request, now);
  const body = await readJson(request);
  if (!body.puzzles || typeof body.puzzles !== 'object' || Array.isArray(body.puzzles)) throw new HttpError(400, 'Send { puzzles: { [n]: state } }');
  const entries = Object.entries(body.puzzles);
  if (entries.length > MAX_PUZZLES_PER_REQUEST) throw new HttpError(413, `At most ${MAX_PUZZLES_PER_REQUEST} puzzles per request`);
  const stored = await loadPuzzles(env, session.userId);
  const writes = [];
  for (const [key, raw] of entries) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PUZZLE_NUMBER) continue;
    const incoming = sanitizePuzzle(raw);
    if (!incoming) continue;
    const merged = mergePuzzle(stored[n], incoming);
    if (merged !== stored[n]) {
      stored[n] = merged;
      writes.push(
        env.DB.prepare('INSERT OR REPLACE INTO puzzles (user_id, n, data, updated_at) VALUES (?, ?, ?, ?)').bind(session.userId, n, JSON.stringify(merged), now),
      );
    }
  }
  if (writes.length) await env.DB.batch(writes);
  return json({ puzzles: stored });
}

async function deleteAccount(request, env, now) {
  const session = await requireSession(env, request, now);
  const body = await readJson(request);
  const user = await env.DB.prepare('SELECT id, pw_hash, pw_salt, pw_iterations FROM users WHERE id = ?').bind(session.userId).first();
  if (!user || !(await verifyPassword(String(body.password ?? ''), user))) throw new HttpError(401, 'Wrong password');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM puzzles WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json(null, 204);
}

const ROUTES = [
  ['GET', '/api/health', async () => json({ ok: true })],
  ['POST', '/api/signup', signup],
  ['POST', '/api/login', login],
  ['POST', '/api/logout', logout],
  ['GET', '/api/me', me],
  ['GET', '/api/puzzles', getPuzzles],
  ['PUT', '/api/puzzles', putPuzzles],
  ['DELETE', '/api/account', deleteAccount],
];

export async function handle(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const route = ROUTES.find(([method, path]) => method === request.method && path === url.pathname);
  if (!route) {
    const known = ROUTES.some(([, path]) => path === url.pathname);
    throw new HttpError(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
  }
  return route[2](request, env, now);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) response = json({ error: err.message }, err.status);
      else {
        console.error(err);
        response = json({ error: 'Something went wrong on the server' }, 500);
      }
    }
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },
};
