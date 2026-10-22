// Ballpark accounts API: a Cloudflare Worker backed by a D1 (SQLite) database.
//
// Sessions are bearer tokens (random, stored hashed), so the game page can
// call this from any origin without cookies. Passwords are hashed with
// PBKDF2-SHA256 and a per-user salt via WebCrypto; they are never stored or
// shown in clear, not even to the game's owner.
//
// Endpoints (JSON in and out):
//   GET    /api/health                                    -> { ok: true }
//   POST   /api/signup   { username, password, player? }  -> 201 { token, username, admin }
//   POST   /api/login    { username, password, player? }  -> 200 { token, username, admin }
//            player is the browser's anonymous id: guesses and suggestions made before
//            signing in are re-attributed to the account.
//            Signing in as the reserved username "owner" with the owner key (ADMIN_KEY_HASH in
//            wrangler.toml holds its SHA-256) creates or opens the owner account, admin: true.
//   POST   /api/logout   (Bearer)                         -> 204
//   GET    /api/me       (Bearer)                         -> { username, createdAt, admin }
//   GET    /api/puzzles  (Bearer)                         -> { puzzles: { [n]: state } }
//   PUT    /api/puzzles  (Bearer) { puzzles: {...} }      -> { puzzles: merged }
//   DELETE /api/account  (Bearer) { password }            -> 204
//   POST   /api/guesses  { question_id, guess, answer, player? } (Bearer optional)
//                                                         -> stats for that question, including you
//   GET    /api/stats?question_id=..&answer=..&guess=..   -> stats for that question
//   POST   /api/runs     (Bearer) { mode: 'timed' }       -> 201 { id, startedAt, durationMs }
//   POST   /api/plays    { mode, run_id?, question_id, guess, answer?, player? } (Bearer optional)
//                                                         -> { multiple, ballpark, run, stats }
//   POST   /api/suggestions { text, player? } (Bearer optional) -> 201 { ok: true }
//   GET    /api/seen     (Bearer)                         -> { ids: [...] } every question the account has answered
//   GET    /api/leaderboard?n=<puzzle>  (Bearer)          -> players who finished puzzle n, best first
//   GET    /api/leaderboard?scope=all   (Bearer)          -> all-time standings
//   GET    /api/leaderboard?scope=unlimited | timed       -> unlimited-mode and timed-mode standings
//   Owner only (the "owner" login):
//   GET    /api/admin/players                             -> every account with totals
//   GET    /api/admin/answers?user=<id>                   -> one player's every answer
//   GET    /api/admin/answers?question_ids=a,b,c          -> everyone's answers to those questions
//   POST   /api/admin/password { user_id, password }      -> 204 (sets a player's password)
//   GET    /api/admin/suggestions                         -> every suggestion sent in
//   POST   /api/admin/suggestion { id, done? , delete? }  -> 204

import bank from './bank.js';

export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const OWNER_USERNAME = 'owner';
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const QUESTIONS_PER_DAY = 5;
export const NOTES_MAX = 4000;
export const SUGGESTION_MAX = 1000;
export const TIMED_DURATION_MS = 5 * 60 * 1000;
export const TIMED_GRACE_MS = 20 * 1000;
export const BALLPARK_MAX = 10;
export const ANSWERS = bank.answers || {};
const MAX_MULTIPLE = 1e15;
const RANKED_MIN_PLAYED = 3;
const BOARD_LIMIT = 100;

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 256 * 1024;
const MAX_PUZZLES_PER_REQUEST = 500;
const MAX_PUZZLE_NUMBER = 100000;
const DEFAULT_ITERATIONS = 100000;
const GUESS_LIMIT_PER_IP = 200;
const PLAY_LIMIT_PER_IP = 600;
const SUGGEST_LIMIT_PER_IP = 10;
const STATS_SAMPLE = 5000;
const QUESTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ANON_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LOGIN_LIMIT_PER_IP = 30;
const LOGIN_LIMIT_PER_USER = 10;
const SIGNUP_LIMIT_PER_IP = 10;
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LIST_LIMIT = 2000;
const ADMIN_ROWS_LIMIT = 2000;
const ADMIN_QUESTIONS_MAX = 10;
const RUN_LIMIT_PER_USER = 60;
const PUZZLE_WRITE_LIMIT_PER_USER = 300;
const MAX_PLAYS_PER_RUN = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_DAY = Date.UTC(2026, 9, 21) / DAY_MS; // puzzle No. 1, as EPOCH_DATE_KEY in src/logic.js

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

/** Number of questions answered in a puzzle state (questions can be answered in any order, so gaps are null). */
export function answeredCount(state) {
  return state && Array.isArray(state.guesses) ? state.guesses.filter((g) => g !== null && g !== undefined).length : 0;
}

export function isFinished(state) {
  return !!state && Array.isArray(state.guesses) && state.guesses.length === QUESTIONS_PER_DAY && answeredCount(state) === QUESTIONS_PER_DAY;
}

/**
 * Same rules as the game's storage: returns a clean puzzle state or null.
 * `guesses` holds a positive number per answered question and null for a
 * question not answered yet; trailing nulls are dropped.
 */
