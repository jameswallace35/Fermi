// Pure game logic for Fermi: no DOM, no storage. Everything here is unit-tested.

export const GAME_NAME = 'Fermi';
export const EPOCH_DATE_KEY = '2026-10-21'; // Puzzle No. 1
export const QUESTIONS_PER_DAY = 5;

const DAY_MS = 86_400_000;

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local calendar date as YYYY-MM-DD (the puzzle rolls over at local midnight). */
export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

function utcDayIndex(key) {
  const p = parseDateKey(key);
  if (!p) return NaN;
  return Math.round(Date.UTC(p.y, p.mo - 1, p.d) / DAY_MS);
}

/** Puzzle number for a YYYY-MM-DD date key. Epoch date is No. 1. */
export function puzzleNumberForDate(dateKey) {
  const n = utcDayIndex(dateKey) - utcDayIndex(EPOCH_DATE_KEY) + 1;
  return Number.isFinite(n) ? n : NaN;
}

/** Inverse of puzzleNumberForDate. */
export function dateKeyForPuzzle(n) {
  const days = utcDayIndex(EPOCH_DATE_KEY) + (n - 1);
  const d = new Date(days * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function todayPuzzleNumber(now = new Date()) {
  return puzzleNumberForDate(localDateKey(now));
}

/** Human date like "21 Oct 2026" (en-GB) or "Oct 21, 2026" (en-US). */
export function formatDateKey(key, locale = undefined) {
  const p = parseDateKey(key);
  if (!p) return String(key);
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export function msUntilLocalMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

// ---------------------------------------------------------------------------
// Scoring

/** How many times off a guess is: max(guess/answer, answer/guess). 1 is exact. */
export function scoreMultiple(guess, answer) {
  if (!Number.isFinite(guess) || !Number.isFinite(answer) || guess <= 0 || answer <= 0) return Infinity;
  return Math.max(guess / answer, answer / guess);
}

/** Daily score: arithmetic mean of the multiples (as on fermi.gg). */
export function dailyScore(multiples) {
  if (!Array.isArray(multiples) || multiples.length === 0) return NaN;
  return multiples.reduce((a, b) => a + b, 0) / multiples.length;
}

export function formatMultiple(m) {
  if (!Number.isFinite(m)) return '∞×';
  let s;
  if (m < 10) s = m.toFixed(2);
  else if (m < 100) s = m.toFixed(1);
  else s = Math.round(m).toLocaleString('en-US');
  return `${s}×`;
}

export const TIERS = [
  { max: 1.1, emoji: '🎯', label: 'Spot on', cls: 'tier-0' },
  { max: 2, emoji: '🟢', label: 'Great', cls: 'tier-1' },
  { max: 5, emoji: '🟡', label: 'Close', cls: 'tier-2' },
  { max: 10, emoji: '🟠', label: 'Off', cls: 'tier-3' },
  { max: Infinity, emoji: '🔴', label: 'Way off', cls: 'tier-4' },
];

export function tierFor(m) {
  const v = Number.isFinite(m) ? m : Infinity;
  return TIERS.find((t) => v <= t.max) || TIERS[TIERS.length - 1];
}

export function tierIndex(m) {
  return TIERS.indexOf(tierFor(m));
}

// ---------------------------------------------------------------------------
// Number parsing and formatting

export const SUFFIXES = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, mm: 1e6, mil: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, bil: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a human-typed number: "1,500", "1.5k", "2 million", "3B", "1e9", "$4,000".
 * An optional unit label (e.g. "km") typed after the number is ignored.
 * Returns NaN when the text is not a plain number.
 */
export function parseNumber(input, unit = '') {
  if (typeof input === 'number') return input;
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return NaN;
  if (unit) {
    const u = String(unit).trim().toLowerCase();
    if (u) s = s.replace(new RegExp(`\\s*${escapeRegExp(u)}$`), '');
  }
  s = s.replace(/^[$€£¥]\s*/, '');
  const m = /^(\d[\d,_ ]*(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?\s*([a-z]+)?$/.exec(s);
  if (!m) return NaN;
  if (!/^(\d+(?:[,_ ]\d+)*(?:\.\d*)?|\.\d+)$/.test(m[1].trim())) return NaN;
  const digits = m[1].replace(/[,_ ]/g, '');
  if (digits === '.' || digits === '') return NaN;
  let value = Number(digits);
  if (m[2] !== undefined) value *= Math.pow(10, Number(m[2]));
  if (m[3]) {
    const mult = SUFFIXES[m[3]];
    if (!mult) return NaN;
    value *= mult;
  }
  return Number.isFinite(value) ? value : NaN;
}

/** Full number with thousands separators: 1,500,000. */
export function formatNumber(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 0.001 || abs >= 1e21)) return n.toExponential(2);
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  return Number(n.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Compact words for big numbers: "1.5 million". Returns null below 10,000. */
export function formatCompact(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs < 10_000) return null;
  const units = [
    [1e12, 'trillion'],
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ];
  for (const [v, name] of units) {
    const r = Number((abs / v).toPrecision(3));
    if (r >= 1) return `${(n < 0 ? -r : r).toLocaleString('en-US')} ${name}`;
  }
  return null;
}

/** Position (0-100) of a guess on a log scale centred on the answer, ±2 decades. */
export function scalePosition(guess, answer) {
  if (!(guess > 0) || !(answer > 0)) return guess > answer ? 100 : 0;
  const decades = Math.log10(guess / answer);
  const clamped = Math.max(-2.2, Math.min(2.2, decades));
  return Math.round((50 + clamped * 25) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Daily question selection

/** Categories in bank order, each with its questions in bank order. Empty categories are skipped. */
export function categoriesWithQuestions(bank) {
  const byCat = new Map();
  for (const q of bank.questions || []) {
    if (!byCat.has(q.category)) byCat.set(q.category, []);
    byCat.get(q.category).push(q);
  }
  return (bank.categories || [])
    .map((c) => ({ ...c, questions: byCat.get(c.slug) || [] }))
    .filter((c) => c.questions.length > 0);
}

/**
 * Deterministic daily selection. Day n (0-based) takes consecutive slots
 * s = n*perDay + k; slot s draws from category s mod C, and the j-th time a
 * category is drawn it yields its j-th question (cycling when exhausted).
 * With C >= perDay the five categories in a day are always distinct, and no
 * question repeats until its whole category has been used.
 */
export function selectQuestions(bank, puzzleNumber, perDay = QUESTIONS_PER_DAY) {
  const cats = categoriesWithQuestions(bank);
  const C = cats.length;
  if (!C || !Number.isFinite(puzzleNumber)) return [];
  const n = Math.max(0, Math.floor(puzzleNumber) - 1);
  const out = [];
  for (let k = 0; k < perDay; k++) {
    const s = n * perDay + k;
    const c = s % C;
    const j = (s - c) / C;
    const cat = cats[c];
    const q = cat.questions[j % cat.questions.length];
    out.push({ ...q, categoryName: cat.name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stats

export function defaultStats() {
  return { played: 0, sumAvg: 0, best: null, maxStreak: 0, tiers: [0, 0, 0, 0, 0] };
}

/**
 * Current streak: consecutive completed puzzles ending at today (or at
 * yesterday if today is not yet done). `isComplete(n)` reports whether puzzle n
 * was finished.
 */
export function computeStreak(isComplete, todayNumber) {
  let n = isComplete(todayNumber) ? todayNumber : todayNumber - 1;
  let streak = 0;
  while (n >= 1 && isComplete(n)) {
    streak += 1;
    n -= 1;
  }
  return streak;
}

/** Returns a new stats object with a finished puzzle (average `avg`) recorded. */
export function recordCompletion(stats, avg, streakNow) {
  const base = { ...defaultStats(), ...(stats || {}) };
  const s = { ...base, tiers: [...(base.tiers || defaultStats().tiers)] };
  while (s.tiers.length < TIERS.length) s.tiers.push(0);
  s.played += 1;
  if (Number.isFinite(avg)) {
    s.sumAvg += avg;
    s.best = s.best == null ? avg : Math.min(s.best, avg);
    s.tiers[tierIndex(avg)] += 1;
  }
  s.maxStreak = Math.max(s.maxStreak || 0, streakNow || 0);
  return s;
}

// ---------------------------------------------------------------------------
// Share text

export function shareText({ puzzleNumber, dateKey, multiples, url }) {
  const avg = dailyScore(multiples);
  const lines = [
    `${GAME_NAME} No. ${puzzleNumber} · ${formatDateKey(dateKey, 'en-GB')}`,
    multiples.map((m) => `${tierFor(m).emoji} ${formatMultiple(m)}`).join('  '),
    `Average ${formatMultiple(avg)}`,
  ];
  if (url) lines.push(url);
  return lines.join('\n');
}
