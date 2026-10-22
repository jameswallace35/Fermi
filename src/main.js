// UI controller for Fermi. Game rules live in logic.js; this file only
// renders state and reacts to input.

import * as L from './logic.js';
import { tryEvaluate } from './calc.js';
import * as S from './storage.js';
import { connectSync } from './sync.js';
import * as A from './account.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const els = {
  meta: $('#puzzle-meta'),
  progress: $('#progress'),
  card: $('#question-card'),
  summary: $('#summary'),
  banner: $('#day-banner'),
  toast: $('#toast'),
  help: $('#dlg-help'),
  calc: $('#dlg-calc'),
  stats: $('#dlg-stats'),
  archive: $('#dlg-archive'),
  calcExpr: $('#calc-expr'),
  calcResult: $('#calc-result'),
  calcUse: $('#calc-use'),
  shareFallback: $('#share-fallback'),
  announcer: $('#announcer'),
};

let bank = null;
let todayNumber = Math.max(1, L.todayPuzzleNumber());
let puzzleNumber = todayNumber;
let questions = [];
let state = null;
let view = { kind: 'play' };
let lastCalcValue = NaN;
let archiveShown = 0;
let sync = null; // cloud sync handle: claude.ai artifact database or the accounts API
let syncState = 'off'; // off | connecting | on
let syncKind = 'none'; // none | claude | account

const ARCHIVE_PAGE = 60;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- helpers

function questionById(id) {
  return bank.questions.find((q) => q.id === id);
}

/**
 * Questions for puzzle n. If the stored state remembers which question ids
 * it was played with, honour those so results stay correct even if the bank
 * is reordered later. Falls back to a fresh selection.
 */
function resolveQuestions(n, st) {
  if (!bank) return null;
  const scheduled = L.selectQuestions(bank, n);
  if (st && Array.isArray(st.ids) && st.ids.length && st.guesses.length) {
    const byCat = new Map(bank.categories.map((c) => [c.slug, c.name]));
    const resolved = st.ids.map((id) => questionById(id));
    if (resolved.every(Boolean) && resolved.length === scheduled.length) {
      return resolved.map((q) => ({ ...q, categoryName: byCat.get(q.category) || q.category }));
    }
    return null; // stored state refers to questions that no longer exist
  }
  return scheduled;
}

function storedState(n) {
  return n === puzzleNumber && state ? state : S.loadPuzzleState(n);
}

/** Finished, and its stored guesses still match questions in the bank. */
function isComplete(n) {
  if (n === puzzleNumber && state) return complete();
  const st = S.loadPuzzleState(n);
  return st.guesses.length >= L.QUESTIONS_PER_DAY && resolveQuestions(n, st) !== null;
}

/** Streaks only count puzzles finished on their own day. */
function countsForStreak(n) {
  return isComplete(n) && L.finishedOnTime(storedState(n), n);
}

function currentStreak() {
  return L.computeStreak(countsForStreak, todayNumber);
}

/** Every finished puzzle with its score, newest first. */
function history() {
  const out = [];
  const stored = S.listPuzzleStates();
  for (const [key, st] of Object.entries(stored)) {
    const n = Number(key);
    const current = n === puzzleNumber && state ? state : st;
    if (current.guesses.length < L.QUESTIONS_PER_DAY) continue;
    const qs = n === puzzleNumber && state ? questions : resolveQuestions(n, current);
    if (!qs || qs.length < L.QUESTIONS_PER_DAY) continue;
    const multiplesFor = current.guesses.slice(0, qs.length).map((g, i) => L.scoreMultiple(g, qs[i].answer));
    out.push({ n, avg: L.dailyScore(multiplesFor), multiples: multiplesFor, onTime: L.finishedOnTime(current, n), completedAt: current.completedAt });
  }
  return out.sort((a, b) => b.n - a.n);
}

function stats() {
  return L.summarizeHistory(history(), todayNumber);
}

function complete() {
  return questions.length > 0 && state.guesses.length >= questions.length;
}

function multiples() {
  return state.guesses.map((g, i) => L.scoreMultiple(g, questions[i].answer));
}

function puzzleUrl() {
  const base = `${location.origin}${location.pathname}`;
  return puzzleNumber === todayNumber ? base : `${base}#${puzzleNumber}`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

/** Speak a message through the persistent live region (cleared first so repeats are announced). */
function announce(message) {
  els.announcer.textContent = '';
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { els.announcer.textContent = message; }, 60);
}

/**
 * Full number plus unit, with the compact form first when the digits would not
 * fit a phone column, and the same value in an alternative unit when given.
 */