export function sanitizePuzzle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.guesses)) return null;
  if (raw.guesses.length > QUESTIONS_PER_DAY) return null;
  const guesses = [];
  for (const g of raw.guesses) {
    if (g === null || g === undefined) guesses.push(null);
    else if (typeof g === 'number' && Number.isFinite(g) && g > 0) guesses.push(g);
    else return null;
  }
  while (guesses.length && guesses[guesses.length - 1] === null) guesses.pop();
  const notesAt = typeof raw.notesAt === 'number' && Number.isFinite(raw.notesAt) && raw.notesAt > 0 ? raw.notesAt : null;
  // Notes travel with the record even before any answer; cleared notes keep
  // the time of the clearing so an older copy elsewhere cannot bring them back.
  const hasNotes = typeof raw.notes === 'string' && (raw.notes !== '' || notesAt !== null);
  if (!guesses.some((g) => g !== null) && !hasNotes) return null;
  const state = { guesses, completedAt: typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) ? raw.completedAt : null };
  if (Array.isArray(raw.ids) && raw.ids.length <= QUESTIONS_PER_DAY && raw.ids.every((id) => typeof id === 'string' && id.length <= 64)) state.ids = raw.ids.slice();
  if (Array.isArray(raw.units) && raw.units.length <= QUESTIONS_PER_DAY) state.units = raw.units.map((u) => (typeof u === 'string' && u.length <= 32 ? u : null));
  if (hasNotes) {
    state.notes = raw.notes.slice(0, NOTES_MAX);
    if (notesAt !== null) state.notesAt = notesAt;
  }
  return state;
}

export function validateQuestionId(raw) {
  const id = String(raw ?? '').trim();
  if (!QUESTION_ID_RE.test(id)) throw new HttpError(400, 'Invalid question id');
  return id;
}

/** The highest puzzle number a client can be playing: today's in UTC, plus two days of slack for time zones and clocks ahead of it. */
export function maxPuzzleNumber(now) {
  return Math.max(1, Math.floor(now / DAY_MS) - EPOCH_DAY + 3);
}

function positiveNumber(raw, what) {
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, `${what} must be a positive number`);
  return v;
}

/**
 * Community statistics for one question, from every stored guess. Everything
 * is measured in decades (log10) relative to the answer, so a guess ten times
 * too high and one ten times too low are the same distance off.
 *   count      players who answered
 *   typical    geometric mean of the guesses, in the question's unit
 *   median     median guess
 *   histogram  12 buckets of half a decade from 1/1000 to 1000 times the answer (outliers folded into the ends)
 *   within2x   share of players within 2x of the answer
 *   beat       share of the OTHER players who were further off than `mine` (null without `mine`)
 */
export function computeStats(guesses, answer, mine = null) {
  const logs = guesses.map((g) => Math.log10(g / answer)).filter((l) => Number.isFinite(l));
  const count = logs.length;
  const RANGE = 3;
  const WIDTH = 0.5;
  const BUCKETS = (RANGE * 2) / WIDTH;
  const histogram = new Array(BUCKETS).fill(0);
  if (!count) return { count: 0, typical: null, median: null, histogram, bucketWidth: WIDTH, range: RANGE, within2x: null, beat: null };
  const sorted = [...logs].sort((a, b) => a - b);
  const mean = logs.reduce((a, b) => a + b, 0) / count;
  const mid = count / 2;
  const medianLog = count % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
  for (const l of logs) histogram[Math.max(0, Math.min(BUCKETS - 1, Math.floor((l + RANGE) / WIDTH)))] += 1;
  const within2x = logs.filter((l) => Math.abs(l) <= Math.log10(2) + 1e-12).length / count;
  let beat = null;
  if (mine !== null && mine > 0) {
    const d = Math.abs(Math.log10(mine / answer));
    // Compare against the other players: drop one entry matching the caller's own guess.
    const others = [...logs];
    const self = others.findIndex((l) => Math.abs(l - Math.log10(mine / answer)) < 1e-9);
    if (self >= 0) others.splice(self, 1);
    beat = others.length ? others.filter((l) => Math.abs(l) > d + 1e-9).length / others.length : null;
  }
  return { count, typical: answer * 10 ** mean, median: answer * 10 ** medianLog, histogram, bucketWidth: WIDTH, range: RANGE, within2x, beat };
}

/** How many times off a guess is, mirroring the game's scoring. */
export function scoreMultiple(guess, answer) {
  if (!Number.isFinite(guess) || !Number.isFinite(answer) || guess <= 0 || answer <= 0) return MAX_MULTIPLE;
  const ratio = Math.max(guess / answer, answer / guess);
  return Number.isFinite(ratio) ? Math.min(Number(ratio.toPrecision(12)), MAX_MULTIPLE) : MAX_MULTIPLE;
}

/**
 * Score a finished puzzle from the server's own answers. Returns null when the
 * puzzle is unfinished or any question id is unknown.
 */
export function scorePuzzle(state, answers = ANSWERS) {
  if (!state || !Array.isArray(state.ids) || !Array.isArray(state.guesses)) return null;
  if (state.ids.length !== QUESTIONS_PER_DAY || !isFinished(state)) return null;
  const multiples = [];
  for (let i = 0; i < QUESTIONS_PER_DAY; i++) {
    const answer = answers[state.ids[i]];
    if (!(answer > 0)) return null;
    multiples.push(scoreMultiple(state.guesses[i], answer));
  }
  return { score: multiples.reduce((a, b) => a + b, 0) / multiples.length, multiples };
}

