// Validate data/questions.json: schema, ids, duplicates, category coverage,
// that every day's selection has five distinct categories and questions, and
// that the file is exactly what data/bank/*.json would build (so a forgotten
// `npm run build:bank` fails CI instead of shipping stale questions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuestion, isDuplicate, buildBank, readBankFiles, workerBankSource } from './build-bank.mjs';
import { selectQuestions, firstRepeatDay, QUESTIONS_PER_DAY } from '../src/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'questions.json');
const errors = [];

let bank;
try {
  bank = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`error: cannot read data/questions.json: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(bank.categories) || !bank.categories.length) errors.push('no categories');
if (!Array.isArray(bank.questions) || !bank.questions.length) errors.push('no questions');
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

for (const c of bank.categories) {
  if (typeof c.slug !== 'string' || typeof c.name !== 'string') errors.push(`category ${JSON.stringify(c)} needs a slug and a name`);
}
const slugs = new Set(bank.categories.map((c) => c.slug));
const ids = new Set();
bank.questions.forEach((q, i) => {
  errors.push(...validateQuestion(q, `questions[${i}]`));
  if (!q || typeof q !== 'object') return;
  if (typeof q.id !== 'string') errors.push(`questions[${i}]: missing id`);
  if (!slugs.has(q.category)) errors.push(`questions[${i}]: unknown category ${q.category}`);
  if (ids.has(q.id)) errors.push(`questions[${i}]: duplicate id ${q.id}`);
  ids.add(q.id);
  for (let j = 0; j < i; j++) {
    if (isDuplicate(bank.questions[j], q)) errors.push(`questions[${i}] looks like a duplicate of questions[${j}]`);
  }
});

for (const c of bank.categories) {
  const n = bank.questions.filter((q) => q.category === c.slug).length;
  if (n === 0) errors.push(`category ${c.slug} has no questions`);
}

if (bank.categories.length < QUESTIONS_PER_DAY) {
  errors.push(`only ${bank.categories.length} categories; at least ${QUESTIONS_PER_DAY} are needed so a day never repeats a category`);
} else {
  for (let day = 1; day <= 400; day++) {
    const qs = selectQuestions(bank, day);
    if (qs.length !== QUESTIONS_PER_DAY) errors.push(`day ${day}: ${qs.length} questions`);
    if (new Set(qs.map((q) => q.category)).size !== QUESTIONS_PER_DAY) errors.push(`day ${day}: repeated category`);
    if (new Set(qs.map((q) => q.id)).size !== QUESTIONS_PER_DAY) errors.push(`day ${day}: repeated question`);
  }
}

// The merged file must match what the source files build to.
try {
  const files = readBankFiles();
  const rebuilt = buildBank({ files, existing: bank, allowRemove: true });
  for (const e of rebuilt.errors) errors.push(`data/bank: ${e}`);
  if (!rebuilt.errors.length && JSON.stringify(rebuilt.bank) !== JSON.stringify(bank)) {
    errors.push('data/questions.json is out of date with data/bank/*.json: run npm run build:bank and commit the result');
  }
} catch (err) {
  errors.push(err.message);
}

try {
  const current = fs.readFileSync(path.join(root, 'worker', 'src', 'bank.js'), 'utf8');
  if (current !== workerBankSource(bank)) errors.push('worker/src/bank.js is out of date with data/questions.json: run npm run build:bank');
} catch {
  errors.push('worker/src/bank.js is missing: run npm run build:bank');
}

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
const sizes = bank.categories.map((c) => bank.questions.filter((q) => q.category === c.slug).length);
const smallest = bank.categories[sizes.indexOf(Math.min(...sizes))];
console.log(`OK: ${bank.questions.length} questions in ${bank.categories.length} categories.`);
console.log(`First repeated question on day ${firstRepeatDay(bank)} (smallest category: ${smallest.slug} with ${Math.min(...sizes)} questions).`);
