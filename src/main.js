// UI controller for Ballpark. Game rules live in logic.js; this file only
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
  board: $('#dlg-board'),
  calcExpr: $('#calc-expr'),
  calcResult: $('#calc-result'),
  calcUse: $('#calc-use'),
  calcNotes: $('#calc-notes'),
  notesFor: $('#notes-for'),
  notesStatus: $('#notes-status'),
  shareFallback: $('#share-fallback'),
  announcer: $('#announcer'),
  ownerBanner: $('#owner-banner'),
};

let bank = null;
let todayNumber = Math.max(1, L.todayPuzzleNumber());
let puzzleNumber = todayNumber;
let questions = [];
let state = null;
let view = { kind: 'play', index: 0 };
let lastCalcValue = NaN;
let archiveShown = 0;
let sync = null; // cloud sync handle: claude.ai artifact database or the accounts API
let syncState = 'off'; // off | connecting | on
let syncKind = 'none'; // none | claude | account
const communityCache = new Map(); // question id -> stats from the API
let mode = 'daily'; // daily | unlimited | timed
let arena = null; // state of the unlimited or timed game in progress

const ARCHIVE_PAGE = 60;
const TIMED_MS = (() => {
  const c = window.FERMI_CONFIG || {};
  return Number.isFinite(c.timedSeconds) && c.timedSeconds > 0 ? c.timedSeconds * 1000 : 5 * 60 * 1000;
})();
const BALLPARK_MAX = 10;

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function questionById(id) {
  return bank.questions.find((q) => q.id === id);
}

function withCategory(q) {
  const byCat = new Map(bank.categories.map((c) => [c.slug, c.name]));
  return { ...q, categoryName: byCat.get(q.category) || q.category };
}

/**
 * Questions for puzzle n. If the stored state remembers which question ids
 * it was played with, honour those so results stay correct even if the bank
 * is reordered later. Falls back to a fresh selection.
 */
function resolveQuestions(n, st) {
  if (!bank) return null;
  const scheduled = L.selectQuestions(bank, n);
  if (st && Array.isArray(st.ids) && st.ids.length && L.answeredCount(st)) {
    const resolved = st.ids.map((id) => questionById(id));
    if (resolved.every(Boolean) && resolved.length === scheduled.length) return resolved.map(withCategory);
    return null; // stored state refers to questions that no longer exist
  }
  return scheduled;
}

function storedState(n) {
  if (n === puzzleNumber && state) return state;
  return S.loadPuzzleState(n);
}

/** Finished, and its stored guesses still match questions in the bank. */
function isComplete(n) {
  const st = storedState(n);
  return L.isFinished(st) && resolveQuestions(n, st) !== null;
}

function countsForStreak(n) {
  return isComplete(n) && L.finishedOnTime(storedState(n), n);
}

function currentStreak() {
  return L.computeStreak(countsForStreak, todayNumber);
}

/** Every finished puzzle with its score, newest first. */
function finishedPuzzles() {
  const out = [];
  const stored = S.listPuzzleStates();
  for (const [key, st] of Object.entries(stored)) {
    const n = Number(key);
    const current = n === puzzleNumber && state ? state : st;
    if (!L.isFinished(current)) continue;
    const qs = n === puzzleNumber && state ? questions : resolveQuestions(n, current);
    if (!qs || qs.length < L.QUESTIONS_PER_DAY) continue;
    const multiplesFor = current.guesses.slice(0, qs.length).map((g, i) => L.scoreMultiple(g, qs[i].answer));
    out.push({ n, avg: L.dailyScore(multiplesFor), multiples: multiplesFor, onTime: L.finishedOnTime(current, n), completedAt: current.completedAt });
  }
  return out.sort((a, b) => b.n - a.n);
}

function stats() {
  return L.summarizeHistory(finishedPuzzles(), todayNumber);
}

function complete() {
  return questions.length > 0 && L.isFinished(state, questions.length);
}

/** Times-off per question, or null where a question is not answered yet. */
function multiples() {
  return questions.map((q, i) => (L.isAnswered(state, i) ? L.scoreMultiple(state.guesses[i], q.answer) : null));
}

function puzzleUrl() {
  const base = `${location.origin}${location.pathname}`;
  return puzzleNumber === todayNumber ? base : `${base}#${puzzleNumber}`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 3500);
}

