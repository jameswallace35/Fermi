// Pure game logic for Fermi: no DOM, no storage. Everything here is unit-tested.

export const GAME_NAME = 'Fermi';
export const EPOCH_DATE_KEY = '2026-10-21'; // Puzzle No. 1
export const QUESTIONS_PER_DAY = 5;

/** Multiples are capped here so a wild guess can never produce Infinity. */
export const MAX_MULTIPLE = 1e15;

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

/** Round away floating-point noise so display and tiers agree (10.000000000000002 -> 10). */
function tidy(m) {
  return Number(m.toPrecision(12));
}

/**
 * How many times off a guess is: max(guess/answer, answer/guess). 1 is exact.
 * Invalid inputs and absurd ratios are capped at MAX_MULTIPLE so the result is
 * always a finite number.
 */
export function scoreMultiple(guess, answer) {
  if (!Number.isFinite(guess) || !Number.isFinite(answer) || guess <= 0 || answer <= 0) return MAX_MULTIPLE;
  const ratio = Math.max(guess / answer, answer / guess);
  return Number.isFinite(ratio) ? Math.min(tidy(ratio), MAX_MULTIPLE) : MAX_MULTIPLE;
}

/** Daily score: arithmetic mean of the multiples (as on fermi.gg). */
export function dailyScore(multiples) {
  if (!Array.isArray(multiples) || multiples.length === 0) return NaN;
  return multiples.reduce((a, b) => a + b, 0) / multiples.length;
}

const MULTIPLE_UNITS = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
];

/** "1.00×", "12.3×", "2,166×", "246M×": lower is better. */
export function formatMultiple(m) {
  if (!Number.isFinite(m)) return '∞×';
  const v = tidy(m);
  let s;
  if (v < 9.995) s = v.toFixed(2);
  else if (v < 99.95) s = v.toFixed(1);
  else if (v < 999_500) s = Math.round(v).toLocaleString('en-US');
  else {
    const [unit, letter] = MULTIPLE_UNITS.find(([u]) => v >= u * 0.9995) || MULTIPLE_UNITS[MULTIPLE_UNITS.length - 1];
    s = `${Number((v / unit).toPrecision(3)).toLocaleString('en-US')}${letter}`;
  }
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
  const v = Number.isFinite(m) ? tidy(m) : Infinity;
  return TIERS.find((t) => v <= t.max) || TIERS[TIERS.length - 1];
}

export function tierIndex(m) {
  return TIERS.indexOf(tierFor(m));
}

// ---------------------------------------------------------------------------
// Number parsing and formatting

export const SUFFIXES = Object.freeze(
  Object.assign(Object.create(null), {
    k: 1e3, thousand: 1e3,
    m: 1e6, mn: 1e6, mm: 1e6, mil: 1e6, million: 1e6,
    b: 1e9, bn: 1e9, bil: 1e9, billion: 1e9,
    t: 1e12, tn: 1e12, trillion: 1e12,
  }),
);

export function suffixValue(word) {
  const key = String(word).toLowerCase();
  return Object.hasOwn(SUFFIXES, key) ? SUFFIXES[key] : undefined;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise the digit part of a typed number into a plain decimal string, or
 * null when it is malformed.
 *   "1,500" / "1 500" / "1_500" -> "1500"     (grouping)
 *   "1,500.25"                  -> "1500.25"
 *   "1,5" / "0,25"              -> "1.5" / "0.25"  (decimal comma)
 *   "1,,2" / "1,00,0" / "1,"    -> null
 * Commas are thousands separators only when every group after the first has
 * exactly three digits; a single comma followed by one or two digits is read
 * as a decimal comma. Spaces and underscores only ever group digits.
 */
export function canonicalDigits(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\.\d+$/.test(s)) return s;
  if (!/^\d[\d,_ ]*(?:\.\d*)?$/.test(s)) return null;
  const dot = s.indexOf('.');
  const intPart = (dot === -1 ? s : s.slice(0, dot)).replace(/[ _]/g, '');
  const fracPart = dot === -1 ? null : s.slice(dot + 1);
  if (!intPart.includes(',')) return intPart + (fracPart === null ? '' : `.${fracPart}`);
  const groups = intPart.split(',');
  if (groups.some((g) => g === '')) return null;
  const thousands = /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => g.length === 3);
  if (thousands) return groups.join('') + (fracPart === null ? '' : `.${fracPart}`);
  if (groups.length === 2 && fracPart === null && groups[1].length <= 2) return `${groups[0]}.${groups[1]}`;
  return null;
}

/**
 * Parse a human-typed number: "1,500", "1.5k", "2 million", "3B", "1e9", "$4,000", "2,5".
 * An optional unit label (e.g. "km") typed after the number is ignored.
 * Returns NaN when the text is not a plain number.
 */
