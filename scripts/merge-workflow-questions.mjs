// One-off helper: turn fact-checked questions into data/bank/*.json, keeping
// only the old questions that already-played puzzles need (flagged retired)
// and dropping the rest. An entry carrying an "id" replaces the published
// question with that id in place (a rewording), keeping the id stable.
//
// Input: a directory holding verify-<slug>.json files, each a JSON array of
// entries with a "verdict" ("accept" | "reject") plus the question fields,
// as written by the fact-checking agents.
//
// Usage: node scripts/merge-workflow-questions.mjs <dir> [--keep-days=N] [--retire-missing] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, questionId, isDuplicate, validateQuestion } from './build-bank.mjs';
import { selectQuestions } from '../src/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const inputDir = args.find((a) => !a.startsWith('--'));
const keepDays = Number((args.find((a) => a.startsWith('--keep-days=')) || '--keep-days=3').split('=')[1]);
const dryRun = args.includes('--dry-run');
// --retire-missing: a published question absent from the fresh list is kept, retired,
// instead of being dropped, so ids players met in unlimited or timed mode still resolve.
const retireMissing = args.includes('--retire-missing');
if (!inputDir) {
  console.error('Usage: node scripts/merge-workflow-questions.mjs <dir> [--keep-days=N] [--dry-run]');
  process.exit(1);
}

const UNITS = new Set(['km', 'metres', 'cm', 'mm', 'kg', 'grams', 'tonnes', 'km/h', 'km²', 'hectares', 'litres', 'km³', 'cubic metres', '°C', 'kcal', 'joules', 'GWh', 'TWh', 'megawatts', 'minutes', 'hours', 'days', 'months', 'years', 'US$']);

/** Every accepted entry from verify-<slug>.json files in the directory. */
function readAccepted(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^verify-([a-z]+)\.json$/.exec(f);
    if (!m) continue;
    let list;
    try {
      list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      console.warn(`skip ${f}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const r of list) if (r && typeof r === 'object' && r.verdict === 'accept') out.push({ slug: m[1], ...r });
  }
  return out;
}

function tidy(r) {
  const unit = String(r.unit || '').trim();
  const q = {
    question: String(r.question || '').trim(),
    answer: Number(r.answer),
    unit,
    source_title: String(r.source_title || '').trim(),
    source_url: String(r.source_url || '').trim(),
    explainer: String(r.explainer || '').trim(),
    difficulty: Number.isInteger(r.difficulty) ? Math.min(3, Math.max(1, r.difficulty)) : 2,
    as_of: String(r.as_of || 'stable').trim() || 'stable',
  };
  if (q.question.length > 160) q.question = q.question.slice(0, 160);
  return q;
}

const accepted = readAccepted(inputDir);
const bank = JSON.parse(fs.readFileSync(path.join(root, 'data', 'questions.json'), 'utf8'));
const byId = new Map(bank.questions.map((q) => [q.id, q]));

// Old questions that scheduled days still need: keep them, retired.
const keepIds = new Set();
for (let n = 1; n <= keepDays; n++) for (const q of selectQuestions(bank, n)) keepIds.add(q.id);

const perSlug = new Map(CATEGORIES.map((c) => [c.slug, []]));
let dropped = 0;
let replaced = 0;
for (const r of accepted) {
  if (!perSlug.has(r.slug)) continue;
  const q = tidy(r);
  const problems = validateQuestion(q, `${r.slug}:${q.question.slice(0, 40)}`);
  if (!(q.answer >= 1 && q.answer <= 1e18)) problems.push('answer out of range');
  if (!q.unit) problems.push('no unit');
  if (problems.length) {
    console.warn(`skip: ${problems.join('; ')}`);
    dropped++;
    continue;
  }
  // A reworded question keeps the id it was first published under, so days
  // already played with it still resolve and its wording simply updates.
  const explicitId = typeof r.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(r.id) ? r.id : null;
  const id = explicitId || questionId(r.slug, q.question);
  const list = perSlug.get(r.slug);
  if (list.some((o) => o.id === id)) {
    console.warn(`skip duplicate id: ${q.question}`);
    dropped++;
    continue;
  }
  if (list.some((o) => isDuplicate(o, q)) || [...keepIds].some((kid) => kid !== id && isDuplicate(byId.get(kid), q))) {
    console.warn(`skip duplicate: ${q.question}`);
    dropped++;
    continue;
  }
  const existing = byId.get(id);
  if (existing) replaced++;
  list.push({ id, ...q, ...(existing?.retired ? { retired: true } : {}) });
}

let total = 0;
for (const cat of CATEGORIES) {
  const fresh = perSlug.get(cat.slug);
  const freshIds = new Set(fresh.map((q) => q.id));
  // Entries already retired stay (their ids must keep resolving); entries the
  // kept days need are retired unless a fresh entry replaces them in place.
  const kept = bank.questions
    .filter((q) => q.category === cat.slug && !freshIds.has(q.id) && (q.retired || keepIds.has(q.id) || retireMissing))
    .map(({ category, ...q }) => ({ ...q, retired: true }));
  total += fresh.length;
  const file = path.join(root, 'data', 'bank', `${cat.slug}.json`);
  console.log(`${cat.slug}: ${fresh.length} new, ${kept.length} retired`);
  if (!dryRun) fs.writeFileSync(file, JSON.stringify([...kept, ...fresh], null, 2) + '\n');
}
console.log(`${total} questions written (${replaced} replacing a published entry in place, ${dropped} skipped) from ${accepted.length} accepted verdicts${dryRun ? ' [dry run]' : ''}.`);
