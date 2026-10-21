import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPOCH_DATE_KEY,
  QUESTIONS_PER_DAY,
  puzzleNumberForDate,
  dateKeyForPuzzle,
  localDateKey,
  formatDateKey,
  msUntilLocalMidnight,
  formatCountdown,
  scoreMultiple,
  dailyScore,
  formatMultiple,
  tierFor,
  tierIndex,
  parseNumber,
  formatNumber,
  formatCompact,
  scalePosition,
  selectQuestions,
  categoriesWithQuestions,
  computeStreak,
  recordCompletion,
  defaultStats,
  shareText,
  canonicalDigits,
  firstRepeatDay,
  finishedOnTime,
  normalizeStats,
  MAX_MULTIPLE,
} from '../src/logic.js';

// --- dates -----------------------------------------------------------------

test('epoch date is puzzle No. 1 and numbering is contiguous', () => {
  assert.equal(puzzleNumberForDate(EPOCH_DATE_KEY), 1);
  assert.equal(puzzleNumberForDate('2026-10-22'), 2);
  assert.equal(puzzleNumberForDate('2026-11-01'), 12);
  assert.equal(puzzleNumberForDate('2027-10-21'), 366);
  assert.equal(puzzleNumberForDate('2026-10-20'), 0);
});

test('dateKeyForPuzzle inverts puzzleNumberForDate across DST and year ends', () => {
  for (let n = 1; n <= 1200; n += 7) {
    assert.equal(puzzleNumberForDate(dateKeyForPuzzle(n)), n);
  }
  assert.equal(dateKeyForPuzzle(1), EPOCH_DATE_KEY);
  assert.equal(dateKeyForPuzzle(72), '2026-12-31');
  assert.equal(dateKeyForPuzzle(73), '2027-01-01');
});

test('localDateKey uses local calendar fields', () => {
  const d = new Date(2026, 2, 5, 23, 59); // 5 March 2026 local
  assert.equal(localDateKey(d), '2026-03-05');
  assert.equal(puzzleNumberForDate('bogus'), NaN);
});

test('formatDateKey renders the same calendar day in any time zone', () => {
  assert.match(formatDateKey('2026-10-21', 'en-GB'), /21 Oct 2026/);
  assert.match(formatDateKey('2026-10-21', 'en-US'), /Oct 21, 2026/);
  assert.equal(formatDateKey('nope'), 'nope');
});

test('countdown to local midnight', () => {
  const d = new Date(2026, 9, 21, 22, 30, 15);
  const ms = msUntilLocalMidnight(d);
  assert.equal(formatCountdown(ms), '01:29:45');
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(-5), '00:00:00');
});

// --- scoring ---------------------------------------------------------------

test('scoreMultiple is symmetric, 1 when exact, capped when invalid or absurd', () => {
  assert.equal(scoreMultiple(100, 100), 1);
  assert.equal(scoreMultiple(200, 100), 2);
  assert.equal(scoreMultiple(50, 100), 2);
  assert.equal(scoreMultiple(1, 1e6), 1e6);
  assert.equal(scoreMultiple(0, 10), MAX_MULTIPLE);
  assert.equal(scoreMultiple(-5, 10), MAX_MULTIPLE);
  assert.equal(scoreMultiple(NaN, 10), MAX_MULTIPLE);
  assert.equal(scoreMultiple(10, 0), MAX_MULTIPLE);
  assert.equal(scoreMultiple(1e308, 0.5), MAX_MULTIPLE);
  assert.equal(scoreMultiple(1e-320, 1), MAX_MULTIPLE);
  assert.ok(Number.isFinite(dailyScore([scoreMultiple(1e308, 0.5), 1])));
  // floating-point noise is tidied so display and tier agree
  assert.equal(scoreMultiple(0.003, 0.0003), 10);
  assert.equal(tierFor(scoreMultiple(0.003, 0.0003)).label, 'Off');
  assert.equal(tierFor(scoreMultiple(0.0015, 0.0003)).label, 'Close');
});

test('dailyScore is the arithmetic mean', () => {
  assert.equal(dailyScore([1, 2, 3, 4, 5]), 3);
  assert.equal(dailyScore([1.5]), 1.5);
  assert.ok(Number.isNaN(dailyScore([])));
});

