// One-off helper: turn the fact-checked questions from the "fun-fermi-questions"
// workflow journal into data/bank/*.json, keeping only the old questions that
// already-played puzzles need (flagged retired) and dropping the rest.
//
// Usage: node scripts/merge-workflow-questions.mjs <journal.jsonl> [--keep-days N] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, questionId, isDuplicate, validateQuestion } from './build-bank.mjs';
import { selectQuestions } from '../src/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const journalFile = args.find((a) => !a.startsWith('--'));
const keepDays = Number((args.find((a) => a.startsWith('--keep-days=')) || '--keep-days=3').split('=')[1]);
const dryRun = args.includes('--dry-run');
if (!journalFile) {
  console.error('Usage: node scripts/merge-workflow-questions.mjs <journal.jsonl> [--keep-days=N] [--dry-run]');
  process.exit(1);
}

const UNITS = new Set(['km', 'metres', 'cm', 'mm', 'kg', 'grams', 'tonnes', 'km/h', 'km²', 'hectares', 'litres', 'km³', 'cubic metres', '°C', 'kcal', 'joules', 'GWh', 'TWh', 'megawatts', 'minutes', 'hours', 'days', 'months', 'years', 'US$']);

/** Every accepted verifier result, newest first per label (a resumed run may log a label twice). */
function readAccepted(file) {
  const byLabel = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const label = j.label || j.opts?.label || '';
    if (!label.startsWith('verify:')) continue;
    const result = j.result ?? j.value ?? j.output ?? null;
    if (result && typeof result === 'object') byLabel.set(label, result);
  }
  const out = [];
  for (const [label, r] of byLabel) {
    if (r.verdict !== 'accept') continue;
    const slug = label.split(':')[1];
    out.push({ slug, ...r });
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

const accepted = readAccepted(journalFile);
const bank = JSON.parse(fs.readFileSync(path.join(root, 'data', 'questions.json'), 'utf8'));
const byId = new Map(bank.questions.map((q) => [q.id, q]));

// Old questions that scheduled days still need: keep them, retired.
const keepIds = new Set();
for (let n = 1; n <= keepDays; n++) for (const q of selectQuestions(bank, n)) keepIds.add(q.id);

const perSlug = new Map(CATEGORIES.map((c) => [c.slug, []]));
let dropped = 0;
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
  const list = perSlug.get(r.slug);
  if (list.some((o) => isDuplicate(o, q)) || [...keepIds].some((id) => isDuplicate(byId.get(id), q))) {
    console.warn(`skip duplicate: ${q.question}`);
    dropped++;
    continue;
  }
  list.push({ id: questionId(r.slug, q.question), ...q });
}

let total = 0;
for (const cat of CATEGORIES) {
  const kept = bank.questions.filter((q) => q.category === cat.slug && keepIds.has(q.id)).map(({ category, ...q }) => ({ ...q, retired: true }));
  const fresh = perSlug.get(cat.slug);
  total += fresh.length;
  const file = path.join(root, 'data', 'bank', `${cat.slug}.json`);
  console.log(`${cat.slug}: ${fresh.length} new, ${kept.length} retired`);
  if (!dryRun) fs.writeFileSync(file, JSON.stringify([...kept, ...fresh], null, 2) + '\n');
}
console.log(`${total} questions written (${dropped} skipped) from ${accepted.length} accepted verdicts${dryRun ? ' [dry run]' : ''}.`);
