// Merge data/bank/*.json (one file per category) into data/questions.json.
//
// - Category order comes from CATEGORIES below (that order drives the daily
//   rotation, so append new categories at the end).
// - Each question gets a stable id derived from its category and text, so
//   editing an answer keeps the id while rewording a question changes it.
// - Existing question order in data/questions.json is preserved and new
//   questions are appended in a deterministic shuffled order, so adding
//   questions never changes puzzles that were already scheduled.
// - Near-duplicate questions (high word overlap) are dropped with a warning.
//
// Usage: node scripts/build-bank.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bankDir = path.join(root, 'data', 'bank');
const outFile = path.join(root, 'data', 'questions.json');

export const CATEGORIES = [
  { slug: 'geography', name: 'Geography & Earth' },
  { slug: 'space', name: 'Space & Astronomy' },
  { slug: 'science', name: 'Science & Physics' },
  { slug: 'body', name: 'Human Body & Health' },
  { slug: 'animals', name: 'Animals & Nature' },
  { slug: 'history', name: 'History' },
  { slug: 'population', name: 'People & Society' },
  { slug: 'money', name: 'Money & Economy' },
  { slug: 'tech', name: 'Technology & Internet' },
  { slug: 'sports', name: 'Sports & Games' },
  { slug: 'food', name: 'Food & Drink' },
  { slug: 'culture', name: 'Culture & Entertainment' },
  { slug: 'everyday', name: 'Everyday Life & Objects' },
  { slug: 'transport', name: 'Transport & Infrastructure' },
];

const REQUIRED = ['question', 'answer', 'unit', 'source_title', 'source_url', 'explainer', 'difficulty', 'as_of'];

export function hash32(str) {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}

const STOP = new Set(['how', 'many', 'much', 'the', 'a', 'an', 'of', 'in', 'is', 'are', 'was', 'were', 'what', 'to', 'on', 'at', 'by', 'and', 'or', 'as', 'for', 'with', 'did', 'does', 'do', 'there', 'it', 'its', 'per', 'long', 'far', 'tall', 'high', 'big']);

export function similarity(a, b) {
  const sa = new Set(normalize(a));
  const sb = new Set(normalize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

export function questionId(slug, question) {
  return `${slug}-${hash32(normalize(question).join(' ')).toString(36)}`;
}

export function validateQuestion(q, where) {
  const problems = [];
  for (const k of REQUIRED) if (!(k in q)) problems.push(`missing ${k}`);
  if (typeof q.question !== 'string' || q.question.trim().length < 10) problems.push('question too short');
  if (typeof q.question === 'string' && q.question.length > 160) problems.push('question longer than 160 chars');
  if (typeof q.answer !== 'number' || !Number.isFinite(q.answer) || q.answer <= 0) problems.push('answer must be a positive number');
  if (typeof q.unit !== 'string' || !q.unit.trim()) problems.push('unit missing');
  if (typeof q.source_url !== 'string' || !/^https?:\/\//.test(q.source_url)) problems.push('source_url must be http(s)');
  if (!Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 3) problems.push('difficulty must be 1-3');
  if (typeof q.explainer !== 'string' || !q.explainer.trim()) problems.push('explainer missing');
  if (typeof q.as_of !== 'string' || !q.as_of.trim()) problems.push('as_of missing');
  return problems.map((p) => `${where}: ${p}`);
}

export function buildBank({ files, existing }) {
  const errors = [];
  const warnings = [];
  const all = [];
  const seenIds = new Set();

  for (const cat of CATEGORIES) {
    const list = files[cat.slug];
    if (!list) {
      warnings.push(`no file for category ${cat.slug}`);
      continue;
    }
    list.forEach((raw, idx) => {
      const where = `${cat.slug}[${idx}]`;
      const probs = validateQuestion(raw, where);
      if (probs.length) {
        errors.push(...probs);
        return;
      }
      const q = {
        id: questionId(cat.slug, raw.question),
        category: cat.slug,
        question: raw.question.trim(),
        answer: raw.answer,
        unit: raw.unit.trim(),
        explainer: raw.explainer.trim(),
        source_title: raw.source_title.trim(),
        source_url: raw.source_url.trim(),
        as_of: raw.as_of.trim(),
        difficulty: raw.difficulty,
      };
      if (seenIds.has(q.id)) {
        warnings.push(`${where}: duplicate of an earlier question, skipped`);
        return;
      }
      const dup = all.find((o) => similarity(o.question, q.question) >= 0.75);
      if (dup) {
        warnings.push(`${where}: too similar to ${dup.id} ("${dup.question}"), skipped`);
        return;
      }
      seenIds.add(q.id);
      all.push(q);
    });
  }

  // Preserve order of questions already in the merged file; append the rest
  // in a deterministic shuffled order (sorted by hash of the id).
  const existingOrder = new Map((existing?.questions || []).map((q, i) => [q.id, i]));
  const byId = new Map(all.map((q) => [q.id, q]));
  const kept = (existing?.questions || []).filter((q) => byId.has(q.id)).map((q) => byId.get(q.id));
  const fresh = all.filter((q) => !existingOrder.has(q.id)).sort((a, b) => hash32('salt:' + a.id) - hash32('salt:' + b.id));
  const removed = (existing?.questions || []).filter((q) => !byId.has(q.id));
  if (removed.length) warnings.push(`${removed.length} previously published question(s) removed: ${removed.map((q) => q.id).join(', ')}`);

  const questions = [...kept, ...fresh];
  const categories = CATEGORIES.filter((c) => questions.some((q) => q.category === c.slug));
  return { bank: { version: 1, categories, questions }, errors, warnings };
}

function main() {
  const files = {};
  if (fs.existsSync(bankDir)) {
    for (const f of fs.readdirSync(bankDir)) {
      if (!f.endsWith('.json')) continue;
      const slug = f.replace(/\.json$/, '');
      try {
        files[slug] = JSON.parse(fs.readFileSync(path.join(bankDir, f), 'utf8'));
      } catch (err) {
        console.error(`Cannot parse ${f}: ${err.message}`);
        process.exit(1);
      }
      if (!CATEGORIES.some((c) => c.slug === slug)) console.warn(`warning: ${f} is not a known category; add it to CATEGORIES in scripts/build-bank.mjs`);
    }
  }
  let existing = null;
  if (fs.existsSync(outFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch {
      existing = null;
    }
  }
  const { bank, errors, warnings } = buildBank({ files, existing });
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  fs.writeFileSync(outFile, JSON.stringify(bank, null, 1) + '\n');
  const perCat = bank.categories.map((c) => `${c.slug}=${bank.questions.filter((q) => q.category === c.slug).length}`).join(', ');
  console.log(`Wrote ${bank.questions.length} questions in ${bank.categories.length} categories to data/questions.json (${perCat})`);
  console.log(`That covers ${Math.floor(bank.questions.length / 5)} days before any question repeats.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