function valueHtml(v, unit, alt = null) {
  const full = L.formatNumber(v);
  const compact = L.formatCompact(v);
  const lines = [];
  if (alt && alt.unit !== unit && Number.isFinite(alt.value)) {
    const altCompact = L.formatCompact(alt.value);
    lines.push(`${L.formatNumber(alt.value)} ${alt.unit}${altCompact ? ` (${altCompact})` : ''}`);
  }
  let primary;
  if (compact && full.length > 15) {
    primary = `${esc(compact)} <small>${esc(unit)}</small>`;
    lines.unshift(full);
  } else {
    primary = `${esc(full)} <small>${esc(unit)}</small>`;
    if (compact) lines.unshift(compact);
  }
  return primary + lines.map((l) => `<span class="compact">${esc(l)}</span>`).join('');
}

function rowNumber(v) {
  const compact = L.formatCompact(v);
  return v >= 1e12 && compact ? compact : L.formatNumber(v);
}

/** The number typed in the box, in the unit the player chose (not yet converted). */
function parseTyped(raw, unit) {
  if (String(raw).length > L.MAX_INPUT_LENGTH) return NaN;
  let v = L.parseNumber(raw, unit);
  if (Number.isNaN(v)) {
    let s = String(raw).trim();
    if (unit) s = s.replace(new RegExp(`\\s*${escapeRegExp(unit)}$`, 'i'), '');
    v = tryEvaluate(s);
  }
  return v;
}

/** Typed value and its equivalent in the question's own unit. */
function parseGuess(raw, typedUnit, canonicalUnit) {
  const typed = parseTyped(raw, typedUnit);
  const canonical = Number.isFinite(typed) ? L.convertToCanonical(typed, typedUnit, canonicalUnit) : NaN;
  return { typed, canonical };
}

/** The unit the player last chose for this canonical unit, if it is still valid. */
function preferredUnit(canonical) {
  const options = L.unitOptions(canonical);
  const saved = (S.loadPrefs().units || {})[canonical];
  return options.includes(saved) ? saved : canonical;
}

function unitFieldHtml(canonical) {
  const options = L.unitOptions(canonical);
  if (options.length === 1) return `<span class="unit" aria-hidden="true">${esc(canonical)}</span>`;
  const chosen = preferredUnit(canonical);
  return `<select id="unit" class="unit unit-select" aria-label="Unit for your estimate">${options
    .map((u) => `<option value="${esc(u)}" ${u === chosen ? 'selected' : ''}>${esc(u)}</option>`)
    .join('')}</select>`;
}

function plainNumber(v) {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  return String(Number(v.toPrecision(12)));
}

// ----------------------------------------------------------------- loading

function load(n) {
  puzzleNumber = n;
  state = S.loadPuzzleState(n);
  const resolved = resolveQuestions(n, state);
  if (resolved === null) {
    // The stored guesses belong to questions that are no longer in the bank:
    // start the puzzle afresh and persist the reset so archive and streak agree.
    state = S.freshPuzzleState();
    S.savePuzzleState(n, state);
    questions = L.selectQuestions(bank, n);
  } else {
    questions = resolved;
  }
  if (state.guesses.length > questions.length) state.guesses = state.guesses.slice(0, questions.length);
  view = complete() ? { kind: 'summary' } : { kind: 'play' };
  render();
}

/** Puzzle number from a "#12" hash, clamped to [1, today]; null when the hash is not a puzzle link. */
function puzzleFromHash() {
  const m = /^#(\d+)$/.exec(location.hash);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return todayNumber;
  if (n < 1) return 1;
  return Math.min(n, todayNumber);
}

function goTo(n) {
  if (n === todayNumber) {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    load(n);
  } else {
    location.hash = `#${n}`; // hashchange handler loads it
  }
}

// --------------------------------------------------------------- rendering

function render({ focus = false } = {}) {
  renderMeta();
  renderProgress();
  const showSummary = view.kind === 'summary';
  els.card.hidden = showSummary;
  els.summary.hidden = !showSummary;
  if (view.kind === 'play') renderQuestion(state.guesses.length);
  else if (view.kind === 'result') renderResult(view.index);
  else renderSummary();
  if (!focus) return;
  // Keep keyboard and screen-reader users oriented after a view change.
  const target = view.kind === 'play' ? $('#guess') : view.kind === 'result' ? $('#continue') : els.summary;
  if (target) target.focus({ preventScroll: view.kind === 'result' });
}