test('formatMultiple precision bands', () => {
  assert.equal(formatMultiple(1), '1.00×');
  assert.equal(formatMultiple(1.2345), '1.23×');
  assert.equal(formatMultiple(9.994), '9.99×');
  assert.equal(formatMultiple(9.999), '10.0×');
  assert.equal(formatMultiple(10.000000000000002), '10.0×');
  assert.equal(formatMultiple(12.34), '12.3×');
  assert.equal(formatMultiple(99.94), '99.9×');
  assert.equal(formatMultiple(99.96), '100×');
  assert.equal(formatMultiple(123.4), '123×');
  assert.equal(formatMultiple(12345.6), '12,346×');
  assert.equal(formatMultiple(Infinity), '∞×');
});

test('tiers', () => {
  assert.equal(tierFor(1).label, 'Spot on');
  assert.equal(tierFor(1.1).label, 'Spot on');
  assert.equal(tierFor(1.11).label, 'Great');
  assert.equal(tierFor(2).label, 'Great');
  assert.equal(tierFor(4.9).label, 'Close');
  assert.equal(tierFor(9).label, 'Off');
  assert.equal(tierFor(10.01).label, 'Way off');
  assert.equal(tierFor(Infinity).label, 'Way off');
  assert.equal(tierIndex(1), 0);
  assert.equal(tierIndex(1e9), 4);
});

// --- parsing ---------------------------------------------------------------

test('parseNumber accepts human formats', () => {
  assert.equal(parseNumber('1500'), 1500);
  assert.equal(parseNumber('1,500'), 1500);
  assert.equal(parseNumber('1 500 000'), 1500000);
  assert.equal(parseNumber('1_000'), 1000);
  assert.equal(parseNumber('1.5k'), 1500);
  assert.equal(parseNumber('1.5 K'), 1500);
  assert.equal(parseNumber('2M'), 2e6);
  assert.equal(parseNumber('2 million'), 2e6);
  assert.equal(parseNumber('3B'), 3e9);
  assert.equal(parseNumber('3bn'), 3e9);
  assert.equal(parseNumber('3 billion'), 3e9);
  assert.equal(parseNumber('4T'), 4e12);
  assert.equal(parseNumber('4 trillion'), 4e12);
  assert.equal(parseNumber('1e6'), 1e6);
  assert.equal(parseNumber('2.5E9'), 2.5e9);
  assert.equal(parseNumber('$4,000'), 4000);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('0.25'), 0.25);
  assert.equal(parseNumber('  42  '), 42);
  assert.equal(parseNumber(7), 7);
});

test('parseNumber reads a decimal comma but never a sloppy thousands group', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('0,25'), 0.25);
  assert.equal(parseNumber('2,5 million'), 2.5e6);
  assert.equal(parseNumber('1 234,56'), 1234.56);
  assert.equal(parseNumber('1,500.25'), 1500.25);
  assert.equal(parseNumber('1,00'), 1);
  for (const bad of ['1,0000', '1234,567', '1,000,00', '1,', '1,2,3']) {
    assert.ok(Number.isNaN(parseNumber(bad)), `expected NaN for ${bad}`);
  }
});

test('canonicalDigits', () => {
  assert.equal(canonicalDigits('1,500'), '1500');
  assert.equal(canonicalDigits('1 500 000'), '1500000');
  assert.equal(canonicalDigits('1_000.5'), '1000.5');
  assert.equal(canonicalDigits('.5'), '.5');
  assert.equal(canonicalDigits('5.'), '5.');
  assert.equal(canonicalDigits('1,5'), '1.5');
  assert.equal(canonicalDigits('12,34'), '12.34');
  assert.equal(canonicalDigits('1,,2'), null);
  assert.equal(canonicalDigits(''), null);
  assert.equal(canonicalDigits('abc'), null);
  assert.equal(canonicalDigits('1.2.3'), null);
});

test('parseNumber strips the unit label when given', () => {
  assert.equal(parseNumber('5000 km', 'km'), 5000);
  assert.equal(parseNumber('5000km', 'km'), 5000);
  assert.equal(parseNumber('2 million people', 'people'), 2e6);
  assert.equal(parseNumber('120 US$', 'US$'), 120);
});

test('parseNumber rejects non-numbers', () => {
  for (const bad of ['', '   ', 'abc', '5 km', '1.2.3', '-5', '1e', '12x', '3 miles', null, undefined, '1,,2', '5 constructor', '2 __proto__']) {
    assert.ok(Number.isNaN(parseNumber(bad)), `expected NaN for ${JSON.stringify(bad)}`);
  }
});