function announce(message) {
  els.announcer.textContent = '';
  // A new value is needed for screen readers to speak repeated messages.
  setTimeout(() => {
    els.announcer.textContent = message;
  }, 50);
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

function formatWhen(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
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
  view = complete() ? { kind: 'summary' } : { kind: 'play', index: Math.max(0, L.firstUnanswered(state, questions.length)) };
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

function modeFromHash() {
  return location.hash === '#unlimited' ? 'unlimited' : location.hash === '#timed' ? 'timed' : null;
}

function goTo(n) {
  if (mode !== 'daily') setMode('daily', { silent: true });
  if (n === todayNumber) {
    if (location.hash) window.history.replaceState(null, '', location.pathname + location.search);
    load(n);
  } else {
    location.hash = `#${n}`; // hashchange handler loads it
  }
}

// ------------------------------------------------------------------- modes

function renderModeTabs() {
  for (const m of ['daily', 'unlimited', 'timed']) $(`#mode-${m}`).setAttribute('aria-selected', String(m === mode));
}

/** Switch between the daily puzzle and the unlimited or timed games. */
function setMode(next, { silent = false } = {}) {
  if (next === mode) return;
  if (arena && arena.mode === 'timed') endRun({ quiet: true }); // a run that is cut short still counts locally
  mode = next;
  arena = null;
  renderModeTabs();
  if (!silent) {
    const hash = next === 'daily' ? '' : `#${next}`;
    if (location.hash !== hash) window.history.replaceState(null, '', location.pathname + location.search + hash);
  }
  if (mode === 'daily') {
    els.progress.hidden = false;
    if (state) render({ focus: true });
    return;
  }
  els.progress.hidden = true;
  els.summary.hidden = true;
  els.card.hidden = false;
  arena = mode === 'unlimited' ? newArena('unlimited', 'ask') : newArena('timed', 'idle');
  renderArena({ focus: true });
}

function newArena(m, status) {
  return { mode: m, status, q: null, guess: null, typedUnit: null, answered: 0, ballpark: 0, sumMultiple: 0, runId: null, endsAt: null, seen: new Set(), lastPlay: null };
}

/** Ids answered in the daily puzzles on this device: no point serving those again. */
function dailyAnsweredIds() {
  const ids = new Set();
  for (const st of Object.values(S.listPuzzleStates())) {
    if (!Array.isArray(st.ids)) continue;
    st.ids.forEach((id, i) => {
      if (L.isAnswered(st, i)) ids.add(id);
    });
  }
  return ids;
}

/** A question the player has not seen in this mode (or anywhere, for unlimited); starts over when all are used. */
function pickQuestion() {
  const exclude = new Set(dailyAnsweredIds());
  for (const id of arena.seen) exclude.add(id);
  if (arena.mode === 'unlimited') for (const id of S.loadModeStats('unlimited').seen) exclude.add(id);
  let pool = bank.questions.filter((q) => !exclude.has(q.id));
  if (!pool.length) {
    if (arena.mode === 'unlimited') {
      const st = S.loadModeStats('unlimited');
      S.saveModeStats('unlimited', { ...st, seen: [] });
      toast('You have seen every question. Starting the deck again.');
    }
    pool = bank.questions.filter((q) => !arena.seen.has(q.id));
    if (!pool.length) pool = bank.questions;
  }
  return withCategory(pool[Math.floor(Math.random() * pool.length)]);
}

function arenaStatsHtml() {
  if (arena.mode === 'unlimited') {
    const st = S.loadModeStats('unlimited');
    const avg = st.answered ? st.sumMultiple / st.answered : null;
    return `<span>Unlimited</span><span>Answered <strong>${st.answered}</strong></span><span>In the ballpark <strong>${st.ballpark}</strong></span>${avg != null ? `<span>Average <strong>${esc(L.formatMultiple(avg))}</strong></span>` : ''}`;
  }
  const left = arena.endsAt ? arena.endsAt - Date.now() : TIMED_MS;
  const running = arena.status === 'ask' || arena.status === 'result';
  return `<span>Timed</span>${running ? `<span class="arena-clock${left < 30000 ? ' urgent' : ''}" id="arena-clock" aria-live="off">${formatClock(left)}</span>` : ''}<span>Answered <strong>${arena.answered}</strong></span><span>In the ballpark <strong>${arena.ballpark}</strong></span>`;
}

function renderArena({ focus = false } = {}) {
  els.meta.innerHTML = `<span class="arena-stats">${arenaStatsHtml()}</span>`;
  if (arena.status === 'idle') {
    const best = S.loadModeStats('timed').best;
    els.card.innerHTML = `
      <div class="arena-start">
        <h2>Five minutes. As many as you can.</h2>
        <p>Questions keep coming for ${Math.round(TIMED_MS / 60000)} minute${TIMED_MS === 60000 ? '' : 's'}. An answer within 10× counts as in the ballpark, and that is what the leaderboard ranks.</p>
        ${best ? `<p>Your best run: <strong>${best.ballpark}</strong> in the ballpark from ${best.answered} answered${best.average != null ? `, average ${esc(L.formatMultiple(best.average))}` : ''}.</p>` : ''}
        ${A.available() && !A.session() ? '<p class="small">Sign in from Statistics to get on the timed leaderboard.</p>' : ''}
        <button type="button" id="arena-start" class="btn primary wide">Start the clock</button>
      </div>`;
    $('#arena-start').addEventListener('click', startRun);
    if (focus) $('#arena-start').focus();
    return;
  }
  if (arena.status === 'ended') {
    const avg = arena.answered ? arena.sumMultiple / arena.answered : null;
    const tier = avg != null ? L.tierFor(avg) : null;
    els.card.innerHTML = `
      <div class="arena-end">
        <p class="qnum">Time is up</p>
        <div class="big-score">
          <span class="big-mult">${arena.ballpark}</span>
          <span class="big-label">in the ballpark</span>
        </div>
        <p>${arena.answered} answered${avg != null ? ` · average <span class="${tier.cls}">${esc(L.formatMultiple(avg))}</span>` : ''}</p>
        ${arena.record ? '<p><strong>New personal best!</strong></p>' : ''}
        ${arena.runId == null && A.available() ? '<p class="small muted">Sign in before a run to get it on the leaderboard.</p>' : ''}
        <div class="summary-actions">
          <button type="button" id="arena-again" class="btn primary wide">Play again</button>
          <button type="button" id="arena-share" class="btn wide">Share this run</button>
        </div>
      </div>`;
    $('#arena-again').addEventListener('click', () => {
      arena = newArena('timed', 'idle');
      renderArena({ focus: true });
    });
    $('#arena-share').addEventListener('click', () => shareText(`${L.GAME_NAME} timed: ${arena.ballpark} in the ballpark from ${arena.answered} answered in ${Math.round(TIMED_MS / 60000)} minutes\n${location.origin}${location.pathname}#timed`));
    if (focus) $('#arena-again').focus();
    return;
  }
  if (arena.status === 'ask') {
    if (!arena.q) {
      arena.q = pickQuestion();
      arena.seen.add(arena.q.id);
    }
    mountQuestion(arena.q, { heading: arena.mode === 'unlimited' ? `Question ${S.loadModeStats('unlimited').answered + 1}` : `Question ${arena.answered + 1}`, onLock: arenaLock });
    if (focus) $('#guess').focus();
    return;
  }
  // result
  mountResult(arena.q, arena.guess, arena.typedUnit, {
    heading: arena.mode === 'unlimited' ? `Question ${S.loadModeStats('unlimited').answered}` : `Question ${arena.answered}`,
    label: 'Next question',
    onNext: () => {
      arena.status = 'ask';
      arena.q = null;
      arena.guess = null;
      renderArena({ focus: true });
    },
    community: arena.lastPlay,
  });
  if (focus) $('#continue').focus({ preventScroll: true });
}

async function startRun() {
  const btn = $('#arena-start');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting…';
  }
  let runId = null;
  if (A.available() && A.session()) {
    // Register the run first so every answer can be scored against its clock.
    try {
      runId = (await A.createRun()).id;
    } catch (err) {
      if (err && err.status === 401) {
        A.forgetSession();
        syncOwnerUi();
      }
      toast('Could not start a scored run; this one will not count for the leaderboard.');
    }
  }
  if (mode !== 'timed' || !arena || arena.status !== 'idle') return; // the player moved on meanwhile
  arena = newArena('timed', 'ask');
  arena.runId = runId;
  arena.endsAt = Date.now() + TIMED_MS;
  renderArena({ focus: true });
}

function arenaLock(value, typedUnit) {
  const q = arena.q;
  const m = L.scoreMultiple(value, q.answer);
  const inBallpark = m <= BALLPARK_MAX;
  arena.guess = value;
  arena.typedUnit = typedUnit !== q.unit ? typedUnit : null;
  arena.answered += 1;
  if (inBallpark) arena.ballpark += 1;
  arena.sumMultiple += m;
  arena.status = 'result';
  if (arena.mode === 'unlimited') {
    const st = S.loadModeStats('unlimited');
    S.saveModeStats('unlimited', { ...st, answered: st.answered + 1, ballpark: st.ballpark + (inBallpark ? 1 : 0), sumMultiple: st.sumMultiple + m, seen: [...st.seen, q.id].slice(-2000) });
  }
  arena.lastPlay = A.available() ? { mode: arena.mode, runId: arena.runId, submit: true } : null;
  renderArena({ focus: true });
  const tier = L.tierFor(m);
  announce(`${L.formatMultiple(m)} off, ${tier.label}. The answer is ${L.formatNumber(q.answer)} ${q.unit}.`);
}

function endRun({ quiet = false } = {}) {
  if (!arena || arena.mode !== 'timed' || arena.status === 'ended' || arena.status === 'idle') return;
  arena.status = 'ended';
  const st = S.loadModeStats('timed');
  const avg = arena.answered ? arena.sumMultiple / arena.answered : null;
  const better = !st.best || arena.ballpark > st.best.ballpark || (arena.ballpark === st.best.ballpark && avg != null && (st.best.average == null || avg < st.best.average));
  if (arena.answered && better) {
    arena.record = true;
    S.saveModeStats('timed', { ...st, best: { ballpark: arena.ballpark, answered: arena.answered, average: avg, at: Date.now() } });
  }
  if (quiet) return;
  renderArena({ focus: true });
  announce(`Time is up. ${arena.ballpark} in the ballpark from ${arena.answered} answered.`);
}

// --------------------------------------------------------------- rendering

function render({ focus = false } = {}) {
  if (mode !== 'daily') {
    renderArena({ focus });
    return;
  }
  renderMeta();
  renderProgress();
  const showSummary = view.kind === 'summary';
  els.card.hidden = showSummary;
  els.summary.hidden = !showSummary;
  if (view.kind === 'play') renderQuestion(view.index);
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
    const done = L.isAnswered(state, i);
    const current = !done && view.kind === 'play' && view.index === i;
    const reviewing = view.kind === 'result' && view.index === i;
    const tier = done ? L.tierFor(ms[i]) : null;
    const cls = ['dot', done ? `done ${tier.cls}` : 'open', current ? 'current' : '', reviewing ? 'reviewing' : ''].filter(Boolean).join(' ');
    const label = done ? `Question ${i + 1}: ${L.formatMultiple(ms[i])}, ${tier.label}. Review` : `Question ${i + 1}${current ? ', current' : ', not answered yet'}`;
    return `<li><button type="button" class="${cls}" data-index="${i}" aria-label="${esc(label)}" aria-current="${current || reviewing ? 'true' : 'false'}">${i + 1}</button></li>`;
  }).join('');
  $$('.dot', els.progress).forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.index);
      if (L.isAnswered(state, i)) view = { kind: 'result', index: i, from: complete() ? 'summary' : 'play' };
      else view = { kind: 'play', index: i };
      render({ focus: true });
    });
  });
}