function renderMeta() {
  const date = L.formatDateKey(L.dateKeyForPuzzle(puzzleNumber));
  const isToday = puzzleNumber === todayNumber;
  els.meta.innerHTML = `<span>No. ${puzzleNumber} · ${esc(date)}</span>${
    isToday ? '' : `<span class="badge">Archive</span><button type="button" class="link-btn" id="link-today">Today's puzzle</button>`
  }`;
  const link = $('#link-today');
  if (link) link.addEventListener('click', () => goTo(todayNumber));
}

function renderProgress() {
  const total = questions.length;
  const ms = multiples();
  els.progress.innerHTML = Array.from({ length: total }, (_, i) => {
    const done = i < state.guesses.length;
    const current = !done && i === state.guesses.length && view.kind === 'play';
    const reviewing = view.kind === 'result' && view.index === i;
    const tier = done ? L.tierFor(ms[i]) : null;
    const cls = ['dot', done ? `done ${tier.cls}` : '', current ? 'current' : '', reviewing ? 'reviewing' : ''].filter(Boolean).join(' ');
    const label = done ? `Question ${i + 1}: ${L.formatMultiple(ms[i])}, ${tier.label}. Review` : `Question ${i + 1}${current ? ', current' : ''}`;
    return `<li><button type="button" class="${cls}" data-index="${i}" aria-label="${esc(label)}" ${done ? '' : 'disabled'}>${i + 1}</button></li>`;
  }).join('');
  $$('.dot.done', els.progress).forEach((btn) => {
    btn.addEventListener('click', () => {
      view = { kind: 'result', index: Number(btn.dataset.index), from: complete() ? 'summary' : 'play' };
      render({ focus: true });
    });
  });
}

function renderQuestion(i) {
  const q = questions[i];
  if (!q) {
    els.card.innerHTML = '<p class="error">No questions available for this puzzle.</p>';
    return;
  }
  els.card.innerHTML = `
    <div class="card-top">
      <span class="chip">${esc(q.categoryName)}</span>
      <p class="qnum">Question ${i + 1} of ${questions.length}</p>
    </div>
    <h2 class="question">${esc(q.question)}</h2>
    <form id="guess-form" novalidate autocomplete="off">
      <label class="sr-only" for="guess">Your estimate in ${esc(q.unit)}</label>
      <div class="input-wrap">
        <input id="guess" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Estimate" enterkeyhint="done" maxlength="${L.MAX_INPUT_LENGTH}">
        ${unitFieldHtml(q.unit)}
      </div>
      <p id="preview" class="preview">&nbsp;</p>
      <button type="submit" id="lock" class="btn primary wide">Lock it in</button>
    </form>`;

  const form = $('#guess-form');
  const input = $('#guess');
  const preview = $('#preview');
  const wrap = $('.input-wrap', els.card);
  const unitSelect = $('#unit');
  const typedUnit = () => (unitSelect ? unitSelect.value : q.unit);

  const updatePreview = () => {
    wrap.classList.remove('shake');
    const raw = input.value;
    if (!raw.trim()) {
      preview.innerHTML = '&nbsp;';
      preview.className = 'preview';
      return;
    }
    const unit = typedUnit();
    const { typed, canonical } = parseGuess(raw, unit, q.unit);
    if (!Number.isFinite(typed)) {
      preview.textContent = 'Enter a positive number: 1500, 1.5k, 2 million, 3B, 1e9 or a sum like 365*24';
      preview.className = 'preview warn';
      return;
    }
    if (!(canonical > 0)) {
      preview.textContent = unit === q.unit ? 'Enter a positive number.' : `That is ${L.formatNumber(canonical)} ${q.unit}; the answer is above 0 ${q.unit}.`;
      preview.className = 'preview warn';
      return;
    }
    const compact = L.formatCompact(typed);
    let text = `= ${L.formatNumber(typed)} ${unit}${compact ? ` (${compact})` : ''}`;
    if (unit !== q.unit) text += ` = ${L.formatNumber(canonical)} ${q.unit}`;
    preview.textContent = text;
    preview.className = 'preview ok';
  };
  input.addEventListener('input', updatePreview);
  if (unitSelect) {
    unitSelect.addEventListener('change', () => {
      const prefs = S.loadPrefs();
      S.savePrefs({ ...prefs, units: { ...(prefs.units || {}), [q.unit]: unitSelect.value } });
      updatePreview();
      input.focus();
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const unit = typedUnit();
    const { typed, canonical } = parseGuess(input.value, unit, q.unit);
    if (!Number.isFinite(typed) || !(canonical > 0)) {
      updatePreview();
      if (!input.value.trim()) {
        preview.textContent = 'Type your estimate first.';
        preview.className = 'preview warn';
      }
      wrap.classList.remove('shake');
      void wrap.offsetWidth; // restart the animation
      wrap.classList.add('shake');
      announce(preview.textContent);
      input.focus();
      return;
    }
    lockIn(i, canonical, unit);
  });
}

function lockIn(i, value, typedUnit) {
  if (state.guesses.length !== i) return; // stale form
  state.guesses.push(value);
  state.units = Array.from({ length: i + 1 }, (_, k) => (k === i ? (typedUnit !== questions[i].unit ? typedUnit : null) : (state.units || [])[k] ?? null));
  state.ids = questions.map((q) => q.id);
  if (complete()) state.completedAt = Date.now();
  S.savePuzzleState(puzzleNumber, state);
  if (sync) {
    sync.push(puzzleNumber, state).catch((err) => {
      console.warn('Cloud save failed', err);
      if (syncKind === 'account' && err && err.status === 401) {
        A.forgetSession();
        sync = null;
        syncState = 'off';
        syncKind = 'none';
        toast('Your session has expired. Sign in again from Statistics to keep saving.');
      }
    });
  }
  view = { kind: 'result', index: i };
  render({ focus: true });
  const q = questions[i];
  const m = L.scoreMultiple(value, q.answer);
  const tier = L.tierFor(m);
  const direction = Math.abs(m - 1) < 0.005 ? '' : value > q.answer ? ', too high' : ', too low';
  announce(`${L.formatMultiple(m)} off, ${tier.label}${direction}. The answer is ${L.formatNumber(q.answer)} ${q.unit}.`);
}

function scaleHtml(guess, answer) {
  const pos = L.scalePosition(guess, answer);
  const left = Math.max(2, Math.min(98, pos));
  const beyond = pos < 2 ? 'beyond-left' : pos > 98 ? 'beyond-right' : '';
  return `
    <div class="scale" aria-hidden="true">
      <div class="scale-track">
        <span class="tick" style="left:0%">÷100</span>
        <span class="tick" style="left:25%">÷10</span>
        <span class="tick center" style="left:50%">answer</span>
        <span class="tick" style="left:75%">×10</span>
        <span class="tick" style="left:100%">×100</span>
        <span class="marker answer" style="left:50%"></span>
        <span class="marker guess ${beyond}" style="left:${left}%"><span class="marker-label">you</span></span>
      </div>
    </div>`;
}

function renderResult(i) {
  const q = questions[i];
  const g = state.guesses[i];
  if (!q || g === undefined) {
    view = { kind: 'play' };
    render();
    return;
  }
  const m = L.scoreMultiple(g, q.answer);
  const tier = L.tierFor(m);
  const isLast = i === questions.length - 1;
  const done = complete();
  const storedUnit = (state.units || [])[i];
  const typedUnit = storedUnit && L.unitOptions(q.unit).includes(storedUnit) && storedUnit !== q.unit ? storedUnit : null;

  let label;
  let next;
  if (view.from === 'summary') {
    label = 'Back to results';
    next = () => { view = { kind: 'summary' }; render({ focus: true }); };
  } else if (done && isLast) {
    label = 'See results';
    next = () => { view = { kind: 'summary' }; render({ focus: true }); };
  } else if (!done && i === state.guesses.length - 1) {
    label = 'Next question';
    next = () => { view = { kind: 'play' }; render({ focus: true }); };
  } else if (done) {
    label = 'Back to results';
    next = () => { view = { kind: 'summary' }; render({ focus: true }); };
  } else {
    label = `Back to question ${state.guesses.length + 1}`;
    next = () => { view = { kind: 'play' }; render({ focus: true }); };
  }

  const direction = Math.abs(m - 1) < 0.005 ? '' : g > q.answer ? ' · too high' : ' · too low';
  const asOf = q.as_of && q.as_of !== 'stable' ? ` · ${esc(q.as_of)}` : '';
  const srcHost = (() => { try { return new URL(q.source_url).hostname.replace(/^www\./, ''); } catch { return ''; } })();

  els.card.innerHTML = `
    <div class="card-top">
      <span class="chip">${esc(q.categoryName)}</span>
      <p class="qnum">Question ${i + 1} of ${questions.length}</p>
    </div>
    <h2 class="question">${esc(q.question)}</h2>
    <div class="result ${tier.cls}">
      <div class="result-score">
        <span class="result-mult">${L.formatMultiple(m)}</span>
        <span class="result-label">${tier.emoji} ${tier.label}${direction}</span>
      </div>
      <dl class="compare">
        <div>
          <dt>Your guess</dt>
          <dd>${typedUnit ? valueHtml(L.convertFromCanonical(g, typedUnit, q.unit), typedUnit, { unit: q.unit, value: g }) : valueHtml(g, q.unit)}</dd>
        </div>
        <div>
          <dt>Answer</dt>
          <dd>${valueHtml(q.answer, q.unit, typedUnit ? { unit: typedUnit, value: L.convertFromCanonical(q.answer, typedUnit, q.unit) } : null)}</dd>
        </div>
      </dl>
      ${scaleHtml(g, q.answer)}
      <p class="explainer">${esc(q.explainer || '')}</p>
      <p class="source">Source: <a href="${esc(q.source_url)}" target="_blank" rel="noopener noreferrer">${esc(q.source_title || srcHost || 'link')}</a>${asOf}</p>
    </div>
    <button type="button" id="continue" class="btn primary wide">${esc(label)}</button>`;
  $('#continue').addEventListener('click', next);
}

function renderSummary() {
  const ms = multiples();
  const avg = L.dailyScore(ms);
  const tier = L.tierFor(avg);
  const totals = stats();
  const isToday = puzzleNumber === todayNumber;
  const date = L.formatDateKey(L.dateKeyForPuzzle(puzzleNumber));

  els.summary.innerHTML = `
    <div class="summary-head ${tier.cls}">
      <p class="qnum">Puzzle No. ${puzzleNumber} · ${esc(date)}</p>
      <div class="big-score">
        <span class="big-mult">${L.formatMultiple(avg)}</span>
        <span class="big-label">${tier.emoji} ${tier.label}</span>
      </div>
      <p class="muted small">Average of your five scores. Lower is better.</p>
    </div>
    <ol class="rows">
      ${questions
        .map((q, i) => {
          const t = L.tierFor(ms[i]);
          return `<li><button type="button" class="row" data-index="${i}">
            <span class="row-emoji" aria-hidden="true">${t.emoji}</span>
            <span class="row-body">
              <span class="row-cat">${esc(q.categoryName)}</span>
              <span class="row-q">${esc(q.question)}</span>
              <span class="row-nums">You: ${esc(rowNumber(state.guesses[i]))} · Answer: ${esc(rowNumber(q.answer))} ${esc(q.unit)}</span>
            </span>
            <span class="row-mult ${t.cls}">${L.formatMultiple(ms[i])}</span>
          </button></li>`;
        })
        .join('')}
    </ol>
    <div class="summary-actions">
      <button type="button" id="btn-share" class="btn primary wide">Share results</button>
    </div>
    <div class="summary-foot">
      ${isToday
        ? `<p class="countdown">Next puzzle in <strong id="countdown">${L.formatCountdown(L.msUntilLocalMidnight())}</strong></p>`
        : `<p><button type="button" class="link-btn" id="link-today-summary">Play today's puzzle</button></p>`}
      <p>🔥 Streak ${totals.streak} · Played ${totals.played} · Best ${totals.best != null ? L.formatMultiple(totals.best) : '—'}</p>
    </div>`;

  $$('.row', els.summary).forEach((btn) => {
    btn.addEventListener('click', () => {
      view = { kind: 'result', index: Number(btn.dataset.index), from: 'summary' };
      render({ focus: true });
    });
  });
  $('#btn-share').addEventListener('click', share);
  const today = $('#link-today-summary');
  if (today) today.addEventListener('click', () => goTo(todayNumber));
}

// ------------------------------------------------------------------- share

async function share() {
  const text = L.shareText({
    puzzleNumber,
    dateKey: L.dateKeyForPuzzle(puzzleNumber),
    multiples: multiples(),
    url: puzzleUrl(),
  });
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile && navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  if (await copyText(text)) toast('Results copied to clipboard');
  else toast('Could not copy. Long-press the results to copy them.');
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const previous = document.activeElement;
  try {
    const ta = els.shareFallback;
    ta.value = text;
    ta.classList.remove('sr-only');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.classList.add('sr-only');
    ta.removeAttribute('style');
    return ok;
  } catch {
    return false;
  } finally {
    if (previous && typeof previous.focus === 'function') previous.focus();
  }
}

// ------------------------------------------------------------------ dialogs

function openDialog(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function renderStats() {
  const games = history();
  const totals = L.summarizeHistory(games, todayNumber);
  const max = Math.max(1, ...totals.tiers);
  const account = A.available() ? A.session() : null;
  let syncNote;
  if (syncState === 'on' && syncKind === 'claude') syncNote = 'Results are saved to your Claude account and follow you across devices.';
  else if (syncState === 'on' && syncKind === 'account') syncNote = `Signed in as <strong>${esc(account ? account.username : '')}</strong>. Results follow you across devices.`;
  else if (syncState === 'connecting') syncNote = 'Connecting…';
  else if (A.available()) syncNote = 'Sign in to keep your results across devices, or use a backup code.';
  else syncNote = 'Results are saved in this browser. Use a backup code to carry them to another device.';
  const accountHtml = !A.available() || syncKind === 'claude'
    ? ''
    : account
      ? `<div class="account-signed-in"><span>Account: <strong>${esc(account.username)}</strong></span><button type="button" class="btn" id="btn-signout">Sign out</button></div>`
      : `<form class="account-form" id="account-form" autocomplete="on">
          <label class="sr-only" for="account-user">Username</label>
          <input id="account-user" name="username" placeholder="Username" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="24" required>
          <label class="sr-only" for="account-pass">Password</label>
          <input id="account-pass" name="password" type="password" placeholder="Password (8+ characters)" autocomplete="current-password" minlength="8" maxlength="200" required>
          <p class="account-error" id="account-error" aria-live="polite"></p>
          <div class="backup-actions">
            <button type="submit" class="btn primary" data-mode="login">Sign in</button>
            <button type="submit" class="btn" data-mode="signup">Create account</button>
          </div>
        </form>`;
  $('#stats-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-value">${totals.played}</span><span class="stat-label">Played</span></div>
      <div class="stat"><span class="stat-value">${totals.average != null ? L.formatMultiple(totals.average) : '—'}</span><span class="stat-label">Average</span></div>
      <div class="stat"><span class="stat-value">${totals.streak}</span><span class="stat-label">Streak</span></div>
      <div class="stat"><span class="stat-value">${totals.maxStreak}</span><span class="stat-label">Best streak</span></div>
    </div>
    <p class="small muted">Daily scores by tier${totals.best != null ? ` · best day ${L.formatMultiple(totals.best)}` : ''}</p>
    <ul class="hist">
      ${L.TIERS.map((t, i) => `<li class="hist-tier-${i}"><span aria-hidden="true">${t.emoji}</span><span class="hist-bar" style="width:${Math.max(2, (100 * totals.tiers[i]) / max)}%"></span><span class="hist-count">${totals.tiers[i]}</span></li>`).join('')}
    </ul>
    <h3 class="section-title">Every puzzle you have finished</h3>
    ${games.length
      ? `<ol class="history">${games
          .map((g) => {
            const t = L.tierFor(g.avg);
            return `<li><button type="button" class="row" data-n="${g.n}">
              <span class="row-body">
                <span class="row-cat">No. ${g.n} · ${esc(L.formatDateKey(L.dateKeyForPuzzle(g.n)))}${g.onTime ? '' : ' · archive'}</span>
                <span class="row-q" aria-label="${esc(g.multiples.map((m) => L.formatMultiple(m)).join(', '))}">${g.multiples.map((m) => L.tierFor(m).emoji).join(' ')}</span>
              </span>
              <span class="row-mult ${t.cls}">${L.formatMultiple(g.avg)}</span>
            </button></li>`;
          })
          .join('')}</ol>`
      : '<p class="history-empty">Finish a puzzle and it will appear here.</p>'}
    <h3 class="section-title">Saving</h3>
    <p class="sync-note">${syncNote}</p>
    ${accountHtml}
    <div class="backup-actions">
      <button type="button" class="btn" id="btn-backup-copy">Copy backup code</button>
      <button type="button" class="btn" id="btn-backup-restore">Restore a backup</button>
    </div>
    <form class="backup-restore" id="backup-form" hidden>
      <label class="sr-only" for="backup-code">Backup code</label>
      <textarea id="backup-code" placeholder="Paste a backup code here" spellcheck="false"></textarea>
      <button type="submit" class="btn primary wide">Restore</button>
    </form>`;

  $$('.history .row', $('#stats-body')).forEach((btn) => {
    btn.addEventListener('click', () => {
      els.stats.close();
      goTo(Number(btn.dataset.n));
    });
  });
  const accountForm = $('#account-form');
  if (accountForm) {
    let mode = 'login';
    $$('button[type="submit"]', accountForm).forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; }));
    accountForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#account-user').value.trim();
      const password = $('#account-pass').value;
      const error = $('#account-error');
      error.textContent = '';
      $$('button', accountForm).forEach((b) => { b.disabled = true; });
      try {
        const name = mode === 'signup' ? await A.signup(username, password) : await A.login(username, password);
        toast(mode === 'signup' ? `Welcome, ${name}! Your results will be saved to your account.` : `Signed in as ${name}.`);
        await startSync();
        renderStats();
      } catch (err) {
        error.textContent = err && err.message ? err.message : 'Something went wrong';
        $$('button', accountForm).forEach((b) => { b.disabled = false; });
      }
    });
  }
  const signOut = $('#btn-signout');
  if (signOut) {
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      await A.logout();
      sync = null;
      syncState = 'off';
      syncKind = 'none';
      toast('Signed out. Your results stay in this browser.');
      renderStats();
    });
  }
  $('#btn-backup-copy').addEventListener('click', async () => {
    const code = S.exportBackup();
    if (await copyText(code)) toast('Backup code copied. Paste it on another device to restore.');
    else {
      $('#backup-form').hidden = false;
      $('#backup-code').value = code;
      toast('Copy the code from the box below.');
    }
  });
  $('#btn-backup-restore').addEventListener('click', () => {
    const form = $('#backup-form');
    form.hidden = !form.hidden;
    if (!form.hidden) $('#backup-code').focus();
  });
  $('#backup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    restoreBackup($('#backup-code').value);
  });
}