function sameIds(a, b) {
  if (!a || !b) return true; // a record without ids is trusted to be the same puzzle
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Merge two records of the same puzzle. Answers are combined question by
 * question (what is stored wins where both answered the same question), the
 * latest notes win, and a record whose question ids differ is replaced only
 * by one with more answers. Returns `existing` itself when nothing changes.
 */
export function mergePuzzle(existing, incoming, now = Date.now()) {
  if (!existing) return incoming;
  if (!sameIds(existing.ids, incoming.ids)) return answeredCount(incoming) > answeredCount(existing) ? incoming : existing;
  const len = Math.max(existing.guesses.length, incoming.guesses.length);
  const guesses = [];
  const units = [];
  for (let i = 0; i < len; i++) {
    const e = existing.guesses[i] ?? null;
    const inc = incoming.guesses[i] ?? null;
    guesses.push(e !== null ? e : inc);
    units.push(e !== null ? (existing.units || [])[i] ?? null : (incoming.units || [])[i] ?? null);
  }
  const merged = { ...existing, guesses };
  if (units.some((u) => u !== null)) merged.units = units;
  else delete merged.units;
  if (!merged.ids && incoming.ids) merged.ids = incoming.ids.slice();
  if (merged.completedAt == null && isFinished(merged)) merged.completedAt = typeof incoming.completedAt === 'number' ? incoming.completedAt : now;
  mergeNotes(merged, existing, incoming);
  return JSON.stringify(merged) === JSON.stringify(existing) ? existing : merged;
}

/**
 * Notes: the later edit wins (by notesAt), clearing included. Without
 * timestamps on either side the incoming text wins, as it always did.
 */
function mergeNotes(merged, existing, incoming) {
  if (typeof incoming.notes !== 'string') return;
  const eAt = typeof existing.notesAt === 'number' ? existing.notesAt : 0;
  const iAt = typeof incoming.notesAt === 'number' ? incoming.notesAt : 0;
  if (typeof existing.notes === 'string' && iAt < eAt) return;
  if (iAt === eAt && incoming.notes === (existing.notes ?? '')) return;
  merged.notes = incoming.notes;
  if (iAt) merged.notesAt = iAt;
  else delete merged.notesAt;
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

/** Counts one attempt against `key` in a single statement, so concurrent requests cannot slip past the limit together. */
async function rateLimit(env, key, limit, now) {
  const count = await env.DB.prepare(
    'INSERT INTO attempts (key, count, reset_at) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN attempts.reset_at <= ?3 THEN 1 ELSE attempts.count + 1 END, reset_at = CASE WHEN attempts.reset_at <= ?3 THEN ?2 ELSE attempts.reset_at END RETURNING count',
  )
    .bind(key, now + LIMIT_WINDOW_MS, now)
    .first('count');
  if (Number(count) > limit) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

/** Guesses and suggestions a browser made anonymously now belong to the account it signed in to. */
async function claimAnonymous(env, userId, player) {
  const anon = String(player ?? '').trim();
  if (!ANON_ID_RE.test(anon)) return;
  await env.DB.batch([
    env.DB.prepare('UPDATE OR IGNORE guesses SET player_key = ? WHERE player_key = ?').bind(`u:${userId}`, `a:${anon}`),
    env.DB.prepare('DELETE FROM guesses WHERE player_key = ?').bind(`a:${anon}`),
    env.DB.prepare('UPDATE suggestions SET player_key = ? WHERE player_key = ?').bind(`u:${userId}`, `a:${anon}`),
  ]);
}

async function issueSession(env, userId, now) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

/**
 * The owner key, whose SHA-256 is ADMIN_KEY_HASH in wrangler.toml, is the
 * password of the reserved "owner" login that opens the admin view.
 */
export async function isOwnerKey(env, key) {
  const want = String(env.ADMIN_KEY_HASH || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want) || typeof key !== 'string' || !key.trim()) return false;
  return timingSafeEqual(await sha256Hex(key.trim()), want);
}

async function requireSession(env, request, now) {
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(auth);
  if (!m) throw new HttpError(401, 'Sign in to continue');
  const tokenHash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    'SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username AS username, u.is_admin AS isAdmin, u.created_at AS createdAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  )
    .bind(tokenHash)
    .first();
  if (!row || row.expiresAt <= now) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  return { userId: row.userId, username: row.username, createdAt: row.createdAt, tokenHash, admin: row.isAdmin === 1 };
}

async function requireAdmin(env, request, now) {
  const session = await requireSession(env, request, now);
  if (!session.admin) throw new HttpError(403, 'Only the game owner can do that');
  return session;
}

async function loadPuzzles(env, userId, { backfill = false, now = Date.now() } = {}) {
  const { results } = await env.DB.prepare('SELECT n, data, score FROM puzzles WHERE user_id = ?').bind(userId).all();
  const puzzles = {};
  const fixes = [];
  for (const row of results || []) {
    try {
      const state = sanitizePuzzle(JSON.parse(row.data));
      if (!state) continue;
      puzzles[row.n] = state;
      if (backfill && row.score == null) {
        const scored = scorePuzzle(state);
        if (scored) fixes.push(env.DB.prepare('UPDATE puzzles SET score = ? WHERE user_id = ? AND n = ?').bind(scored.score, userId, row.n));
      }
    } catch {
      // ignore a corrupt row
    }
  }
  if (fixes.length) await env.DB.batch(fixes);
  return puzzles;
}

// ---------------------------------------------------------------- handlers

async function signup(request, env, now) {
  const body = await readJson(request);
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);
  await rateLimit(env, `signup:${clientIp(request)}`, SIGNUP_LIMIT_PER_IP, now);
  if (username === OWNER_USERNAME) throw new HttpError(409, 'That username is reserved');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) throw new HttpError(409, 'That username is taken');
  const iterations = Math.max(10000, Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS);
  const record = await createPasswordRecord(password, iterations);
  const result = await env.DB.prepare('INSERT INTO users (username, pw_hash, pw_salt, pw_iterations, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(username, record.pw_hash, record.pw_salt, record.pw_iterations, now)
    .run();
  const userId = result.meta?.last_row_id ?? (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()).id;
  await claimAnonymous(env, userId, body.player);
  const token = await issueSession(env, userId, now);
  return json({ token, username, admin: false }, 201);
}

async function login(request, env, now) {
  const body = await readJson(request);
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);
  await rateLimit(env, `login:ip:${clientIp(request)}`, LOGIN_LIMIT_PER_IP, now);
  await rateLimit(env, `login:user:${username}`, LOGIN_LIMIT_PER_USER, now);
  if (username === OWNER_USERNAME) return ownerLogin(env, password, now);
  const user = await env.DB.prepare('SELECT id, username, is_admin AS isAdmin, pw_hash, pw_salt, pw_iterations FROM users WHERE username = ?').bind(username).first();
  // Verify against a dummy record when the user is unknown so timing does not reveal which accounts exist.
  const ok = user ? await verifyPassword(password, user) : (await verifyPassword(password, DUMMY_RECORD), false);
  if (!ok) throw new HttpError(401, 'Wrong username or password');
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await claimAnonymous(env, user.id, body.player);
  const token = await issueSession(env, user.id, now);
  return json({ token, username: user.username, admin: user.isAdmin === 1 }, 200);
}

