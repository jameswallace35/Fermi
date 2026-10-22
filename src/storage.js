// localStorage wrapper. Every call is guarded and every value is validated:
// private browsing modes, blocked storage or hand-edited data must never break
// the game.

import { answeredCount, mergePuzzleRecords, QUESTIONS_PER_DAY } from './logic.js';

const PREFIX = 'fermi5:';
export const NOTES_MAX = 4000;
const PUZZLE_PREFIX = `${PREFIX}puzzle:`;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function freshPuzzleState() {
  return { guesses: [], completedAt: null };
}

/**
 * Coerce anything (storage, a backup, a cloud record) into a valid puzzle
 * state. Questions can be answered in any order: `guesses` holds a positive
 * number per answered question and null for one not answered yet.
 */
export function sanitizePuzzleState(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.guesses) || s.guesses.length > QUESTIONS_PER_DAY) return freshPuzzleState();
  const guesses = [];
  for (const g of s.guesses) {
    if (g === null || g === undefined) guesses.push(null);
    else if (typeof g === 'number' && Number.isFinite(g) && g > 0) guesses.push(g);
    else return freshPuzzleState();
  }
  while (guesses.length && guesses[guesses.length - 1] === null) guesses.pop();
  const state = {
    guesses,
    completedAt: typeof s.completedAt === 'number' ? s.completedAt : null,
  };
  if (Array.isArray(s.ids) && s.ids.every((id) => typeof id === 'string')) state.ids = s.ids.slice();
  if (Array.isArray(s.units)) state.units = s.units.slice(0, QUESTIONS_PER_DAY).map((u) => (typeof u === 'string' ? u : null));
  if (typeof s.notes === 'string' && s.notes) state.notes = s.notes.slice(0, NOTES_MAX);
  return state;
}

/** True for a record worth keeping, syncing or backing up: at least one answer or some notes. */
export function hasContent(state) {
  return answeredCount(state) > 0 || (typeof state.notes === 'string' && state.notes.trim() !== '');
}

export function loadPuzzleState(n) {
  return sanitizePuzzleState(read(`puzzle:${n}`, null));
}

export function savePuzzleState(n, state) {
  return write(`puzzle:${n}`, state);
}

/** Every stored puzzle state, keyed by puzzle number. */
export function listPuzzleStates() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PUZZLE_PREFIX)) continue;
      const n = Number(key.slice(PUZZLE_PREFIX.length));
      if (!Number.isInteger(n) || n < 1) continue;
      const state = loadPuzzleState(n);
      if (hasContent(state)) out[n] = state;
    }
  } catch {
    // storage unavailable
  }
  return out;
}

/** A random id that identifies this browser in the community statistics. Never tied to a name. */
export function anonymousId() {
  let id = read('anon', null);
  if (typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id)) return id;
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  id = Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[b % 64]).join('');
  write('anon', id);
  return id;
}

/** Always returns a plain object. */
export function loadPrefs() {
  const p = read('prefs', {});
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

export function savePrefs(prefs) {
  return write('prefs', prefs);
}

// ---------------------------------------------------------------------------
// Backup codes: a portable copy of every result, for moving between browsers.

const BACKUP_TAG = 'FERMI1.';

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** A backup code holding every puzzle result and the player's preferences. */
export function exportBackup() {
  const payload = { v: 1, puzzles: listPuzzleStates(), prefs: loadPrefs() };
  return BACKUP_TAG + toBase64(JSON.stringify(payload));
}

/** Parse a backup code. Returns { puzzles, prefs } or null if it is not one. */
export function parseBackup(code) {
  const s = String(code || '').trim();
  if (!s.startsWith(BACKUP_TAG)) return null;
  try {
    const payload = JSON.parse(fromBase64(s.slice(BACKUP_TAG.length)));
    if (!payload || typeof payload !== 'object' || !payload.puzzles || typeof payload.puzzles !== 'object') return null;
    const puzzles = {};
    for (const [k, v] of Object.entries(payload.puzzles)) {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 1) continue;
      const state = sanitizePuzzleState(v);
      if (hasContent(state)) puzzles[n] = state;
    }
    const prefs = payload.prefs && typeof payload.prefs === 'object' && !Array.isArray(payload.prefs) ? payload.prefs : {};
    return { puzzles, prefs };
  } catch {
    return null;
  }
}

/**
 * Merge puzzle records into storage, question by question (see
 * mergePuzzleRecords). Returns the puzzle numbers that changed.
 */
export function mergePuzzleStates(puzzles) {
  const changed = [];
  for (const [k, incoming] of Object.entries(puzzles)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1) continue;
    const state = sanitizePuzzleState(incoming);
    if (!hasContent(state)) continue;
    const local = loadPuzzleState(n);
    const merged = mergePuzzleRecords(local, state);
    if (merged !== local) {
      savePuzzleState(n, merged);
      changed.push(n);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Unlimited and timed modes: local totals (the server keeps the leaderboards).

export function loadModeStats(mode) {
  const s = read(`mode:${mode}`, {});
  const out = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  return {
    answered: Number.isInteger(out.answered) && out.answered >= 0 ? out.answered : 0,
    ballpark: Number.isInteger(out.ballpark) && out.ballpark >= 0 ? out.ballpark : 0,
    sumMultiple: Number.isFinite(out.sumMultiple) && out.sumMultiple >= 0 ? out.sumMultiple : 0,
    seen: Array.isArray(out.seen) ? out.seen.filter((id) => typeof id === 'string').slice(-2000) : [],
    best: out.best && typeof out.best === 'object' && Number.isInteger(out.best.ballpark) ? { ballpark: out.best.ballpark, answered: Number.isInteger(out.best.answered) ? out.best.answered : 0, average: Number.isFinite(out.best.average) ? out.best.average : null, at: Number.isFinite(out.best.at) ? out.best.at : null } : null,
  };
}

export function saveModeStats(mode, stats) {
  return write(`mode:${mode}`, stats);
}