test('formatNumber and formatCompact', () => {
  assert.equal(formatNumber(1500000), '1,500,000');
  assert.equal(formatNumber(42), '42');
  assert.equal(formatNumber(3.14159), '3.142');
  assert.equal(formatNumber(0.5), '0.5');
  assert.equal(formatNumber(1234.6), '1,235');
  assert.equal(formatNumber(Infinity), '—');
  assert.equal(formatNumber(2.5e22), '2.50e+22');
  assert.equal(formatCompact(1500000), '1.5 million');
  assert.equal(formatCompact(2.34e9), '2.34 billion');
  assert.equal(formatCompact(999999999999), '1 trillion');
  assert.equal(formatCompact(45000), '45 thousand');
  assert.equal(formatCompact(1234), null);
  assert.equal(formatCompact(NaN), null);
  assert.equal(formatCompact(2e16), '20 quadrillion');
  assert.equal(formatCompact(4.3252e19), '43.3 quintillion');
  assert.equal(formatCompact(6.67e21), '6.67 sextillion');
});

test('scalePosition is centred and clamped', () => {
  assert.equal(scalePosition(100, 100), 50);
  assert.equal(scalePosition(1000, 100), 75);
  assert.equal(scalePosition(10, 100), 25);
  assert.equal(scalePosition(1e9, 1), 105);
  assert.equal(scalePosition(1, 1e9), -5);
});

// --- selection -------------------------------------------------------------

function fakeBank(catCount, perCat) {
  const categories = [];
  const questions = [];
  for (let c = 0; c < catCount; c++) {
    categories.push({ slug: `c${c}`, name: `Cat ${c}` });
    for (let q = 0; q < perCat; q++) {
      questions.push({ id: `c${c}-${q}`, category: `c${c}`, question: `Q${c}.${q}`, answer: 10 ** q, unit: 'u' });
    }
  }
  return { categories, questions };
}

test('selectQuestions gives five distinct categories per day and no repeats until exhausted', () => {
  const bank = fakeBank(14, 20);
  const seen = new Set();
  const totalDays = Math.floor((14 * 20) / QUESTIONS_PER_DAY); // 56 days without repeats
  for (let n = 1; n <= totalDays; n++) {
    const qs = selectQuestions(bank, n);
    assert.equal(qs.length, QUESTIONS_PER_DAY);
    const cats = new Set(qs.map((q) => q.category));
    assert.equal(cats.size, QUESTIONS_PER_DAY, `day ${n} has duplicate categories`);
    for (const q of qs) {
      assert.ok(!seen.has(q.id), `day ${n} repeats ${q.id}`);
      seen.add(q.id);
      assert.equal(q.categoryName, `Cat ${q.category.slice(1)}`);
    }
  }
  assert.equal(seen.size, 14 * 20);
  // day 57 starts cycling again, deterministically
  assert.deepEqual(selectQuestions(bank, totalDays + 1).map((q) => q.id), selectQuestions(bank, 1).map((q) => q.id));
});