const DUMMY_RECORD = { pw_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', pw_salt: 'AAAAAAAAAAAAAAAAAAAAAA==', pw_iterations: DEFAULT_ITERATIONS };

async function logout(request, env, now) {
  const session = await requireSession(env, request, now);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
  return json(null, 204);
}

async function me(request, env, now) {
  const session = await requireSession(env, request, now);
  return json({ username: session.username, createdAt: session.createdAt, admin: session.admin });
}

/** The special owner login: the reserved username with the owner key as its password. */
async function ownerLogin(env, password, now) {
  if (!(await isOwnerKey(env, password))) throw new HttpError(401, 'Wrong username or password');
  const iterations = Math.max(10000, Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS);
  let user = await env.DB.prepare('SELECT id, is_admin AS isAdmin FROM users WHERE username = ?').bind(OWNER_USERNAME).first();
  if (!user) {
    const record = await createPasswordRecord(password, iterations);
    const result = await env.DB.prepare('INSERT INTO users (username, pw_hash, pw_salt, pw_iterations, created_at, is_admin) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(OWNER_USERNAME, record.pw_hash, record.pw_salt, record.pw_iterations, now)
      .run();
    user = { id: result.meta?.last_row_id ?? (await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(OWNER_USERNAME).first()).id };
  } else if (user.isAdmin !== 1) {
    // "owner" was registered as an ordinary account before the name was
    // reserved. The key is the proof of ownership, so the account becomes the
    // owner's: whoever held it is signed out everywhere and their password
    // stops working, before any session with admin rights is issued.
    const record = await createPasswordRecord(password, iterations);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.DB.prepare('UPDATE users SET is_admin = 1, pw_hash = ?, pw_salt = ?, pw_iterations = ? WHERE id = ?').bind(record.pw_hash, record.pw_salt, record.pw_iterations, user.id),
    ]);
  }
  const token = await issueSession(env, user.id, now);
  return json({ token, username: OWNER_USERNAME, admin: true }, 200);
}

async function getPuzzles(request, env, now) {
  const session = await requireSession(env, request, now);
  return json({ puzzles: await loadPuzzles(env, session.userId, { backfill: true, now }) });
}

async function putPuzzles(request, env, now) {
  const session = await requireSession(env, request, now);
  const body = await readJson(request);
  if (!body.puzzles || typeof body.puzzles !== 'object' || Array.isArray(body.puzzles)) throw new HttpError(400, 'Send { puzzles: { [n]: state } }');
  const entries = Object.entries(body.puzzles);
  if (entries.length > MAX_PUZZLES_PER_REQUEST) throw new HttpError(413, `At most ${MAX_PUZZLES_PER_REQUEST} puzzles per request`);
  await rateLimit(env, `puzzles:${session.userId}`, PUZZLE_WRITE_LIMIT_PER_USER, now);
  const stored = await loadPuzzles(env, session.userId);
  const writes = [];
  const maxN = Math.min(MAX_PUZZLE_NUMBER, maxPuzzleNumber(now));
  for (const [key, raw] of entries) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > maxN) continue;
    const incoming = sanitizePuzzle(raw);
    if (!incoming) continue;
    const merged = mergePuzzle(stored[n], incoming, now);
    if (merged !== stored[n]) {
      stored[n] = merged;
      const scored = scorePuzzle(merged);
      writes.push(
        env.DB.prepare('INSERT OR REPLACE INTO puzzles (user_id, n, data, updated_at, score) VALUES (?, ?, ?, ?, ?)').bind(session.userId, n, JSON.stringify(merged), now, scored ? scored.score : null),
      );
    }
  }
  if (writes.length) await env.DB.batch(writes);
  return json({ puzzles: stored });
}