/** Merge a backup code into local storage and refresh everything that shows results. */
function restoreBackup(code) {
  const backup = S.parseBackup(code);
  if (!backup) {
    toast('That is not a Fermi backup code.');
    return;
  }
  const changed = S.mergePuzzleStates(backup.puzzles);
  const prefs = S.loadPrefs();
  S.savePrefs({ ...backup.prefs, ...prefs, units: { ...(backup.prefs.units || {}), ...(prefs.units || {}) } });
  if (changed.includes(puzzleNumber)) load(puzzleNumber);
  else if (state) render();
  if (sync) for (const n of changed) sync.push(n, S.loadPuzzleState(n)).catch(() => {});
  toast(changed.length ? `Restored ${changed.length} puzzle${changed.length === 1 ? '' : 's'}.` : 'Nothing new in that backup.');
  renderStats();
}

// -------------------------------------------------------------- cloud sync

/**
 * On claude.ai, mirror finished puzzles to the viewer's private area of the
 * artifact database and pull anything saved from another device. Elsewhere
 * this resolves immediately and the game keeps using localStorage.
 */
async function startSync() {
  syncState = 'connecting';
  syncKind = 'none';
  try {
    sync = await connectSync();
    if (sync) syncKind = 'claude';
  } catch {
    sync = null;
  }
  if (!sync && A.available()) {
    sync = A.connectAccountSync();
    if (sync) syncKind = 'account';
  }
  if (!sync) {
    syncState = 'off';
    return;
  }
  try {
    const remote = await sync.pull();
    const changed = S.mergePuzzleStates(remote);
    const local = S.listPuzzleStates();
    for (const [key, st] of Object.entries(local)) {
      const n = Number(key);
      const r = remote[n];
      if (!r || st.guesses.length > r.guesses.length) await sync.push(n, st);
    }
    syncState = 'on';
    if (changed.includes(puzzleNumber)) load(puzzleNumber);
    else if (state && view.kind === 'summary') renderSummary();
    if (changed.length) toast(`Loaded ${changed.length} puzzle${changed.length === 1 ? '' : 's'} from your ${syncKind === 'account' ? 'account' : 'Claude account'}.`);
  } catch (err) {
    console.warn('Cloud sync unavailable', err);
    if (syncKind === 'account' && err && err.status === 401) {
      A.forgetSession();
      toast('Your session has expired. Please sign in again.');
    }
    syncState = 'off';
    syncKind = 'none';
    sync = null;
  }
}