export const MAX_INPUT_LENGTH = 200;

export function parseNumber(input, unit = '') {
  if (typeof input === 'number') return input;
  let s = String(input ?? '').trim().toLowerCase();
  if (!s || s.length > MAX_INPUT_LENGTH) return NaN;
  if (unit) {
    const u = String(unit).trim().toLowerCase();
    if (u) s = s.replace(new RegExp(`\\s*${escapeRegExp(u)}$`), '');
  }
  s = s.replace(/^[$€£¥]\s*/, '');
  const m = /^(\d[\d,_ ]*(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?\s*([a-z]+)?$/.exec(s);
  if (!m) return NaN;
  const digits = canonicalDigits(m[1]);
  if (digits === null) return NaN;
  let value = Number(digits);
  if (m[2] !== undefined) value *= Math.pow(10, Number(m[2]));
  if (m[3]) {
    const mult = suffixValue(m[3]);
    if (mult === undefined) return NaN;
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

const COMPACT_UNITS = [
  [1e21, 'sextillion'],
  [1e18, 'quintillion'],
  [1e15, 'quadrillion'],
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];

/** Compact words for big numbers: "1.5 million". Returns null below 10,000. */
export function formatCompact(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs < 10_000) return null;
  for (const [v, name] of COMPACT_UNITS) {
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
 * With C >= perDay the five categories in a day are always distinct, and a
 * question only comes back once its own category has been played through.
 * Returns [] for puzzle numbers below 1.
 */
export function selectQuestions(bank, puzzleNumber, perDay = QUESTIONS_PER_DAY) {
  const cats = categoriesWithQuestions(bank);
  const C = cats.length;
  if (!C || !Number.isFinite(puzzleNumber) || puzzleNumber < 1) return [];
  const n = Math.floor(puzzleNumber) - 1;
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

/**
 * The first puzzle number on which some question is served for the second
 * time, given the rotation above. Category c is first drawn at slot c and
 * repeats at slot c + size_c * C.
 */
export function firstRepeatDay(bank, perDay = QUESTIONS_PER_DAY) {
  const cats = categoriesWithQuestions(bank);
  const C = cats.length;
  if (!C) return 0;
  let first = Infinity;
  cats.forEach((cat, c) => {
    first = Math.min(first, Math.floor((c + cat.questions.length * C) / perDay) + 1);
  });
  return first;
}

// ---------------------------------------------------------------------------
// Stats

export function defaultStats() {
  return { played: 0, sumAvg: 0, best: null, maxStreak: 0, tiers: [0, 0, 0, 0, 0] };
}

function nonNegative(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Coerce whatever was in storage into a well-formed stats object. */
export function normalizeStats(raw) {
  const d = defaultStats();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const tiers = Array.isArray(raw.tiers) ? raw.tiers.map((t) => Math.floor(nonNegative(t, 0))) : [];
  while (tiers.length < TIERS.length) tiers.push(0);
  return {
    played: Math.floor(nonNegative(raw.played, 0)),
    sumAvg: nonNegative(raw.sumAvg, 0),
    best: typeof raw.best === 'number' && Number.isFinite(raw.best) && raw.best > 0 ? raw.best : null,
    maxStreak: Math.floor(nonNegative(raw.maxStreak, 0)),
    tiers: tiers.slice(0, TIERS.length),
  };
}

/**
 * Current streak: consecutive puzzles ending at today (or at yesterday if
 * today is not yet done). `counts(n)` reports whether puzzle n counts.
 */
export function computeStreak(counts, todayNumber) {
  let n = counts(todayNumber) ? todayNumber : todayNumber - 1;
  let streak = 0;
  while (n >= 1 && counts(n)) {
    streak += 1;
    n -= 1;
  }
  return streak;
}

/**
 * A finished puzzle counts towards the streak only if it was finished on its
 * own day; replaying an old puzzle from the archive does not repair a streak.
 * Records without a completion time (older saves) are trusted.
 */
export function finishedOnTime(state, n) {
  if (!state || !Array.isArray(state.guesses) || state.guesses.length < QUESTIONS_PER_DAY) return false;
  if (typeof state.completedAt !== 'number') return true;
  return puzzleNumberForDate(localDateKey(new Date(state.completedAt))) <= n;
}

/** Returns a new stats object with a finished puzzle (average `avg`) recorded. */
export function recordCompletion(stats, avg, streakNow) {
  const s = normalizeStats(stats);
  s.played += 1;
  if (Number.isFinite(avg)) {
    s.sumAvg += avg;
    s.best = s.best == null ? avg : Math.min(s.best, avg);
  }
  s.tiers[tierIndex(avg)] += 1;
  s.maxStreak = Math.max(s.maxStreak, Math.floor(nonNegative(streakNow, 0)));
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
