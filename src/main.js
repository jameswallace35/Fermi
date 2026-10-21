// UI controller for Fermi. Game rules live in logic.js; this file only
// renders state and reacts to input.

import * as L from './logic.js';
import { tryEvaluate } from './calc.js';
import * as S from './storage.js';

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
};

let bank = null;
let todayNumber = L.todayPuzzleNumber();
let puzzleNumber = todayNumber;
let questions = [];
let state = null;
let view = { kind: 'play' };
let lastCalcValue = NaN;
let archiveShown = 0;

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

function isComplete(n) {
  if (n === puzzleNumber && state) return complete();
  const st = S.loadPuzzleState(n);
  return st.guesses.length >= L.QUESTIONS_PER_DAY;
}

function complete() {
  return questions.length > 0 && state.guesses.length >= questions.length;
}

function multiples() {
  return state.guesses.map((g, i) => L.scoreMultiple(g, questions[i].answer));
}

function puzzleUrl() {
  return `${location.origin}${location.pathname}`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

function parseGuess(raw, unit) {
  let v = L.parseNumber(raw, unit);
  if (Number.isNaN(v)) {
    let s = String(raw).trim();
    if (unit) s = s.replace(new RegExp(`\\s*${escapeRegExp(unit)}$`, 'i'), '');
    v = tryEvaluate(s);
  }
  return v;
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
    state = { guesses: [], completedAt: null, recorded: false };
    questions = L.selectQuestions(bank, n);
  } else {
    questions = resolved;
  }
  if (state.guesses.length > questions.length) state.guesses = state.guesses.slice(0, questions.length);
  view = complete() ? { kind: 'summary' } : { kind: 'play' };
  render();
}