function renderArchive(reset = true) {
  if (reset) archiveShown = 0;
  const body = $('#archive-body');
  const end = Math.min(todayNumber, archiveShown + ARCHIVE_PAGE);
  const items = [];
  for (let n = todayNumber - archiveShown; n > todayNumber - end; n--) {
    const st = storedState(n);
    let status = 'Not played';
    let cls = '';
    if (st.guesses.length >= L.QUESTIONS_PER_DAY) {
      const qs = n === puzzleNumber ? questions : resolveQuestions(n, st);
      if (qs) {
        const avg = L.dailyScore(st.guesses.map((g, i) => L.scoreMultiple(g, qs[i].answer)));
        const t = L.tierFor(avg);
        status = `${t.emoji} ${L.formatMultiple(avg)}`;
        cls = t.cls;
      }
    } else if (st.guesses.length) {
      status = `${st.guesses.length}/${L.QUESTIONS_PER_DAY} answered`;
    }
    items.push(`<li><button type="button" class="row" data-n="${n}" aria-current="${n === puzzleNumber ? 'true' : 'false'}">
      <span class="row-body"><span class="row-cat">No. ${n}${n === todayNumber ? ' · Today' : ''}</span><span class="row-q">${esc(L.formatDateKey(L.dateKeyForPuzzle(n)))}</span></span>
      <span class="row-mult ${cls}">${status}</span>
    </button></li>`);
  }
  archiveShown = end;
  const more = archiveShown < todayNumber ? `<button type="button" class="btn wide archive-more" id="archive-more">Show older puzzles</button>` : '';
  if (reset) body.innerHTML = `<ul class="archive-list">${items.join('')}</ul>${more}`;
  else {
    $('.archive-list', body).insertAdjacentHTML('beforeend', items.join(''));
    const old = $('#archive-more');
    if (old) old.remove();
    body.insertAdjacentHTML('beforeend', more);
  }
  $$('.row', body).forEach((btn) => {
    btn.onclick = () => {
      els.archive.close();
      goTo(Number(btn.dataset.n));
    };
  });
  const moreBtn = $('#archive-more');
  if (moreBtn) moreBtn.addEventListener('click', () => renderArchive(false));
}

