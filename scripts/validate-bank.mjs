// Validate data/questions.json: schema, ids, duplicates, category coverage,
// and that every day's selection has five distinct categories.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuestion, questionId, isDuplicate } from './build-bank.mjs';
import { selectQuestions, firstRepeatDay, QUESTIONS_PER_DAY } from '../src/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'questions.json');
const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];

if (!Array.isArray(bank.categories) || !bank.categories.length) errors.push('no categories');
if (!Array.isArray(bank.questions) || !bank.questions.length) errors.push('no questions');

const slugs = new Set(bank.categories.map((c) => c.slug));
const ids = new Set();
bank.questions.forEach((q, i) => {
  errors.push(...validateQuestion(q, `questions[${i}]`));
  if (!slugs.has(q.category)) errors.push(`questions[${i}]: unknown category ${q.category}`);
  if (ids.has(q.id)) errors.push(`questions[${i}]: duplicate id ${q.id}`);
  ids.add(q.id);
  if (q.id !== questionId(q.category, q.question)) errors.push(`questions[${i}]: id ${q.id} does not match its text (run npm run build:bank)`);
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

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
const sizes = bank.categories.map((c) => bank.questions.filter((q) => q.category === c.slug).length);
const smallest = bank.categories[sizes.indexOf(Math.min(...sizes))];
console.log(`OK: ${bank.questions.length} questions in ${bank.categories.length} categories.`);
console.log(`First repeated question on day ${firstRepeatDay(bank)} (smallest category: ${smallest.slug} with ${Math.min(...sizes)} questions).`);