/**
 * The question card with its guess box. `onLock(value, typedUnit)` receives
 * the guess converted to the question's unit plus the unit the player typed in.
 */
function mountQuestion(q, { heading, onLock }) {
  els.card.innerHTML = `
    <div class="card-top">
      <span class="chip">${esc(q.categoryName)}</span>
      <p class="qnum">${esc(heading)}</p>
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
    onLock(canonical, unit);
  });
}

function renderQuestion(i) {
  const q = questions[i];
  if (!q) {
    els.card.innerHTML = '<p class="error">No questions available for this puzzle.</p>';
    return;
  }
  mountQuestion(q, { heading: `Question ${i + 1} of ${questions.length}`, onLock: (value, unit) => lockIn(i, value, unit) });
}

function lockIn(i, value, typedUnit) {
  if (L.isAnswered(state, i)) return; // stale form
  while (state.guesses.length <= i) state.guesses.push(null);
  state.guesses[i] = value;
  const units = Array.from({ length: Math.max(state.guesses.length, (state.units || []).length) }, (_, k) => (state.units || [])[k] ?? null);
  units[i] = typedUnit !== questions[i].unit ? typedUnit : null;
  state.units = units;
  state.ids = questions.map((q) => q.id);
  if (complete()) state.completedAt = Date.now();
  S.savePuzzleState(puzzleNumber, state);
  pushState(puzzleNumber, state);
  view = { kind: 'result', index: i, justLocked: true };
  render({ focus: true });
  view.justLocked = false;
  const q = questions[i];
  const m = L.scoreMultiple(value, q.answer);
  const tier = L.tierFor(m);
  const direction = Math.abs(m - 1) < 0.005 ? '' : value > q.answer ? ', too high' : ', too low';
  announce(`${L.formatMultiple(m)} off, ${tier.label}${direction}. The answer is ${L.formatNumber(q.answer)} ${q.unit}.`);
}

/** Save a daily puzzle record to the cloud, signing out on an expired session. */
function pushState(n, st) {
  if (!sync) return;
  sync.push(n, st).catch((err) => {
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

/**
 * The answer card for a guess. `community` is null (no API), or
 * { submit, mode, runId }: submit sends the guess to the server, otherwise the
 * statistics are only fetched.
 */
function mountResult(q, g, typedUnit, { heading, label, onNext, community }) {
  const m = L.scoreMultiple(g, q.answer);
  const tier = L.tierFor(m);
  const direction = Math.abs(m - 1) < 0.005 ? '' : g > q.answer ? ' · too high' : ' · too low';
  const asOf = q.as_of && q.as_of !== 'stable' ? ` · ${esc(q.as_of)}` : '';
  const srcHost = (() => { try { return new URL(q.source_url).hostname.replace(/^www\./, ''); } catch { return ''; } })();

  els.card.innerHTML = `
    <div class="card-top">
      <span class="chip">${esc(q.categoryName)}</span>
      <p class="qnum">${esc(heading)}</p>
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
      ${community ? '<div class="community" id="community"><p class="community-line muted">Loading how other players guessed…</p></div>' : ''}
    </div>
    <button type="button" id="continue" class="btn primary wide">${esc(label)}</button>`;
  $('#continue').addEventListener('click', onNext);
  if (community) loadCommunity(q, g, community);
}

function renderResult(i) {
  const q = questions[i];
  const g = state.guesses[i];
  if (!q || !L.isAnswered(state, i)) {
    view = { kind: 'play', index: Math.max(0, L.firstUnanswered(state, questions.length)) };
    render();
    return;
  }
  const done = complete();
  const storedUnit = (state.units || [])[i];
  const typedUnit = storedUnit && L.unitOptions(q.unit).includes(storedUnit) && storedUnit !== q.unit ? storedUnit : null;

  let label;
  let next;
  if (view.from === 'summary' || (done && !view.justLocked)) {
    label = 'Back to results';
    next = () => { view = { kind: 'summary' }; render({ focus: true }); };
  } else if (done) {
    label = 'See results';
    next = () => { view = { kind: 'summary' }; render({ focus: true }); };
  } else {
    const k = L.firstUnanswered(state, questions.length);
    // "Next" when the question after this one is still open; otherwise point back to the first open one.
    label = view.justLocked || k === i + 1 ? 'Next question' : `Back to question ${k + 1}`;
    next = () => { view = { kind: 'play', index: k }; render({ focus: true }); };
  }
  mountResult(q, g, typedUnit, { heading: `Question ${i + 1} of ${questions.length}`, label, onNext: next, community: A.available() ? { submit: !!view.justLocked, mode: 'daily' } : null });
}

/**
 * Fill the "how others guessed" block. A freshly locked guess is submitted
 * (as a daily guess or as an unlimited/timed play); a reviewed one just
 * fetches the statistics.
 */
async function loadCommunity(q, guess, community) {
  const box = $('#community');
  if (!box) return;
  const key = `${q.id}:${guess}`;
  let stats = communityCache.get(key) || null;
  if (!stats) {
    try {
      if (community.submit && community.mode === 'timed' && !community.runId && A.session()) {
        // A signed-in run the server never registered: show the statistics without recording the answer.
        stats = await A.fetchStats({ questionId: q.id, answer: q.answer, guess });
      } else if (community.submit && community.mode !== 'daily') {
        stats = (await A.submitPlay({ mode: community.mode, runId: community.runId, questionId: q.id, guess, answer: q.answer, anonymousId: S.anonymousId() })).stats;
      } else if (community.submit) stats = await A.submitGuess({ questionId: q.id, guess, answer: q.answer, anonymousId: S.anonymousId() });
      else stats = await A.fetchStats({ questionId: q.id, answer: q.answer, guess });
      communityCache.set(key, stats);
    } catch (err) {
      if (err && err.status === 401) A.forgetSession();
      if ($('#community') === box) box.innerHTML = '<p class="community-line muted">Other players\' guesses are unavailable right now.</p>';
      return;
    }
  }
  if ($('#community') !== box) return; // the card was re-rendered meanwhile
  box.innerHTML = communityHtml(stats, q, guess);
}

function communityHtml(stats, q, guess) {
  const count = stats && Number.isInteger(stats.count) ? stats.count : 0;
  if (count <= 1) return '<p class="community-line muted">You are the first player to answer this one. Check back later to see how others did.</p>';
  const parts = [`${count.toLocaleString('en-US')} players`];
  if (Number.isFinite(stats.typical)) parts.push(`typical guess ${rowNumber(stats.typical)} ${esc(q.unit)}`);
  if (Number.isFinite(stats.beat)) parts.push(`<strong>you beat ${Math.round(stats.beat * 100)}%</strong>`);
  else if (Number.isFinite(stats.within2x)) parts.push(`${Math.round(stats.within2x * 100)}% within 2×`);
  const hist = Array.isArray(stats.histogram) ? stats.histogram : [];
  const max = Math.max(1, ...hist);
  const range = Number(stats.range) || 3;
  const width = Number(stats.bucketWidth) || 0.5;
  const mineIdx = guess > 0 ? Math.max(0, Math.min(hist.length - 1, Math.floor((Math.log10(guess / q.answer) + range) / width))) : -1;
  const bars = hist
    .map((n, i) => `<span class="cbar${i === mineIdx ? ' mine' : ''}" style="height:${Math.max(4, Math.round((100 * n) / max))}%" title="${n} player${n === 1 ? '' : 's'}"></span>`)
    .join('');
  return `
    <p class="community-line">${parts.join(' · ')}</p>
    <div class="community-chart" aria-hidden="true">${bars}<span class="community-answer"></span></div>
    <div class="community-ticks" aria-hidden="true"><span>÷1000</span><span>÷10</span><span>answer</span><span>×10</span><span>×1000</span></div>
    <p class="community-note muted small">Where other players' guesses landed, on the same scale as yours. Your bucket is highlighted.</p>`;
}