// -------------------------------------------------------------- calculator

function updateCalc() {
  const raw = els.calcExpr.value;
  if (!raw.trim()) {
    els.calcResult.innerHTML = '&nbsp;';
    els.calcResult.className = 'calc-result';
    lastCalcValue = NaN;
    return;
  }
  const v = tryEvaluate(raw);
  if (!Number.isFinite(v)) {
    els.calcResult.textContent = '…';
    els.calcResult.className = 'calc-result';
    lastCalcValue = NaN;
    return;
  }
  lastCalcValue = v;
  const compact = L.formatCompact(v);
  els.calcResult.textContent = `= ${L.formatNumber(v)}${compact ? ` (${compact})` : ''}`;
  els.calcResult.className = 'calc-result ok';
}

function insertAtCaret(text) {
  const el = els.calcExpr;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, start, end, 'end');
  el.focus();
  updateCalc();
}

function setupCalculator() {
  els.calcExpr.addEventListener('input', updateCalc);
  els.calcExpr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      calcEquals();
    }
  });
  $('#keypad').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.key) insertAtCaret(btn.dataset.key);
    else if (btn.dataset.action === 'clear') {
      els.calcExpr.value = '';
      els.calcExpr.focus();
      updateCalc();
    } else if (btn.dataset.action === 'back') {
      const el = els.calcExpr;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      if (start !== end) el.setRangeText('', start, end, 'end');
      else if (start > 0) el.setRangeText('', start - 1, start, 'end');
      el.focus();
      updateCalc();
    } else if (btn.dataset.action === 'equals') calcEquals();
  });
  els.calcUse.addEventListener('click', () => {
    const guess = $('#guess');
    if (!Number.isFinite(lastCalcValue)) {
      toast('Enter a valid expression first');
      return;
    }
    if (!guess) {
      toast('No question is waiting for a guess');
      return;
    }
    guess.value = plainNumber(lastCalcValue);
    guess.dispatchEvent(new Event('input', { bubbles: true }));
    els.calc.close();
    guess.focus();
  });
}

