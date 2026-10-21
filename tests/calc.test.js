import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tryEvaluate, tokenize, CalcError } from '../src/calc.js';

test('basic arithmetic and precedence', () => {
  assert.equal(evaluate('1+2'), 3);
  assert.equal(evaluate('2 + 3 * 4'), 14);
  assert.equal(evaluate('(2 + 3) * 4'), 20);
  assert.equal(evaluate('10 / 4'), 2.5);
  assert.equal(evaluate('7 - 10'), -3);
  assert.equal(evaluate('2^10'), 1024);
  assert.equal(evaluate('2^3^2'), 512); // right-associative
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('--3'), 3);
  assert.equal(evaluate('+4'), 4);
  assert.equal(evaluate('2**3'), 8);
});

test('calculator glyphs and separators', () => {
  assert.equal(evaluate('6 × 7'), 42);
  assert.equal(evaluate('84 ÷ 2'), 42);
  assert.equal(evaluate('50 − 8'), 42);
  assert.equal(evaluate('1,000 * 3'), 3000);
  assert.equal(evaluate('1_000 + 1'), 1001);
});

test('magnitude suffixes and scientific notation', () => {
  assert.equal(evaluate('2k'), 2000);
  assert.equal(evaluate('1.5M'), 1.5e6);
  assert.equal(evaluate('3B'), 3e9);
  assert.equal(evaluate('2 million * 3'), 6e6);
  assert.equal(evaluate('(1+1)k'), 2000);
  assert.equal(evaluate('1e6 / 1e3'), 1000);
  assert.equal(evaluate('2.5E3'), 2500);
  assert.equal(evaluate('330M * 2.5'), 825e6);
});

test('functions and constants', () => {
  assert.equal(evaluate('sqrt(16)'), 4);
  assert.equal(evaluate('log(1000)'), 3);
  assert.ok(Math.abs(evaluate('ln(e)') - 1) < 1e-12);
  assert.ok(Math.abs(evaluate('pi * 2') - 2 * Math.PI) < 1e-12);
  assert.equal(evaluate('abs(-3)'), 3);
  assert.equal(evaluate('round(2.5)'), 3);
  assert.equal(evaluate('floor(2.9) + ceil(2.1)'), 5);
  assert.equal(evaluate('SQRT(9)'), 3);
  assert.equal(evaluate('log10(100)'), 2);
});

test('decimal commas and suffix chains', () => {
  assert.equal(evaluate('1,5 * 2'), 3);
  assert.equal(evaluate('round(1,2)'), 1);
  assert.equal(evaluate('2k k'), 2e6);
});

test('a typical fermi chain', () => {
  // seconds in a year
  assert.equal(evaluate('365 * 24 * 60 * 60'), 31536000);
  // US population times slices of pizza per week times 52
  assert.equal(evaluate('330M * 1.5 * 52'), 25740000000);
});

test('invalid expressions throw CalcError', () => {
  for (const bad of ['', '   ', '1 +', '(1 + 2', '1 + 2)', 'foo', '2 3', '1 / 0', 'alert(1)', '1..2', '2 km', '1,,2', '$5', 'constructor(1)', '2 constructor', '__proto__', 'toString(1)', 'hasOwnProperty(1)', '1,0000', '('.repeat(600) + '1' + ')'.repeat(600)]) {
    assert.throws(() => evaluate(bad), CalcError, `expected CalcError for ${JSON.stringify(bad)}`);
    assert.ok(Number.isNaN(tryEvaluate(bad)));
  }
});

test('tokenize', () => {
  assert.deepEqual(tokenize('2k+1'), [{ t: 'num', v: 2 }, { t: 'suffix', v: 1000 }, { t: '+' }, { t: 'num', v: 1 }]);
  assert.throws(() => tokenize('1 # 2'), CalcError);
});