function notesBlockHtml() {
  const notes = typeof state.notes === 'string' ? state.notes.trim() : '';
  return notes
    ? `<div class="summary-notes"><h3>Your notes</h3><pre>${esc(notes)}</pre><button type="button" class="link-btn" id="edit-notes">Edit notes</button></div>`
    : `<p class="small muted"><button type="button" class="link-btn" id="edit-notes">Add notes to this puzzle</button></p>`;
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
    ${notesBlockHtml()}
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
  $('#edit-notes').addEventListener('click', () => openCalculator({ notes: true }));
  const today = $('#link-today-summary');
  if (today) today.addEventListener('click', () => goTo(todayNumber));
}

// ------------------------------------------------------------------- share

async function share() {
  await shareText(L.shareText({
    puzzleNumber,
    dateKey: L.dateKeyForPuzzle(puzzleNumber),
    multiples: multiples(),
    url: puzzleUrl(),
  }));
}

async function shareText(text) {
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
  const games = finishedPuzzles();
  const totals = L.summarizeHistory(games, todayNumber);
  const max = Math.max(1, ...totals.tiers);
  const account = A.available() ? A.session() : null;
  let syncNote;
  if (syncState === 'on' && syncKind === 'claude') syncNote = 'Results are saved to your Claude account and follow you across devices.';
  else if (syncState === 'on' && syncKind === 'account') syncNote = `Signed in as <strong>${esc(account ? account.username : '')}</strong>. Results follow you across devices.`;
  else if (syncState === 'connecting') syncNote = 'Connecting…';
  else if (A.available()) syncNote = 'Sign in to keep your results across devices, or use a backup code.';
  else syncNote = 'Results are saved in this browser. Use a backup code to carry them to another device.';
  const unlimited = S.loadModeStats('unlimited');
  const timed = S.loadModeStats('timed');
  const accountHtml = !A.available() || syncKind === 'claude'
    ? ''
    : account
      ? `<div class="account-signed-in"><span>Account: <strong>${esc(account.username)}</strong>${account.admin ? ' <span class="badge">owner</span>' : ''}</span><button type="button" class="btn" id="btn-signout">Sign out</button></div>`
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
    <h3 class="section-title">Unlimited and timed</h3>
    <p class="small">Unlimited: <strong>${unlimited.answered}</strong> answered, <strong>${unlimited.ballpark}</strong> in the ballpark${unlimited.answered ? `, average ${esc(L.formatMultiple(unlimited.sumMultiple / unlimited.answered))}` : ''}.<br>
    Timed best: ${timed.best ? `<strong>${timed.best.ballpark}</strong> in the ballpark from ${timed.best.answered} answered` : 'no run yet'}.</p>
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
    let formMode = 'login';
    $$('button[type="submit"]', accountForm).forEach((b) => b.addEventListener('click', () => { formMode = b.dataset.mode; }));
    accountForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#account-user').value.trim();
      const password = $('#account-pass').value;
      const error = $('#account-error');
      error.textContent = '';
      $$('button', accountForm).forEach((b) => { b.disabled = true; });
      try {
        const name = formMode === 'signup' ? await A.signup(username, password, S.anonymousId()) : await A.login(username, password, S.anonymousId());
        toast(A.isOwner() ? 'Owner mode is on.' : formMode === 'signup' ? `Welcome, ${name}! Your results will be saved to your account.` : `Signed in as ${name}.`);
        syncOwnerUi();
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
      syncOwnerUi();
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
    toast('That is not a Ballpark backup code.');
    return;
  }
  const changed = S.mergePuzzleStates(backup.puzzles);
  const prefs = S.loadPrefs();
  S.savePrefs({ ...backup.prefs, ...prefs, units: { ...(backup.prefs.units || {}), ...(prefs.units || {}) } });
  if (changed.includes(puzzleNumber)) load(puzzleNumber);
  else if (state && mode === 'daily') render();
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
    if (syncKind === 'account') {
      await A.refresh();
      syncOwnerUi();
    }
    const remote = await sync.pull();
    const changed = S.mergePuzzleStates(remote);
    const local = S.listPuzzleStates();
    for (const [key, st] of Object.entries(local)) {
      const n = Number(key);
      const r = remote[n] ? S.sanitizePuzzleState(remote[n]) : null;
      // Push what the cloud lacks: an answer, or newer notes.
      if (!r || L.mergePuzzleRecords(r, st) !== r) await sync.push(n, st);
    }
    syncState = 'on';
    if (changed.includes(puzzleNumber)) {
      if (mode === 'daily') load(puzzleNumber);
      else state = S.loadPuzzleState(puzzleNumber);
    } else if (state && mode === 'daily' && view.kind === 'summary') renderSummary();
    if (changed.length) toast(`Loaded ${changed.length} puzzle${changed.length === 1 ? '' : 's'} from your ${syncKind === 'account' ? 'account' : 'Claude account'}.`);
  } catch (err) {
    console.warn('Cloud sync unavailable', err);
    if (syncKind === 'account' && err && err.status === 401) {
      A.forgetSession();
      syncOwnerUi();
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
    const answered = L.answeredCount(st);
    if (L.isFinished(st)) {
      const qs = n === puzzleNumber ? questions : resolveQuestions(n, st);
      if (qs) {
        const avg = L.dailyScore(st.guesses.map((g, i) => L.scoreMultiple(g, qs[i].answer)));
        const t = L.tierFor(avg);
        status = `${t.emoji} ${L.formatMultiple(avg)}`;
        cls = t.cls;
      }
    } else if (answered) {
      status = `${answered}/${L.QUESTIONS_PER_DAY} answered`;
    }
    const hasNotes = typeof st.notes === 'string' && st.notes.trim() !== '';
    items.push(`<li><button type="button" class="row" data-n="${n}" aria-current="${n === puzzleNumber && mode === 'daily' ? 'true' : 'false'}">
      <span class="row-body"><span class="row-cat">No. ${n}${n === todayNumber ? ' · Today' : ''}${hasNotes ? ' · 📝 notes' : ''}</span><span class="row-q">${esc(L.formatDateKey(L.dateKeyForPuzzle(n)))}</span></span>
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

// ------------------------------------------------------------- leaderboard

let boardScope = 'daily';

function renderBoardTabs() {
  const daily = $('#tab-daily');
  daily.textContent = puzzleNumber === todayNumber ? 'Today' : `No. ${puzzleNumber}`;
  for (const s of ['daily', 'all', 'unlimited', 'timed', 'owner']) $(`#tab-${s}`).setAttribute('aria-selected', String(boardScope === s));
  $('#tab-owner').hidden = !A.isOwner();
}

function boardRow(p, i, sub, score, cls) {
  return `<li class="board-row${p.you ? ' you' : ''}">
    <span class="board-rank">${i}</span>
    <span class="board-name"><strong>${esc(p.username)}${p.you ? ' (you)' : ''}</strong><span class="board-sub">${sub}</span></span>
    <span class="board-score ${cls}">${score}</span>
  </li>`;
}

async function renderBoard() {
  renderBoardTabs();
  const body = $('#board-body');
  if (!A.session()) {
    body.innerHTML = `<p class="board-empty">Sign in or create an account to see how you stack up against other players.</p>
      <button type="button" class="btn primary wide" id="board-signin">Open Statistics to sign in</button>`;
    $('#board-signin').addEventListener('click', () => {
      els.board.close();
      renderStats();
      openDialog(els.stats);
    });
    return;
  }
  if (boardScope === 'owner') {
    renderOwner();
    return;
  }
  body.innerHTML = '<p class="board-empty">Loading…</p>';
  const scope = boardScope;
  const n = puzzleNumber;
  let data;
  try {
    data = await A.fetchLeaderboard(scope === 'daily' ? { n } : { scope });
  } catch (err) {
    if (boardScope !== scope) return;
    if (err && err.status === 401) {
      A.forgetSession();
      syncOwnerUi();
      renderBoard();
      return;
    }
    body.innerHTML = `<p class="board-empty">${esc((err && err.message) || 'Could not load the leaderboard.')}</p>`;
    return;
  }
  if (boardScope !== scope || (scope === 'daily' && puzzleNumber !== n)) return;
  const players = Array.isArray(data.players) ? data.players : [];
  if (scope === 'daily') {
    const date = L.formatDateKey(L.dateKeyForPuzzle(n));
    body.innerHTML = `<p class="board-sub-title">Puzzle No. ${n} · ${esc(date)} · lowest average wins</p>` + (players.length
      ? `<ol class="board">${players.map((p, i) => boardRow(p, i + 1, Array.isArray(p.multiples) ? p.multiples.map((m) => L.tierFor(m).emoji).join(' ') : '', L.formatMultiple(p.score), L.tierFor(p.score).cls)).join('')}</ol>`
      : `<p class="board-empty">Nobody has finished puzzle No. ${n} yet. Finish it and you will be first.</p>`);
  } else if (scope === 'all') {
    const min = Number(data.rankedMinPlayed) || 3;
    body.innerHTML = `<p class="board-sub-title">Average over every puzzle finished · ranked after ${min} puzzles</p>` + (players.length
      ? `<ol class="board">${players.map((p, i) => boardRow(p, p.ranked ? i + 1 : '–', `${p.played} puzzle${p.played === 1 ? '' : 's'} · best ${L.formatMultiple(p.best)}`, `${L.formatMultiple(p.average)}${p.ranked ? '' : `<small>needs ${min}</small>`}`, L.tierFor(p.average).cls)).join('')}</ol>`
      : '<p class="board-empty">No finished puzzles yet.</p>');
  } else if (scope === 'unlimited') {
    body.innerHTML = '<p class="board-sub-title">Unlimited mode · most questions answered</p>' + (players.length
      ? `<ol class="board">${players.map((p, i) => boardRow(p, i + 1, `${p.ballpark} in the ballpark · average ${L.formatMultiple(p.average)}`, `${p.answered}<small>answered</small>`, '')).join('')}</ol>`
      : '<p class="board-empty">Nobody has played unlimited mode yet.</p>');
  } else {
    body.innerHTML = `<p class="board-sub-title">Timed mode · best ${Math.round((Number(data.durationMs) || TIMED_MS) / 60000)}-minute run · answers within ${data.ballparkMax || BALLPARK_MAX}× count</p>` + (players.length
      ? `<ol class="board">${players.map((p, i) => boardRow(p, i + 1, `${p.answered} answered · average ${L.formatMultiple(p.average)}`, `${p.ballpark}<small>in the ballpark</small>`, '')).join('')}</ol>`
      : '<p class="board-empty">No timed runs yet.</p>');
  }
}

function setupBoard() {
  if (!A.available()) return;
  const btn = $('#btn-board');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    if (boardScope === 'owner' && !A.isOwner()) boardScope = 'daily';
    openDialog(els.board);
    renderBoard();
  });
  for (const s of ['daily', 'all', 'unlimited', 'timed', 'owner']) {
    $(`#tab-${s}`).addEventListener('click', () => {
      boardScope = s;
      renderBoard();
    });
  }
}

