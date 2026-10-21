import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBank, validateQuestion, isDuplicate, questionId } from '../scripts/build-bank.mjs';

function entry(overrides = {}) {
  return {
    question: 'How many kilometres of railway does India have in total?',
    answer: 68000,
    unit: 'km',
    source_title: 'Indian Railways',
    source_url: 'https://example.com/rail',
    explainer: 'A lot of track.',
    difficulty: 2,
    as_of: '2023',
    ...overrides,
  };
}

test('validateQuestion catches malformed entries', () => {
  assert.deepEqual(validateQuestion(entry(), 'x'), []);
  assert.ok(validateQuestion(null, 'x')[0].includes('object'));
  assert.ok(validateQuestion('text', 'x')[0].includes('object'));
  assert.ok(validateQuestion(entry({ source_title: null }), 'x').some((p) => p.includes('source_title')));
  assert.ok(validateQuestion(entry({ answer: '5' }), 'x').some((p) => p.includes('answer')));
  assert.ok(validateQuestion(entry({ source_url: 'javascript:alert(1)' }), 'x').some((p) => p.includes('source_url')));
  assert.ok(validateQuestion(entry({ id: 'Bad Id!' }), 'x').some((p) => p.includes('id')));
  assert.ok(validateQuestion(entry({ allow_similar: 'yes' }), 'x').some((p) => p.includes('allow_similar')));
});

test('an explicit id survives rewording; a derived id does not', () => {
  const first = buildBank({ files: { transport: [entry({ id: 'transport-rail' })] }, existing: null });
  assert.deepEqual(first.errors, []);
  assert.equal(first.bank.questions[0].id, 'transport-rail');
  const reworded = buildBank({ files: { transport: [entry({ id: 'transport-rail', question: 'How many kilometres of railway track does India have?' })] }, existing: first.bank });
  assert.deepEqual(reworded.errors, []);
  assert.equal(reworded.bank.questions[0].question, 'How many kilometres of railway track does India have?');
  assert.deepEqual(reworded.removed, []);

  const derived = buildBank({ files: { transport: [entry()] }, existing: null });
  assert.equal(derived.bank.questions[0].id, questionId('transport', entry().question));
  const rewordedDerived = buildBank({ files: { transport: [entry({ question: 'How many kilometres of railway track does India have?' })] }, existing: derived.bank });
  assert.equal(rewordedDerived.removed.length, 1);
  assert.ok(rewordedDerived.errors[0].includes('--allow-remove'));
  const allowed = buildBank({ files: { transport: [entry({ question: 'How many kilometres of railway track does India have?' })] }, existing: derived.bank, allowRemove: true });
  assert.deepEqual(allowed.errors, []);
  assert.ok(allowed.warnings.some((w) => w.includes('removed')));
});

test('published order is kept and new questions are appended', () => {
  const a = entry({ id: 'transport-a' });
  const b = entry({ id: 'transport-b', question: 'How many passengers used Heathrow airport in 2024?', answer: 83900000, unit: 'passengers' });
  const c = entry({ id: 'transport-c', question: 'How many Boeing 747 aircraft were built in total?', answer: 1574, unit: 'aircraft' });
  const first = buildBank({ files: { transport: [a, b] }, existing: null });
  const order = first.bank.questions.map((q) => q.id);
  const second = buildBank({ files: { transport: [c, b, a] }, existing: first.bank });
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.bank.questions.map((q) => q.id), [...order, 'transport-c']);
});

test('duplicates, conflicts, unknown categories and bad files are errors', () => {
  const dup = buildBank({ files: { transport: [entry({ id: 'x1' }), entry({ id: 'x2', question: 'How many kilometres of railway track does India have in total?' })] }, existing: null });
  assert.ok(dup.errors.some((e) => e.includes('duplicate')));
  const ok = buildBank({ files: { transport: [entry({ id: 'x1' }), entry({ id: 'x2', question: 'How many kilometres of railway track does India have in total?', allow_similar: true })] }, existing: null });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.bank.questions.length, 2);

  const conflict = buildBank({ files: { transport: [entry({ id: 'x1' }), entry({ id: 'x1', answer: 70000 })] }, existing: null });
  assert.ok(conflict.errors.some((e) => e.includes('same id')));
  const identical = buildBank({ files: { transport: [entry({ id: 'x1' }), entry({ id: 'x1' })] }, existing: null });
  assert.deepEqual(identical.errors, []);
  assert.equal(identical.bank.questions.length, 1);

  const unknown = buildBank({ files: { weather: [entry()] }, existing: null });
  assert.ok(unknown.errors.some((e) => e.includes('not a known category')));
  const notArray = buildBank({ files: { transport: { questions: [] } }, existing: null });
  assert.ok(notArray.errors.some((e) => e.includes('JSON array')));
  const nullEntry = buildBank({ files: { transport: [null] }, existing: null });
  assert.ok(nullEntry.errors.some((e) => e.includes('object')));
});

test('isDuplicate needs similar wording and a similar answer', () => {
  const malaria = { question: 'How many people died of malaria worldwide in 2023?', answer: 597000 };
  const tb = { question: 'How many people died of tuberculosis worldwide in 2023?', answer: 1250000 };
  assert.equal(isDuplicate(malaria, tb), false);
  const netflix = { question: 'How many paid subscribers did Netflix have worldwide at the end of 2024?', answer: 301630000 };
  const netflix2 = { question: 'How many paid Netflix subscribers were there worldwide at the end of 2024?', answer: 301600000 };
  assert.equal(isDuplicate(netflix, netflix2), true);
});