function calcEquals() {
  if (!Number.isFinite(lastCalcValue)) return;
  els.calcExpr.value = plainNumber(lastCalcValue);
  els.calcExpr.focus();
  updateCalc();
}

// ------------------------------------------------------------------- theme

function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t === 'light') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Reflect the active theme in the toggle button and the browser chrome colour. */
function syncThemeUi() {
  const dark = effectiveTheme() === 'dark';
  const btn = $('#btn-theme');
  btn.setAttribute('aria-pressed', String(dark));
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#121214' : '#f6f5f2'));
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  S.savePrefs({ ...S.loadPrefs(), theme: next });
  syncThemeUi();
}

// -------------------------------------------------------------- day change

function tick() {
  const cd = $('#countdown');
  if (cd) cd.textContent = L.formatCountdown(L.msUntilLocalMidnight());
  const nowNumber = Math.max(1, L.todayPuzzleNumber());
  if (nowNumber !== todayNumber) {
    todayNumber = nowNumber;
    els.banner.hidden = false;
    // The puzzle on screen is now an archive puzzle: refresh the parts that
    // say so, without touching a question the player may be typing into.
    if (bank && state) {
      renderMeta();
      if (view.kind === 'summary') renderSummary();
    }
  }
}

// -------------------------------------------------------------------- init