// -------------------------------------------------------------- owner view

let ownerView = 'players';
let ownerPlayer = null; // id of the player whose answers are expanded

function questionLine(id) {
  const q = bank ? questionById(id) : null;
  return q ? q.question : `(question ${id} is no longer in the bank)`;
}

function answerLine(id, guess) {
  const q = bank ? questionById(id) : null;
  if (!q) return `${rowNumber(guess)}`;
  const m = L.scoreMultiple(guess, q.answer);
  return `${rowNumber(guess)} ${esc(q.unit)} · answer ${rowNumber(q.answer)} · <span class="${L.tierFor(m).cls}">${L.formatMultiple(m)}</span>`;
}

async function renderOwner() {
  const body = $('#board-body');
  if (!A.isOwner()) {
    boardScope = 'daily';
    renderBoard();
    return;
  }
  const nav = `<div class="owner-nav">
    <button type="button" class="btn" data-view="players" aria-pressed="${ownerView === 'players'}">Players</button>
    <button type="button" class="btn" data-view="puzzle" aria-pressed="${ownerView === 'puzzle'}">This puzzle</button>
    <button type="button" class="btn" data-view="suggestions" aria-pressed="${ownerView === 'suggestions'}">Suggestions</button>
  </div>`;
  body.innerHTML = `${nav}<div id="owner-body"><p class="board-empty">Loading…</p></div>`;
  $$('.owner-nav .btn', body).forEach((b) => b.addEventListener('click', () => { ownerView = b.dataset.view; renderOwner(); }));
  const box = $('#owner-body');
  const fail = (err) => {
    if (err && err.status === 401) A.forgetSession();
    if (err && err.status === 403) A.refresh().then(syncOwnerUi).catch(() => {});
    box.innerHTML = `<p class="board-empty">${esc((err && err.message) || 'Could not load.')}</p>`;
  };
  const view0 = ownerView;
  try {
    if (view0 === 'players') {
      const { players } = await A.admin.players();
      if (ownerView !== view0) return;
      box.innerHTML = players.length
        ? `<p class="board-sub-title">${players.length} account${players.length === 1 ? '' : 's'}. Tap a name to see every answer.</p>
          <table class="owner-table"><thead><tr><th>Player</th><th>Daily</th><th>Avg</th><th>Unltd</th><th>Timed</th><th>Last active</th></tr></thead><tbody>
          ${players.map((p) => `<tr>
            <td><button type="button" class="link-btn owner-open" data-id="${p.id}">${esc(p.username)}</button>${p.admin ? ' <span class="badge">owner</span>' : ''}</td>
            <td class="num">${p.played}</td><td class="num">${p.average != null ? esc(L.formatMultiple(p.average)) : '—'}</td>
            <td class="num">${p.unlimited}</td><td class="num">${p.timedBest != null ? p.timedBest : '—'}</td>
            <td>${p.lastActive ? esc(formatWhen(p.lastActive)) : '—'}</td></tr>`).join('')}
          </tbody></table><div id="owner-detail"></div>`
        : '<p class="board-empty">No accounts yet.</p>';
      $$('.owner-open', box).forEach((b) => b.addEventListener('click', () => openPlayer(Number(b.dataset.id))));
      if (ownerPlayer && players.some((p) => p.id === ownerPlayer)) openPlayer(ownerPlayer);
    } else if (view0 === 'puzzle') {
      const ids = questions.map((q) => q.id);
      const { guesses } = await A.admin.answersForQuestions(ids);
      if (ownerView !== view0) return;
      box.innerHTML = `<p class="board-sub-title">Puzzle No. ${puzzleNumber}: everyone's answers, signed in or not.</p>` + questions.map((q) => {
        const rows = guesses.filter((g) => g.questionId === q.id);
        return `<div class="owner-q"><p class="owner-qtext">${esc(q.question)}</p>${rows.length
          ? `<ul>${rows.map((g) => `<li><strong>${esc(g.username || `guest ${g.guest}`)}</strong>: ${answerLine(q.id, g.guess)}</li>`).join('')}</ul>`
          : '<p class="small muted">No answers yet.</p>'}</div>`;
      }).join('');
    } else {
      const { suggestions } = await A.admin.suggestions();
      if (ownerView !== view0) return;
      box.innerHTML = suggestions.length
        ? `<ul class="owner-sug">${suggestions.map((s) => `<li class="${s.done ? 'done' : ''}" data-id="${s.id}">
            <div>${esc(s.text)}</div>
            <div class="sug-meta"><span>${esc(s.username || `guest ${s.guest}`)}</span><span>${esc(formatWhen(s.createdAt))}</span>
              <button type="button" class="link-btn sug-done">${s.done ? 'Mark open' : 'Mark done'}</button>
              <button type="button" class="link-btn sug-delete">Delete</button></div>
          </li>`).join('')}</ul>`
        : '<p class="board-empty">No suggestions yet.</p>';
      $$('.owner-sug li', box).forEach((li) => {
        const id = Number(li.dataset.id);
        $('.sug-done', li).addEventListener('click', async () => {
          try {
            await A.admin.updateSuggestion(id, { done: !li.classList.contains('done') });
            renderOwner();
          } catch (err) { fail(err); }
        });
        $('.sug-delete', li).addEventListener('click', async () => {
          try {
            await A.admin.updateSuggestion(id, { delete: true });
            renderOwner();
          } catch (err) { fail(err); }
        });
      });
    }
  } catch (err) {
    fail(err);
  }
}