/**
 * "u:<user id>" for a bearer token, else "a:<anonymous id>" from the body. A
 * token that no longer works is reported as 401 so the client signs out,
 * rather than silently dropping the answer.
 */
async function playerKey(env, request, body, now) {
  if (request.headers.get('Authorization')) {
    const session = await requireSession(env, request, now);
    return `u:${session.userId}`;
  }
  const anon = String(body.player ?? '').trim();
  if (!ANON_ID_RE.test(anon)) throw new HttpError(400, 'A player id is required');
  return `a:${anon}`;
}

async function questionStats(env, questionId, answer, mine) {
  const { results } = await env.DB.prepare('SELECT guess FROM guesses WHERE question_id = ? LIMIT ?').bind(questionId, STATS_SAMPLE).all();
  return { question_id: questionId, ...computeStats((results || []).map((r) => Number(r.guess)), answer, mine) };
}

/** The server's answer for a question when it knows one, else the client's. */
function answerFor(questionId, clientAnswer) {
  const known = ANSWERS[questionId];
  return known > 0 ? known : positiveNumber(clientAnswer, 'answer');
}

async function postGuess(request, env, now) {
  const body = await readJson(request);
  const questionId = validateQuestionId(body.question_id);
  const guess = positiveNumber(body.guess, 'guess');
  const answer = answerFor(questionId, body.answer);
  await rateLimit(env, `guess:${clientIp(request)}`, GUESS_LIMIT_PER_IP, now);
  const key = await playerKey(env, request, body, now);
  await env.DB.prepare('INSERT OR IGNORE INTO guesses (question_id, player_key, guess, created_at) VALUES (?, ?, ?, ?)').bind(questionId, key, guess, now).run();
  return json(await questionStats(env, questionId, answer, guess));
}

async function getStats(request, env) {
  const url = new URL(request.url);
  const questionId = validateQuestionId(url.searchParams.get('question_id'));
  const answer = answerFor(questionId, url.searchParams.get('answer'));
  const mineRaw = url.searchParams.get('guess');
  const mine = mineRaw === null || mineRaw === '' ? null : positiveNumber(mineRaw, 'guess');
  return json(await questionStats(env, questionId, answer, mine));
}

// ------------------------------------------------------ unlimited and timed

