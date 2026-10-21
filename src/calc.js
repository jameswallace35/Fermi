// A small, safe arithmetic evaluator for the built-in calculator and the
// guess box. No eval(): the expression is tokenised and parsed by hand.
//
// Supports: + - * / ^ (right-associative), unary minus, parentheses,
// numbers with thousands separators and scientific notation, magnitude
// suffixes (2k, 3.5M, 1B, 2 million), the constants pi and e, and the
// functions sqrt, log (base 10), ln, abs, round, floor, ceil.

import { SUFFIXES } from './logic.js';

const FUNCTIONS = {
  sqrt: Math.sqrt,
  log: Math.log10,
  log10: Math.log10,
  ln: Math.log,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

const CONSTANTS = { pi: Math.PI, e: Math.E };

const NUMBER_RE = /^(\d[\d,_]*(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?/;

export class CalcError extends Error {}

export function tokenize(input) {
  const src = String(input ?? '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/\*\*/g, '^');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const rest = src.slice(i);
    const num = NUMBER_RE.exec(rest);
    if (num) {
      if (!/^(\d+(?:[,_]\d+)*(?:\.\d*)?|\.\d+)$/.test(num[1])) throw new CalcError('Bad number');
      const digits = num[1].replace(/[,_]/g, '');
      if (digits === '.' || digits === '') throw new CalcError('Bad number');
      let value = Number(digits);
      if (num[2] !== undefined) value *= Math.pow(10, Number(num[2]));
      tokens.push({ t: 'num', v: value });
      i += num[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      const word = /^[a-zA-Z]+/.exec(rest)[0];
      const lower = word.toLowerCase();
      if (SUFFIXES[lower] !== undefined && tokens.length && tokens[tokens.length - 1].t === 'num') {
        tokens.push({ t: 'suffix', v: SUFFIXES[lower] });
      } else if (SUFFIXES[lower] !== undefined && tokens.length && tokens[tokens.length - 1].t === ')') {
        tokens.push({ t: 'suffix', v: SUFFIXES[lower] });
      } else if (FUNCTIONS[lower]) {
        tokens.push({ t: 'fn', v: lower });
      } else if (CONSTANTS[lower] !== undefined) {
        tokens.push({ t: 'num', v: CONSTANTS[lower] });
      } else {
        throw new CalcError(`Unknown word "${word}"`);
      }
      i += word.length;
      continue;
    }
    if ('+-*/^()'.includes(ch)) {
      tokens.push({ t: ch });
      i += 1;
      continue;
    }
    throw new CalcError(`Unexpected "${ch}"`);
  }
  return tokens;
}

/** Evaluate an arithmetic expression. Throws CalcError on invalid input. */
export function evaluate(input) {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new CalcError('Empty expression');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t) => {
    const tk = next();
    if (!tk || tk.t !== t) throw new CalcError(`Expected "${t}"`);
  };

  function parseExpr() {
    let v = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = next().t;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = next().t;
      const r = parseUnary();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function parseUnary() {
    if (peek() && peek().t === '-') { next(); return -parseUnary(); }
    if (peek() && peek().t === '+') { next(); return parseUnary(); }
    return parsePower();
  }
  function parsePower() {
    const base = parsePostfix();
    if (peek() && peek().t === '^') {
      next();
      const exp = parseUnary(); // right-associative, allows 2^-3
      return Math.pow(base, exp);
    }
    return base;
  }
  function parsePostfix() {
    let v = parseAtom();
    while (peek() && peek().t === 'suffix') v *= next().v;
    return v;
  }
  function parseAtom() {
    const tk = next();
    if (!tk) throw new CalcError('Unexpected end of expression');
    if (tk.t === 'num') return tk.v;
    if (tk.t === '(') {
      const v = parseExpr();
      expect(')');
      return v;
    }
    if (tk.t === 'fn') {
      expect('(');
      const v = parseExpr();
      expect(')');
      return FUNCTIONS[tk.v](v);
    }
    throw new CalcError(`Unexpected "${tk.t}"`);
  }

  const value = parseExpr();
  if (i < tokens.length) throw new CalcError(`Unexpected "${tokens[i].t}"`);
  if (!Number.isFinite(value)) throw new CalcError('Result is not a finite number');
  return value;
}

/** Evaluate and return a number, or NaN instead of throwing. */
export function tryEvaluate(input) {
  try {
    return evaluate(input);
  } catch {
    return NaN;
  }
}