test('selectQuestions is deterministic and tolerates small banks', () => {
  const bank = fakeBank(3, 2);
  const a = selectQuestions(bank, 4).map((q) => q.id);
  const b = selectQuestions(bank, 4).map((q) => q.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  assert.deepEqual(selectQuestions({ categories: [], questions: [] }, 1), []);
  assert.deepEqual(selectQuestions(bank, NaN), []);
  assert.deepEqual(selectQuestions(bank, 0), []);
  assert.deepEqual(selectQuestions(bank, -3), []);
});

test('firstRepeatDay reports when the smallest category wraps', () => {
  assert.equal(firstRepeatDay(fakeBank(14, 20)), 57);
  const uneven = fakeBank(14, 20);
  uneven.questions = uneven.questions.filter((q) => !(q.category === 'c0' && Number(q.id.split('-')[1]) >= 10));
  assert.equal(firstRepeatDay(uneven), 29);
  // confirm by brute force
  const seen = new Set();
  let firstRepeat = null;
  for (let n = 1; n <= 100 && firstRepeat === null; n++) {
    for (const q of selectQuestions(uneven, n)) {
      if (seen.has(q.id)) { firstRepeat = n; break; }
      seen.add(q.id);
    }
  }
  assert.equal(firstRepeat, 29);
  assert.equal(firstRepeatDay({ categories: [], questions: [] }), 0);
});

test('categoriesWithQuestions skips empty categories and keeps order', () => {
  const bank = fakeBank(3, 1);
  bank.categories.push({ slug: 'empty', name: 'Empty' });
  const cats = categoriesWithQuestions(bank);
  assert.deepEqual(cats.map((c) => c.slug), ['c0', 'c1', 'c2']);
});

// --- stats -----------------------------------------------------------------

test('computeStreak counts back from today or yesterday', () => {
  const done = new Set([5, 6, 7]);
  const isDone = (n) => done.has(n);
  assert.equal(computeStreak(isDone, 7), 3);
  assert.equal(computeStreak(isDone, 8), 3); // today not played yet, streak alive
  assert.equal(computeStreak(isDone, 9), 0); // missed yesterday
  assert.equal(computeStreak(() => false, 1), 0);
  assert.equal(computeStreak((n) => n === 1, 1), 1);
});

test('finishedOnTime only accepts puzzles completed on their own day', () => {
  const dayOf = (n, hour = 12) => {
    const [y, m, d] = dateKeyForPuzzle(n).split('-').map(Number);
    return new Date(y, m - 1, d, hour).getTime();
  };
  const done = (n, at) => ({ guesses: [1, 1, 1, 1, 1], completedAt: at });
  assert.equal(finishedOnTime(done(7, dayOf(7)), 7), true);
  assert.equal(finishedOnTime(done(7, dayOf(7, 23)), 7), true);
  assert.equal(finishedOnTime(done(7, dayOf(8)), 7), false); // played from the archive
  assert.equal(finishedOnTime({ guesses: [1, 1, 1, 1, 1] }, 7), true); // legacy record
  assert.equal(finishedOnTime({ guesses: [1, 1] }, 7), false);
  assert.equal(finishedOnTime(null, 7), false);
});

test('normalizeStats repairs corrupt storage', () => {
  assert.deepEqual(normalizeStats(null), defaultStats());
  assert.deepEqual(normalizeStats('junk'), defaultStats());
  assert.deepEqual(normalizeStats({ played: '3', tiers: 5 }), defaultStats());
  assert.deepEqual(normalizeStats({ played: 2.7, sumAvg: -1, best: 0, maxStreak: 3, tiers: [1, 'x', 2] }), {
    played: 2, sumAvg: 0, best: null, maxStreak: 3, tiers: [1, 0, 2, 0, 0],
  });
  const s = recordCompletion({ played: 1, tiers: 5 }, 20, 0);
  assert.equal(s.played, 2);
  assert.deepEqual(s.tiers, [0, 0, 0, 0, 1]);
});

test('recordCompletion updates played, best, tiers and max streak', () => {
  let s = recordCompletion(defaultStats(), 3.2, 1);
  assert.equal(s.played, 1);
  assert.equal(s.best, 3.2);
  assert.equal(s.maxStreak, 1);
  assert.deepEqual(s.tiers, [0, 0, 1, 0, 0]);
  s = recordCompletion(s, 1.05, 2);
  assert.equal(s.played, 2);
  assert.equal(s.best, 1.05);
  assert.equal(s.maxStreak, 2);
  assert.deepEqual(s.tiers, [1, 0, 1, 0, 0]);
  assert.equal(s.sumAvg, 4.25);
  // tolerates missing/legacy fields and a non-finite average
  s = recordCompletion({ played: 1 }, 20, 0);
  assert.equal(s.played, 2);
  assert.deepEqual(s.tiers, [0, 0, 0, 0, 1]);
  s = recordCompletion(s, Infinity, 0);
  assert.equal(s.played, 3);
  assert.deepEqual(s.tiers, [0, 0, 0, 0, 2]);
  assert.equal(s.sumAvg, 20);
});

// --- share -----------------------------------------------------------------

test('shareText format', () => {
  const text = shareText({ puzzleNumber: 12, dateKey: '2026-11-01', multiples: [1, 1.8, 3.2, 14, 1.3], url: 'https://example.com/' });
  assert.equal(
    text,
    ['Fermi No. 12 · 1 Nov 2026', '🎯 1.00×  🟢 1.80×  🟡 3.20×  🔴 14.0×  🟢 1.30×', 'Average 4.26×', 'https://example.com/'].join('\n'),
  );
  const noUrl = shareText({ puzzleNumber: 1, dateKey: '2026-10-21', multiples: [1] });
  assert.equal(noUrl.split('\n').length, 3);
});