async function openPlayer(id) {
  ownerPlayer = id;
  const detail = $('#owner-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="owner-detail"><p class="board-empty">Loading…</p></div>';
  let data;
  try {
    data = await A.admin.answersForUser(id);
  } catch (err) {
    detail.innerHTML = `<div class="owner-detail"><p class="board-empty">${esc((err && err.message) || 'Could not load.')}</p></div>`;
    return;
  }
  if (ownerPlayer !== id || $('#owner-detail') !== detail) return;
  const puzzles = data.puzzles || [];
  const plays = data.plays || [];
  detail.innerHTML = `<div class="owner-detail">
    <h4>${esc(data.user.username)} · joined ${esc(formatWhen(data.user.createdAt))}</h4>
    ${puzzles.length ? puzzles.map((p) => `<div class="owner-q">
        <p class="owner-qtext">No. ${p.n} · ${esc(L.formatDateKey(L.dateKeyForPuzzle(p.n)))}${p.score != null ? ` · ${esc(L.formatMultiple(p.score))}` : ` · ${L.answeredCount(p)}/${L.QUESTIONS_PER_DAY} answered`}</p>
        <ul>${(p.ids || []).map((qid, i) => `<li>${esc(questionLine(qid))}<br>${L.isAnswered(p, i) ? answerLine(qid, p.guesses[i]) : '<span class="muted">not answered</span>'}</li>`).join('')}</ul>
        ${p.notes ? `<pre class="owner-notes">📝 ${esc(p.notes)}</pre>` : ''}
      </div>`).join('') : '<p class="small muted">No daily puzzles saved.</p>'}
    <h4>Unlimited and timed answers (${plays.length})</h4>
    ${plays.length ? `<ul class="owner-plays">${plays.slice(0, 200).map((pl) => `<li><span class="badge">${esc(pl.mode)}</span> ${esc(questionLine(pl.questionId))}<br>${answerLine(pl.questionId, pl.guess)} · ${esc(formatWhen(pl.createdAt))}</li>`).join('')}</ul>${plays.length > 200 ? `<p class="small muted">Showing the latest 200 of ${plays.length}.</p>` : ''}` : '<p class="small muted">None yet.</p>'}
    <h4>Set a new password</h4>
    <form class="owner-pass" id="owner-pass">
      <label class="sr-only" for="owner-pass-input">New password for ${esc(data.user.username)}</label>
      <input id="owner-pass-input" type="text" minlength="8" maxlength="200" placeholder="New password (8+ characters)" autocomplete="off" required>
      <button type="submit" class="btn">Set</button>
    </form>
    <p class="small muted">Passwords are stored scrambled, so they cannot be shown; setting a new one signs the player out everywhere.</p>
  </div>`;
  $('#owner-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#owner-pass-input');
    try {
      await A.admin.setPassword(id, input.value);
      toast(`Password for ${data.user.username} set.`);
      input.value = '';
    } catch (err) {
      toast((err && err.message) || 'Could not set the password.');
    }
  });
}