async function init() {
  $('#btn-help').addEventListener('click', () => openDialog(els.help));
  $('#btn-calc').addEventListener('click', () => {
    openDialog(els.calc);
    els.calcUse.disabled = !$('#guess');
    els.calcExpr.focus();
  });
  $('#btn-stats').addEventListener('click', () => {
    renderStats();
    openDialog(els.stats);
  });
  $('#btn-archive').addEventListener('click', () => {
    if (!bank) {
      toast('The questions have not loaded yet.');
      return;
    }
    renderArchive(true);
    openDialog(els.archive);
  });
  $('#btn-theme').addEventListener('click', toggleTheme);
  syncThemeUi();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeUi);
  $('#btn-new-day').addEventListener('click', () => {
    els.banner.hidden = true;
    goTo(todayNumber);
  });
  setupCalculator();

  // Close dialogs when the backdrop is clicked.
  for (const dlg of [els.help, els.calc, els.stats, els.archive]) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  }

  try {
    const res = await fetch('data/questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bank = await res.json();
    if (!bank || !Array.isArray(bank.questions) || !Array.isArray(bank.categories)) throw new Error('Malformed bank');
  } catch (err) {
    els.card.innerHTML = `<p class="error">Could not load the questions (${esc(err.message)}). Please refresh.</p>`;
    return;
  }

  window.addEventListener('hashchange', () => {
    const n = puzzleFromHash();
    if (n === null) {
      // "#main" (the skip link) and other in-page anchors are not puzzle links.
      if (location.hash && location.hash !== '#') return;
      if (puzzleNumber !== todayNumber) load(todayNumber);
      return;
    }
    if (n !== puzzleNumber) load(n);
    else renderMeta();
  });

  load(puzzleFromHash() ?? todayNumber);
  startSync();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  const prefs = S.loadPrefs();
  if (!prefs.seenHelp) {
    openDialog(els.help);
    els.help.addEventListener('close', () => S.savePrefs({ ...S.loadPrefs(), seenHelp: true }), { once: true });
  }
}

init();