function puzzleFromHash() {
  const m = /^#(\d+)$/.exec(location.hash);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return 1;
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

function render() {
  renderMeta();
  renderProgress();
  const showSummary = view.kind === 'summary';
  els.card.hidden = showSummary;
  els.summary.hidden = !showSummary;
  if (view.kind === 'play') renderQuestion(state.guesses.length);
  else if (view.kind === 'result') renderResult(view.index);
  else renderSummary();
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
    return `<li><button type="button" class="${cls}" data-index="${i}" aria-label="${esc(label)}" ${done ? '' : 'disabled'}>${done ? tier.emoji : i + 1}</button></li>`;
  }).join('');
  $$('.dot.done', els.progress).forEach((btn) => {
    btn.addEventListener('click', () => {
      view = { kind: 'result', index: Number(btn.dataset.index), from: complete() ? 'summary' : 'play' };
      render();
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
        <input id="guess" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your estimate" enterkeyhint="done">
        <span class="unit" aria-hidden="true">${esc(q.unit)}</span>
      </div>
      <p id="preview" class="preview" aria-live="polite">&nbsp;</p>
      <button type="submit" id="lock" class="btn primary wide">Lock it in</button>
    </form>`;

  const form = $('#guess-form');
  const input = $('#guess');
  const preview = $('#preview');
  const wrap = $('.input-wrap', els.card);

  const updatePreview = () => {
    const raw = input.value;
    if (!raw.trim()) {
      preview.innerHTML = '&nbsp;';
      preview.className = 'preview';
      return;
    }
    const v = parseGuess(raw, q.unit);
    if (!Number.isFinite(v) || v <= 0) {
      preview.textContent = 'Enter a positive number: 1500, 1.5k, 2 million, 3B, 1e9 or a sum like 365*24';
      preview.className = 'preview warn';
      return;
    }
    const compact = L.formatCompact(v);
    preview.textContent = `= ${L.formatNumber(v)} ${q.unit}${compact ? ` (${compact})` : ''}`;
    preview.className = 'preview ok';
  };
  input.addEventListener('input', updatePreview);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = parseGuess(input.value, q.unit);
    if (!Number.isFinite(v) || v <= 0) {
      updatePreview();
      if (!input.value.trim()) {
        preview.textContent = 'Type your estimate first.';
        preview.className = 'preview warn';
      }
      wrap.classList.remove('shake');
      void wrap.offsetWidth; // restart the animation
      wrap.classList.add('shake');
      input.focus();
      return;
    }
    lockIn(i, v);
  });

  if (view.focusInput) {
    input.focus();
    view.focusInput = false;
  }
}

function lockIn(i, value) {
  if (state.guesses.length !== i) return; // stale form
  state.guesses.push(value);
  state.ids = questions.map((q) => q.id);
  if (complete()) state.completedAt = Date.now();
  S.savePuzzleState(puzzleNumber, state);
  if (complete() && !state.recorded) {
    const avg = L.dailyScore(multiples());
    const streak = L.computeStreak(isComplete, todayNumber);
    S.saveStats(L.recordCompletion(S.loadStats(), avg, streak));
    state.recorded = true;
    S.savePuzzleState(puzzleNumber, state);
  }
  view = { kind: 'result', index: i };
  render();
  const btn = $('#continue');
  if (btn) btn.focus({ preventScroll: true });
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

  let label;
  let next;
  if (view.from === 'summary') {
    label = 'Back to results';
    next = () => { view = { kind: 'summary' }; render(); };
  } else if (done && isLast) {
    label = 'See results';
    next = () => { view = { kind: 'summary' }; render(); };
  } else if (!done && i === state.guesses.length - 1) {
    label = 'Next question';
    next = () => { view = { kind: 'play', focusInput: true }; render(); };
  } else if (done) {
    label = 'Back to results';
    next = () => { view = { kind: 'summary' }; render(); };
  } else {
    label = `Back to question ${state.guesses.length + 1}`;
    next = () => { view = { kind: 'play' }; render(); };
  }

  const direction = Math.abs(m - 1) < 0.005 ? '' : g > q.answer ? ' · too high' : ' · too low';
  const compact = L.formatCompact(q.answer);
  const asOf = q.as_of && q.as_of !== 'stable' ? ` · ${esc(q.as_of)}` : '';
  const srcHost = (() => { try { return new URL(q.source_url).hostname.replace(/^www\./, ''); } catch { return ''; } })();

  els.card.innerHTML = `
    <div class="card-top">
      <span class="chip">${esc(q.categoryName)}</span>
      <p class="qnum">Question ${i + 1} of ${questions.length}</p>
    </div>
    <h2 class="question">${esc(q.question)}</h2>
    <div class="result ${tier.cls}" role="status" aria-live="polite">
      <div class="result-score">
        <span class="result-mult">${L.formatMultiple(m)}</span>
        <span class="result-label">${tier.emoji} ${tier.label}${direction}</span>
      </div>
      <dl class="compare">
        <div>
          <dt>Your guess</dt>
          <dd>${L.formatNumber(g)} <small>${esc(q.unit)}</small>${L.formatCompact(g) ? `<span class="compact">${esc(L.formatCompact(g))}</span>` : ''}</dd>
        </div>
        <div>
          <dt>Answer</dt>
          <dd>${L.formatNumber(q.answer)} <small>${esc(q.unit)}</small>${compact ? `<span class="compact">${esc(compact)}</span>` : ''}</dd>
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
  const stats = S.loadStats() || L.defaultStats();
  const streak = L.computeStreak(isComplete, todayNumber);
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
              <span class="row-nums">You: ${L.formatNumber(state.guesses[i])} · Answer: ${L.formatNumber(q.answer)} ${esc(q.unit)}</span>
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
      <p>🔥 Streak ${streak} · Played ${stats.played} · Best ${stats.best != null ? L.formatMultiple(stats.best) : '—'}</p>
    </div>`;

  $$('.row', els.summary).forEach((btn) => {
    btn.addEventListener('click', () => {
      view = { kind: 'result', index: Number(btn.dataset.index), from: 'summary' };
      render();
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
  }
}

// ------------------------------------------------------------------ dialogs

function openDialog(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function renderStats() {
  const stats = S.loadStats() || L.defaultStats();
  const streak = L.computeStreak(isComplete, todayNumber);
  const avg = stats.played ? stats.sumAvg / stats.played : null;
  const tiers = stats.tiers || [0, 0, 0, 0, 0];
  const max = Math.max(1, ...tiers);
  $('#stats-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-value">${stats.played}</span><span class="stat-label">Played</span></div>
      <div class="stat"><span class="stat-value">${avg != null ? L.formatMultiple(avg) : '—'}</span><span class="stat-label">Average</span></div>
      <div class="stat"><span class="stat-value">${streak}</span><span class="stat-label">Streak</span></div>
      <div class="stat"><span class="stat-value">${stats.maxStreak || 0}</span><span class="stat-label">Best streak</span></div>
    </div>
    <p class="small muted">Daily scores by tier${stats.best != null ? ` · best day ${L.formatMultiple(stats.best)}` : ''}</p>
    <ul class="hist">
      ${L.TIERS.map((t, i) => `<li class="hist-tier-${i}"><span aria-hidden="true">${t.emoji}</span><span class="hist-bar" style="width:${Math.max(2, (100 * (tiers[i] || 0)) / max)}%"></span><span class="hist-count">${tiers[i] || 0}</span></li>`).join('')}
    </ul>`;
}

function renderArchive(reset = true) {
  if (reset) archiveShown = 0;
  const body = $('#archive-body');
  const end = Math.min(todayNumber, archiveShown + ARCHIVE_PAGE);
  const items = [];
  for (let n = todayNumber - archiveShown; n > todayNumber - end; n--) {
    const st = n === puzzleNumber ? state : S.loadPuzzleState(n);
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

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  S.savePrefs({ ...S.loadPrefs(), theme: next });
}

// -------------------------------------------------------------- day change

function tick() {
  const cd = $('#countdown');
  if (cd) cd.textContent = L.formatCountdown(L.msUntilLocalMidnight());
  const nowNumber = L.todayPuzzleNumber();
  if (nowNumber !== todayNumber) {
    todayNumber = nowNumber;
    els.banner.hidden = false;
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
    renderArchive(true);
    openDialog(els.archive);
  });
  $('#btn-theme').addEventListener('click', toggleTheme);
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
    if (n === null) load(todayNumber);
    else if (n !== puzzleNumber) load(n);
  });

  load(puzzleFromHash() ?? todayNumber);
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