/** Show or hide everything that depends on being signed in as the owner. */
function syncOwnerUi() {
  const owner = A.isOwner();
  els.ownerBanner.hidden = !owner;
  $('#tab-owner').hidden = !owner;
  if (!owner && boardScope === 'owner') boardScope = 'daily';
}

// ------------------------------------------------------------- suggestions

function setupSuggestions() {
  const form = $('#suggest-form');
  if (!A.available()) return;
  form.hidden = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#suggest-text');
    const text = input.value.trim();
    if (text.length < 3) {
      toast('Write a few words first.');
      input.focus();
      return;
    }
    const btn = $('button', form);
    btn.disabled = true;
    try {
      await A.sendSuggestion(text, S.anonymousId());
      input.value = '';
      toast('Thanks! Sent to the game\'s owner.');
    } catch (err) {
      toast((err && err.message) || 'Could not send that right now.');
    } finally {
      btn.disabled = false;
    }
  });
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

/** Where the notes box reads and writes: the daily puzzle, or a scratchpad per mode. */
function notesTarget() {
  if (mode === 'daily' && state) {
    return {
      label: `for puzzle No. ${puzzleNumber}`,
      get: () => (typeof state.notes === 'string' ? state.notes : ''),
      set: (text) => {
        state.notes = text;
        S.savePuzzleState(puzzleNumber, state);
        clearTimeout(notesTarget.pushTimer);
        notesTarget.pushTimer = setTimeout(() => pushState(puzzleNumber, state), 1500);
        if (view.kind === 'summary') {
          const block = $('.summary-notes, #edit-notes', els.summary);
          if (block) renderSummary();
        }
      },
    };
  }
  const m = mode;
  return {
    label: `(${m} scratchpad)`,
    get: () => String((S.loadPrefs().scratch || {})[m] || ''),
    set: (text) => {
      const prefs = S.loadPrefs();
      S.savePrefs({ ...prefs, scratch: { ...(prefs.scratch || {}), [m]: text } });
    },
  };
}

