// localStorage wrapper. Every call is guarded and every value is validated:
// private browsing modes, blocked storage or hand-edited data must never break
// the game.

import { normalizeStats } from './logic.js';

const PREFIX = 'fermi5:';

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

function freshPuzzleState() {
  return { guesses: [], completedAt: null, recorded: false };
}

export function loadPuzzleState(n) {
  const s = read(`puzzle:${n}`, null);
  if (!s || typeof s !== 'object' || !Array.isArray(s.guesses)) return freshPuzzleState();
  if (!s.guesses.every((g) => typeof g === 'number' && Number.isFinite(g) && g > 0)) return freshPuzzleState();
  const state = {
    guesses: s.guesses,
    completedAt: typeof s.completedAt === 'number' ? s.completedAt : null,
    recorded: s.recorded === true,
  };
  if (Array.isArray(s.ids) && s.ids.every((id) => typeof id === 'string')) state.ids = s.ids;
  if (Array.isArray(s.units)) state.units = s.units.map((u) => (typeof u === 'string' ? u : null));
  return state;
}

export function savePuzzleState(n, state) {
  return write(`puzzle:${n}`, state);
}

/** Always returns a well-formed stats object. */
export function loadStats() {
  return normalizeStats(read('stats', null));
}

export function saveStats(stats) {
  return write('stats', normalizeStats(stats));
}

/** Always returns a plain object. */
export function loadPrefs() {
  const p = read('prefs', {});
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

export function savePrefs(prefs) {
  return write('prefs', prefs);
}
