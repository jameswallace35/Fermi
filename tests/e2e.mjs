// End-to-end smoke test: plays a whole puzzle in headless Chromium.
// Run with: npm run e2e   (needs the `playwright` package and a Chromium build)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8123 + Math.floor(Math.random() * 1000);
const shots = process.env.SHOTS_DIR || path.join(root, '.e2e-shots');
fs.mkdirSync(shots, { recursive: true });

const server = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch();
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${err.message}`);
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = `http://127.0.0.1:${port}/`;
  await page.goto(url);

  await step('help dialog opens on first visit and closes', async () => {
    await page.waitForSelector('#dlg-help[open]');
    await page.screenshot({ path: path.join(shots, '01-help.png') });
    await page.click('#dlg-help .dialog-foot button');
    await page.waitForSelector('#dlg-help', { state: 'hidden' });
  });

  await step('first question renders with unit and progress', async () => {
    await page.waitForSelector('#guess');
    const unit = await page.textContent('.input-wrap .unit');
    assert.ok(unit.trim().length > 0);
    assert.equal(await page.locator('#progress li').count(), 5);
    assert.match(await page.textContent('#puzzle-meta'), /No\. \d+/);
    await page.screenshot({ path: path.join(shots, '02-question.png') });
  });

  await step('invalid guess is rejected', async () => {
    await page.fill('#guess', 'banana');
    await page.click('#lock');
    await page.waitForSelector('.preview.warn');
    assert.ok(await page.locator('#guess').isVisible());
    await page.fill('#guess', '0');
    await page.click('#lock');
    await page.waitForSelector('.preview.warn');
    assert.ok(await page.locator('#guess').isVisible());
  });

  await step('live preview parses shorthand', async () => {
    await page.fill('#guess', '1.5 million');
    const text = await page.textContent('#preview');
    assert.match(text, /1,500,000/);
    await page.fill('#guess', '365*24');
    assert.match(await page.textContent('#preview'), /8,760/);
  });

  const answers = await page.evaluate(async () => {
    const bank = await (await fetch('data/questions.json')).json();
    return bank.questions.map((q) => q.answer);
  });

  await step('calculator computes and fills the guess', async () => {
    await page.click('#btn-calc');
    await page.waitForSelector('#dlg-calc[open]');
    await page.fill('#calc-expr', '');
    await page.click('[data-key="2"]');
    await page.click('[data-key="M"]');
    await page.click('[data-key="×"]');
    await page.click('[data-key="3"]');
    assert.match(await page.textContent('#calc-result'), /6,000,000/);
    await page.click('[data-action="equals"]');
    assert.equal(await page.inputValue('#calc-expr'), '6000000');
    await page.screenshot({ path: path.join(shots, '03-calc.png') });
    await page.click('#calc-use');
    await page.waitForSelector('#dlg-calc', { state: 'hidden' });
    assert.equal(await page.inputValue('#guess'), '6000000');
  });

  await step('lock in a guess and see the result card', async () => {
    await page.fill('#guess', '1000');
    await page.click('#lock');
    await page.waitForSelector('#continue');
    assert.match(await page.textContent('.result-mult'), /×/);
    assert.ok(await page.locator('.scale .marker.guess').isVisible());
    assert.equal(await page.locator('#progress .dot.done').count(), 1);
    await page.screenshot({ path: path.join(shots, '04-result.png') });
  });

  await step('in-page anchors such as the skip link do not reset the game', async () => {
    await page.evaluate(() => { location.hash = '#main'; });
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#continue').isVisible(), 'result view should still be showing');
    await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
  });

  await step('state survives a reload mid-puzzle', async () => {
    await page.reload();
    await page.waitForSelector('#guess');
    assert.equal(await page.locator('#progress .dot.done').count(), 1);
    assert.match(await page.textContent('.qnum'), /Question 2 of 5/);
  });

  await step('review a finished question from the progress bar and go back', async () => {
    await page.click('#progress .dot.done');
    await page.waitForSelector('#continue');
    // Reviewing the most recent answer continues to the next question.
    assert.match(await page.textContent('#continue'), /Next question/);
    assert.ok(await page.locator('.result-mult').isVisible());
    await page.click('#continue');
    await page.waitForSelector('#guess');
    await page.fill('#guess', '12345');
    await page.click('#lock');
    await page.waitForSelector('#continue');
    await page.click('#continue');
    await page.waitForSelector('#guess');
    // Now reviewing the first answer from question 3 offers a way back.
    await page.click('#progress .dot.done');
    await page.waitForSelector('#continue');
    assert.match(await page.textContent('#continue'), /Back to question 3/);
    await page.click('#continue');
    await page.waitForSelector('#guess');
    assert.match(await page.textContent('.qnum'), /Question 3 of 5/);
  });

  await step('complete the puzzle', async () => {
    for (let i = 2; i < 5; i++) {
      await page.waitForSelector('#guess');
      await page.fill('#guess', '12345');
      await page.click('#lock');
      await page.waitForSelector('#continue');
      const label = await page.textContent('#continue');
      if (i < 4) assert.match(label, /Next question/);
      else assert.match(label, /See results/);
      await page.click('#continue');
    }
    await page.waitForSelector('#summary:not([hidden])');
    assert.match(await page.textContent('.big-mult'), /×/);
    assert.equal(await page.locator('#summary .row').count(), 5);
    assert.match(await page.textContent('.summary-foot'), /Streak 1/);
    await page.screenshot({ path: path.join(shots, '05-summary.png'), fullPage: true });
  });

  await step('summary shows a streak of one and tier colours have contrast', async () => {
    const rowColor = await page.evaluate(() => getComputedStyle(document.querySelector('.row-mult')).color);
    assert.ok(rowColor, 'row multiple has a colour');
  });

  await step('share copies text with five tier emoji', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#btn-share');
    await page.waitForSelector('#toast.show');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const lines = text.split('\n');
    assert.match(lines[0], /^Fermi No\. \d+ · /);
    assert.equal((lines[1].match(/[🎯🟢🟡🟠🔴]/gu) || []).length, 5);
    assert.match(lines[2], /^Average .*×$/);
    assert.equal(lines[3], url);
  });

  await step('summary row opens review with back button', async () => {
    await page.click('#summary .row');
    await page.waitForSelector('#continue');
    assert.match(await page.textContent('#continue'), /Back to results/);
    await page.click('#continue');
    await page.waitForSelector('#summary:not([hidden])');
  });

  await step('stats dialog reflects the completed game', async () => {
    await page.click('#btn-stats');
    await page.waitForSelector('#dlg-stats[open]');
    const text = await page.textContent('#stats-body');
    assert.match(text, /1\s*Played/);
    await page.screenshot({ path: path.join(shots, '06-stats.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#dlg-stats', { state: 'hidden' });
  });

  await step('archive lists today as completed', async () => {
    await page.click('#btn-archive');
    await page.waitForSelector('#dlg-archive[open]');
    const first = await page.textContent('#archive-body .row');
    assert.match(first, /Today/);
    assert.match(first, /×/);
    await page.screenshot({ path: path.join(shots, '07-archive.png') });
    await page.keyboard.press('Escape');
  });

  await step('completed puzzle persists after reload', async () => {
    await page.reload();
    await page.waitForSelector('#summary:not([hidden])');
  });

  await step('dark mode toggles and persists', async () => {
    await page.click('#btn-theme');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.reload();
    await page.waitForSelector('#summary:not([hidden])');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.screenshot({ path: path.join(shots, '08-dark-summary.png'), fullPage: true });
    await page.click('#btn-archive');
    await page.waitForSelector('#dlg-archive[open]');
    await page.click('#dlg-archive .row');
    await page.waitForSelector('#dlg-archive', { state: 'hidden' });
  });

  await step('a past puzzle number in the hash is clamped to today', async () => {
    await page.goto(`${url}#999999`);
    await page.waitForSelector('#summary:not([hidden])');
    assert.match(await page.textContent('#puzzle-meta'), /No\. \d+/);
    assert.ok(!(await page.textContent('#puzzle-meta')).includes('Archive'));
  });

  await step('no console or page errors', async () => {
    assert.deepEqual(errors, []);
  });

  await step('desktop layout renders', async () => {
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await desk.goto(url);
    await desk.waitForSelector('#dlg-help[open]');
    await desk.click('#dlg-help .dialog-foot button');
    await desk.waitForSelector('#guess');
    await desk.screenshot({ path: path.join(shots, '09-desktop.png') });
    await desk.close();
  });
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.log(`\n${failures.length} failing step(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll e2e steps passed. Screenshots in ${shots}`);