async function createRun(request, env, now) {
  const session = await requireSession(env, request, now);
  const body = await readJson(request);
  if (body.mode !== 'timed') throw new HttpError(400, 'Only timed runs are recorded');
  await rateLimit(env, `run:${session.userId}`, RUN_LIMIT_PER_USER, now);
  const result = await env.DB.prepare("INSERT INTO runs (user_id, mode, started_at) VALUES (?, 'timed', ?)").bind(session.userId, now).run();
  const id = result.meta?.last_row_id ?? (await env.DB.prepare('SELECT id FROM runs WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(session.userId).first()).id;
  return json({ id, startedAt: now, durationMs: TIMED_DURATION_MS }, 201);
}

/**
 * One answer in unlimited or timed mode. Signed-in players get it recorded
 * for the leaderboards (timed answers must belong to a run that is still
 * going); everyone's first answer to a question also joins the community
 * statistics, exactly like a daily guess.
 */
async function postPlay(request, env, now) {
  const body = await readJson(request);
  const mode = body.mode === 'timed' || body.mode === 'unlimited' ? body.mode : null;
  if (!mode) throw new HttpError(400, 'mode must be unlimited or timed');
  const questionId = validateQuestionId(body.question_id);
  const guess = positiveNumber(body.guess, 'guess');
  // Leaderboard credit comes only from answers the API knows itself.
  const answer = ANSWERS[questionId];
  if (!(answer > 0)) throw new HttpError(400, 'Unknown question');
  const multiple = scoreMultiple(guess, answer);
  await rateLimit(env, `play:${clientIp(request)}`, PLAY_LIMIT_PER_IP, now);
  const key = await playerKey(env, request, body, now);
  let run = null;
  if (key.startsWith('u:')) {
    const userId = Number(key.slice(2));
    let runId = null;
    if (mode === 'timed') {
      const id = Number(body.run_id);
      if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'A run id is required in timed mode');
      const row = await env.DB.prepare("SELECT id, started_at AS startedAt, answered FROM runs WHERE id = ? AND user_id = ? AND mode = 'timed'").bind(id, userId).first();
      if (!row) throw new HttpError(404, 'Unknown run');
      if (now > row.startedAt + TIMED_DURATION_MS + TIMED_GRACE_MS) throw new HttpError(400, 'Time is up for that run');
      if (row.answered >= MAX_PLAYS_PER_RUN) throw new HttpError(400, 'That run already holds as many answers as fit in the time');
      runId = row.id;
    }
    // A question answered twice in one run counts once (the run's unique
    // index ignores the repeat), and the run's totals are recomputed from its
    // plays so a repeat cannot inflate them.
    const writes = [
      env.DB.prepare('INSERT OR IGNORE INTO plays (user_id, mode, run_id, question_id, guess, multiple, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(userId, mode, runId, questionId, guess, multiple, now),
    ];
    if (runId) {
      writes.push(
        env.DB.prepare(
          'UPDATE runs SET answered = (SELECT COUNT(*) FROM plays WHERE run_id = ?1), ballpark = (SELECT COUNT(*) FROM plays WHERE run_id = ?1 AND multiple <= ?2), sum_multiple = (SELECT COALESCE(SUM(multiple), 0) FROM plays WHERE run_id = ?1) WHERE id = ?1',
        ).bind(runId, BALLPARK_MAX),
      );
    }
    await env.DB.batch(writes);
    if (runId) {
      const r = await env.DB.prepare('SELECT answered, ballpark, sum_multiple AS sum, started_at AS startedAt FROM runs WHERE id = ?').bind(runId).first();
      run = { id: runId, answered: r.answered, ballpark: r.ballpark, average: r.answered ? r.sum / r.answered : null, remainingMs: Math.max(0, r.startedAt + TIMED_DURATION_MS - now) };
    }
  }
  await env.DB.prepare('INSERT OR IGNORE INTO guesses (question_id, player_key, guess, created_at) VALUES (?, ?, ?, ?)').bind(questionId, key, guess, now).run();
  return json({ multiple, ballpark: multiple <= BALLPARK_MAX, run, stats: await questionStats(env, questionId, answer, guess) });
}

/** Every question id the signed-in account has answered in any mode, so unlimited and timed never repeat one. */
async function seenQuestions(request, env, now) {
  const session = await requireSession(env, request, now);
  const [plays, guesses] = await Promise.all([
    env.DB.prepare('SELECT DISTINCT question_id AS id FROM plays WHERE user_id = ? LIMIT 20000').bind(session.userId).all(),
    env.DB.prepare('SELECT question_id AS id FROM guesses WHERE player_key = ? LIMIT 20000').bind(`u:${session.userId}`).all(),
  ]);
  const ids = new Set();
  for (const r of [...(plays.results || []), ...(guesses.results || [])]) ids.add(r.id);
  return json({ ids: [...ids] });
}

// ------------------------------------------------------------ leaderboards

async function leaderboard(request, env, now) {
  const session = await requireSession(env, request, now);
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope');
  if (scope === 'all') {
    const { results } = await env.DB.prepare(
      'SELECT u.username AS username, p.user_id AS userId, COUNT(*) AS played, AVG(p.score) AS average, MIN(p.score) AS best FROM puzzles p JOIN users u ON u.id = p.user_id WHERE p.score IS NOT NULL GROUP BY p.user_id',
    ).all();
    const players = (results || [])
      .map((r) => ({ username: r.username, played: Number(r.played), average: Number(r.average), best: Number(r.best), ranked: Number(r.played) >= RANKED_MIN_PLAYED, you: r.userId === session.userId }))
      .sort((a, b) => (a.ranked !== b.ranked ? (a.ranked ? -1 : 1) : a.ranked ? a.average - b.average : b.played - a.played))
      .slice(0, BOARD_LIMIT);
    return json({ scope: 'all', rankedMinPlayed: RANKED_MIN_PLAYED, players });
  }
  if (scope === 'unlimited') {
    const { results } = await env.DB.prepare(
      "SELECT u.username AS username, p.user_id AS userId, COUNT(DISTINCT p.question_id) AS answered, AVG(p.multiple) AS average, COUNT(DISTINCT CASE WHEN p.multiple <= ? THEN p.question_id END) AS ballpark FROM plays p JOIN users u ON u.id = p.user_id WHERE p.mode = 'unlimited' GROUP BY p.user_id ORDER BY answered DESC, average ASC LIMIT ?",
    )
      .bind(BALLPARK_MAX, BOARD_LIMIT)
      .all();
    const players = (results || []).map((r) => ({ username: r.username, answered: Number(r.answered), ballpark: Number(r.ballpark), average: Number(r.average), you: r.userId === session.userId }));
    return json({ scope: 'unlimited', players });
  }
  if (scope === 'timed') {
    // Each player's best run (most in the ballpark, then the lower average), ranked, without reading every run.
    const { results } = await env.DB.prepare(
      "SELECT r.user_id AS userId, u.username AS username, r.answered AS answered, r.ballpark AS ballpark, r.sum_multiple AS sum, r.started_at AS startedAt FROM runs r JOIN users u ON u.id = r.user_id WHERE r.mode = 'timed' AND r.answered > 0 AND r.id = (SELECT b.id FROM runs b WHERE b.user_id = r.user_id AND b.mode = 'timed' AND b.answered > 0 ORDER BY b.ballpark DESC, b.sum_multiple / b.answered ASC, b.answered DESC, b.id ASC LIMIT 1) ORDER BY r.ballpark DESC, r.sum_multiple / r.answered ASC, r.answered DESC LIMIT ?",
    )
      .bind(BOARD_LIMIT)
      .all();
    const players = (results || []).map((r) => ({ username: r.username, answered: Number(r.answered), ballpark: Number(r.ballpark), average: Number(r.sum) / Number(r.answered), startedAt: r.startedAt, you: r.userId === session.userId }));
    return json({ scope: 'timed', durationMs: TIMED_DURATION_MS, ballparkMax: BALLPARK_MAX, players });
  }
  const n = Number(url.searchParams.get('n'));
  if (!Number.isInteger(n) || n < 1 || n > MAX_PUZZLE_NUMBER) throw new HttpError(400, 'Give a puzzle number as n');
  const { results } = await env.DB.prepare(
    'SELECT u.username AS username, p.user_id AS userId, p.data AS data, p.score AS score, p.updated_at AS updatedAt FROM puzzles p JOIN users u ON u.id = p.user_id WHERE p.n = ? AND p.score IS NOT NULL ORDER BY p.score ASC, p.updated_at ASC LIMIT ?',
  )
    .bind(n, BOARD_LIMIT)
    .all();
  const players = [];
  for (const r of results || []) {
    let multiples = null;
    try {
      const scored = scorePuzzle(sanitizePuzzle(JSON.parse(r.data)));
      if (scored) multiples = scored.multiples;
    } catch {
      multiples = null;
    }
    players.push({ username: r.username, score: Number(r.score), multiples, finishedAt: r.updatedAt, you: r.userId === session.userId });
  }
  return json({ scope: 'daily', n, players });
}

// ------------------------------------------------------------- suggestions

async function postSuggestion(request, env, now) {
  const body = await readJson(request);
  const text = String(body.text ?? '').trim();
  if (text.length < 3) throw new HttpError(400, 'Write a few words first');
  if (text.length > SUGGESTION_MAX) throw new HttpError(400, `Keep it under ${SUGGESTION_MAX} characters`);
  await rateLimit(env, `suggest:${clientIp(request)}`, SUGGEST_LIMIT_PER_IP, now);
  const key = await playerKey(env, request, body, now);
  await env.DB.prepare('INSERT INTO suggestions (text, player_key, created_at) VALUES (?, ?, ?)').bind(text, key, now).run();
  return json({ ok: true }, 201);
}

async function adminSuggestions(request, env, now) {
  await requireAdmin(env, request, now);
  const { results } = await env.DB.prepare(
    "SELECT s.id AS id, s.text AS text, s.player_key AS playerKey, s.created_at AS createdAt, s.done AS done, u.username AS username FROM suggestions s LEFT JOIN users u ON s.player_key = 'u:' || u.id ORDER BY s.id DESC LIMIT ?",
  )
    .bind(ADMIN_ROWS_LIMIT)
    .all();
  return json({ suggestions: (results || []).map((r) => ({ id: r.id, text: r.text, createdAt: r.createdAt, done: !!r.done, username: r.username || null, guest: r.username ? null : String(r.playerKey).slice(2, 8) })) });
}

async function adminSuggestionUpdate(request, env, now) {
  await requireAdmin(env, request, now);
  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Give the suggestion id');
  if (body.delete === true) await env.DB.prepare('DELETE FROM suggestions WHERE id = ?').bind(id).run();
  else await env.DB.prepare('UPDATE suggestions SET done = ? WHERE id = ?').bind(body.done === false ? 0 : 1, id).run();
  return json(null, 204);
}

// ------------------------------------------------------------------- admin

function parsePuzzleRow(row) {
  try {
    const state = sanitizePuzzle(JSON.parse(row.data));
    if (!state) return null;
    const scored = scorePuzzle(state);
    return { n: row.n, ...state, score: row.score == null ? (scored ? scored.score : null) : Number(row.score), multiples: scored ? scored.multiples : null, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

async function adminPlayers(request, env, now) {
  const admin = await requireAdmin(env, request, now);
  const { results } = await env.DB.prepare(
    `SELECT u.id AS id, u.username AS username, u.is_admin AS isAdmin, u.created_at AS createdAt,
      (SELECT COUNT(*) FROM puzzles p WHERE p.user_id = u.id AND p.score IS NOT NULL) AS played,
      (SELECT AVG(p.score) FROM puzzles p WHERE p.user_id = u.id AND p.score IS NOT NULL) AS average,
      (SELECT COUNT(*) FROM guesses g WHERE g.player_key = 'u:' || u.id) AS answers,
      (SELECT COUNT(*) FROM plays pl WHERE pl.user_id = u.id AND pl.mode = 'unlimited') AS unlimited,
      (SELECT MAX(r.ballpark) FROM runs r WHERE r.user_id = u.id AND r.mode = 'timed') AS timedBest,
      (SELECT MAX(p.updated_at) FROM puzzles p WHERE p.user_id = u.id) AS lastPuzzle,
      (SELECT MAX(g.created_at) FROM guesses g WHERE g.player_key = 'u:' || u.id) AS lastGuess,
      (SELECT MAX(pl.created_at) FROM plays pl WHERE pl.user_id = u.id) AS lastPlay
     FROM users u ORDER BY u.id ASC LIMIT ?`,
  )
    .bind(ADMIN_LIST_LIMIT)
    .all();
  const players = [];
  for (const r of results || []) {
    const times = [r.lastPuzzle, r.lastGuess, r.lastPlay].filter((t) => typeof t === 'number');
    players.push({
      id: r.id,
      username: r.username,
      createdAt: r.createdAt,
      played: Number(r.played),
      average: r.average == null ? null : Number(r.average),
      answers: Number(r.answers),
      unlimited: Number(r.unlimited),
      timedBest: r.timedBest == null ? null : Number(r.timedBest),
      lastActive: times.length ? Math.max(...times) : null,
      admin: r.isAdmin === 1 || r.id === admin.userId,
    });
  }
  return json({ players });
}

async function adminAnswers(request, env, now) {
  await requireAdmin(env, request, now);
  const url = new URL(request.url);
  if (url.searchParams.has('user')) {
    const id = Number(url.searchParams.get('user'));
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Give a user id');
    const user = await env.DB.prepare('SELECT id, username, created_at AS createdAt FROM users WHERE id = ?').bind(id).first();
    if (!user) throw new HttpError(404, 'No such player');
    const [puzzles, plays, guesses] = await Promise.all([
      env.DB.prepare('SELECT n, data, score, updated_at FROM puzzles WHERE user_id = ? ORDER BY n DESC LIMIT ?').bind(id, ADMIN_ROWS_LIMIT).all(),
      env.DB.prepare('SELECT mode, run_id AS runId, question_id AS questionId, guess, multiple, created_at AS createdAt FROM plays WHERE user_id = ? ORDER BY id DESC LIMIT ?').bind(id, ADMIN_ROWS_LIMIT).all(),
      env.DB.prepare('SELECT question_id AS questionId, guess, created_at AS createdAt FROM guesses WHERE player_key = ? ORDER BY created_at DESC LIMIT ?').bind(`u:${id}`, ADMIN_ROWS_LIMIT).all(),
    ]);
    return json({
      user: { id: user.id, username: user.username, createdAt: user.createdAt },
      puzzles: (puzzles.results || []).map(parsePuzzleRow).filter(Boolean),
      plays: (plays.results || []).map((r) => ({ mode: r.mode, runId: r.runId, questionId: r.questionId, guess: Number(r.guess), multiple: Number(r.multiple), createdAt: r.createdAt })),
      guesses: (guesses.results || []).map((r) => ({ questionId: r.questionId, guess: Number(r.guess), createdAt: r.createdAt })),
    });
  }
  const ids = String(url.searchParams.get('question_ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, ADMIN_QUESTIONS_MAX)
    .map(validateQuestionId);
  if (!ids.length) throw new HttpError(400, 'Give user=<id> or question_ids=a,b,c');
  const { results } = await env.DB.prepare(
    `SELECT g.question_id AS questionId, g.player_key AS playerKey, g.guess AS guess, g.created_at AS createdAt, u.id AS userId, u.username AS username
     FROM guesses g LEFT JOIN users u ON g.player_key = 'u:' || u.id WHERE g.question_id IN (${ids.map(() => '?').join(',')}) ORDER BY g.question_id ASC, g.created_at ASC, g.player_key ASC LIMIT ?`,
  )
    .bind(...ids, ADMIN_ROWS_LIMIT)
    .all();
  const guesses = (results || []).map((r) => ({
    questionId: r.questionId,
    guess: Number(r.guess),
    createdAt: r.createdAt,
    userId: r.userId ?? null,
    username: r.username || null,
    guest: r.username ? null : String(r.playerKey).slice(2, 8),
  }));
  return json({ questionIds: ids, guesses });
}

async function adminSetPassword(request, env, now) {
  const admin = await requireAdmin(env, request, now);
  const body = await readJson(request);
  const id = Number(body.user_id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Give the player id');
  const password = validatePassword(body.password);
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!user) throw new HttpError(404, 'No such player');
  const iterations = Math.max(10000, Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS);
  const record = await createPasswordRecord(password, iterations);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iterations = ? WHERE id = ?').bind(record.pw_hash, record.pw_salt, record.pw_iterations, id),
    // Sign that player out everywhere, except the owner's own current session when resetting their own password.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(id, admin.tokenHash),
  ]);
  return json(null, 204);
}

async function deleteAccount(request, env, now) {
  const session = await requireSession(env, request, now);
  const body = await readJson(request);
  const user = await env.DB.prepare('SELECT id, pw_hash, pw_salt, pw_iterations FROM users WHERE id = ?').bind(session.userId).first();
  if (!user || !(await verifyPassword(String(body.password ?? ''), user))) throw new HttpError(401, 'Wrong password');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM puzzles WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM guesses WHERE player_key = ?').bind(`u:${user.id}`),
    env.DB.prepare('DELETE FROM plays WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM runs WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM suggestions WHERE player_key = ?').bind(`u:${user.id}`),
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
  ['POST', '/api/guesses', postGuess],
  ['GET', '/api/stats', getStats],
  ['POST', '/api/runs', createRun],
  ['POST', '/api/plays', postPlay],
  ['POST', '/api/suggestions', postSuggestion],
  ['GET', '/api/seen', seenQuestions],
  ['GET', '/api/leaderboard', leaderboard],
  ['GET', '/api/admin/players', adminPlayers],
  ['GET', '/api/admin/answers', adminAnswers],
  ['POST', '/api/admin/password', adminSetPassword],
  ['GET', '/api/admin/suggestions', adminSuggestions],
  ['POST', '/api/admin/suggestion', adminSuggestionUpdate],
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
