// localStorage wrapper. Every call is guarded and every value is validated:
// private browsing modes, blocked storage or hand-edited data must never break
// the game.

const PREFIX = 'fermi5:';
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

/** Coerce anything (storage, a backup, a cloud record) into a valid puzzle state. */
export function sanitizePuzzleState(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.guesses)) return freshPuzzleState();
  if (!s.guesses.every((g) => typeof g === 'number' && Number.isFinite(g) && g > 0)) return freshPuzzleState();
  const state = {
    guesses: s.guesses.slice(),
    completedAt: typeof s.completedAt === 'number' ? s.completedAt : null,
  };
  if (Array.isArray(s.ids) && s.ids.every((id) => typeof id === 'string')) state.ids = s.ids.slice();
  if (Array.isArray(s.units)) state.units = s.units.map((u) => (typeof u === 'string' ? u : null));
  return state;
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
      if (state.guesses.length) out[n] = state;
    }
  } catch {
    // storage unavailable
  }
  return out;
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
      if (state.guesses.length) puzzles[n] = state;
    }
    const prefs = payload.prefs && typeof payload.prefs === 'object' && !Array.isArray(payload.prefs) ? payload.prefs : {};
    return { puzzles, prefs };
  } catch {
    return null;
  }
}

/**
 * Merge puzzle records into storage. A record wins when it has more guesses
 * than what is stored. Returns the puzzle numbers that changed.
 */
export function mergePuzzleStates(puzzles) {
  const changed = [];
  for (const [k, incoming] of Object.entries(puzzles)) {
    const n = Number(k);
    const state = sanitizePuzzleState(incoming);
    if (!state.guesses.length) continue;
    const local = loadPuzzleState(n);
    if (state.guesses.length > local.guesses.length) {
      savePuzzleState(n, state);
      changed.push(n);
    }
  }
  return changed;
}
