// localStorage wrapper. Every call is guarded: private browsing modes and
// blocked storage must never break the game.

const PREFIX = 'fermi5:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
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

export function loadPuzzleState(n) {
  const s = read(`puzzle:${n}`, null);
  if (!s || !Array.isArray(s.guesses)) return { guesses: [], completedAt: null, recorded: false };
  return { completedAt: null, recorded: false, ...s };
}

export function savePuzzleState(n, state) {
  return write(`puzzle:${n}`, state);
}

export function loadStats() {
  return read('stats', null);
}

export function saveStats(stats) {
  return write('stats', stats);
}

export function loadPrefs() {
  return read('prefs', {});
}

export function savePrefs(prefs) {
  return write('prefs', prefs);
}