let notesSaveTimer = null;

function saveNotesNow() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  const target = notesTarget();
  const text = els.calcNotes.value.slice(0, S.NOTES_MAX);
  if (text === target.get()) return;
  target.set(text);
  els.notesStatus.textContent = 'Saved';
}

function openCalculator({ notes = false } = {}) {
  const target = notesTarget();
  els.calcNotes.value = target.get();
  els.notesFor.textContent = target.label;
  els.notesStatus.innerHTML = '&nbsp;';
  openDialog(els.calc);
  els.calcUse.disabled = !$('#guess');
  if (notes) els.calcNotes.focus();
  else els.calcExpr.focus();
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
  els.calcNotes.addEventListener('input', () => {
    els.notesStatus.textContent = 'Saving…';
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(saveNotesNow, 500);
  });
  els.calc.addEventListener('close', () => {
    if (notesSaveTimer) saveNotesNow();
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
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-pressed', String(dark));
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
  if (arena && arena.mode === 'timed' && (arena.status === 'ask' || arena.status === 'result')) {
    const left = arena.endsAt - Date.now();
    if (left <= 0) endRun();
    else {
      const clock = $('#arena-clock');
      if (clock) {
        clock.textContent = formatClock(left);
        clock.classList.toggle('urgent', left < 30000);
      }
    }
  }
  const nowNumber = Math.max(1, L.todayPuzzleNumber());
  if (nowNumber !== todayNumber) {
    todayNumber = nowNumber;
    els.banner.hidden = false;
    // The puzzle on screen is now an archive puzzle: refresh the parts that
    // say so, without touching a question the player may be typing into.
    if (bank && state && mode === 'daily') {
      renderMeta();
      if (view.kind === 'summary') renderSummary();
    }
  }
}

// -------------------------------------------------------------------- init

function routeHash() {
  const m = modeFromHash();
  if (m) {
    setMode(m, { silent: true });
    return;
  }
  const n = puzzleFromHash();
  if (n === null) {
    // "#main" (the skip link) and other in-page anchors are not puzzle links.
    if (location.hash && location.hash !== '#') return;
    if (mode !== 'daily') setMode('daily', { silent: true });
    if (puzzleNumber !== todayNumber) load(todayNumber);
    return;
  }
  if (mode !== 'daily') setMode('daily', { silent: true });
  if (n !== puzzleNumber) load(n);
  else renderMeta();
}

async function init() {
  $('#btn-help').addEventListener('click', () => openDialog(els.help));
  $('#btn-calc').addEventListener('click', () => openCalculator());
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
  for (const m of ['daily', 'unlimited', 'timed']) {
    $(`#mode-${m}`).addEventListener('click', () => {
      if (!bank) return;
      if (m === 'daily') goTo(todayNumber);
      else setMode(m);
    });
  }
  setupCalculator();
  setupBoard();
  setupSuggestions();
  syncOwnerUi();

  // Close dialogs when the backdrop is clicked.
  for (const dlg of [els.help, els.calc, els.stats, els.archive, els.board]) {
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

  window.addEventListener('hashchange', routeHash);

  load(puzzleFromHash() ?? todayNumber);
  const startMode = modeFromHash();
  if (startMode) setMode(startMode, { silent: true });
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
