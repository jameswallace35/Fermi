# Fermi — five estimation questions a day

A daily estimation game in the spirit of [fermi.gg](https://fermi.gg), with **five questions per day** instead of three.

Every day the game asks five questions like *"How many kilometres of railway does India have?"* You get one guess per question. Your score for a question is **how many times off** you were: `1×` is exact, `2×` means you guessed double or half the real answer. Lower is better. Your daily score is the average of the five multiples, and you can share it as a line of emoji without spoiling the answers.

It is a static site: plain HTML, CSS and JavaScript modules, no build step, no server. Progress, streaks and statistics live in your browser's `localStorage`; statistics are derived from the saved puzzles, so a backup code of those puzzles carries everything. There are no usernames or passwords (that would need a server), but the claude.ai artifact version saves results to the viewer's Claude account through the platform's per-viewer database (`src/sync.js`).

## Features

- **Five questions a day**, drawn from fourteen categories so no two questions in a day share a category.
- **Scoring like fermi.gg**: times-off multiple per question, daily average, 🎯🟢🟡🟠🔴 tiers.
- **Flexible input**: `1500`, `1.5k`, `2 million`, `3B`, `1e9`, or an expression such as `330M * 1.5 * 52`.
- **Unit switching**: answer in miles, feet, pounds, gallons, °F and so on; the unit menu in the guess box converts to the question's own unit for scoring and remembers your preference.
- **Built-in calculator** with k / M / B keys that can drop its result straight into your guess.
- **Reveal card** with your guess, the real answer, a log-scale "how far off" bar, a short explainer and the source.
- **Share text**, streaks (puzzles finished on their own day), statistics with a tier histogram and a list of every finished puzzle, and an **archive** of past puzzles.
- **Results that travel**: a backup code copies your whole history to another browser, and when the page runs on claude.ai (as a published artifact) results are also saved to your Claude account.
- Light and dark themes, keyboard friendly, mobile first, works as a home-screen app.

## Run it locally

Any static file server works. With Node 20+:

```bash
npm start            # serves http://127.0.0.1:8080/
```

or `python3 -m http.server 8080`. Opening `index.html` directly from disk will not work because the page loads its modules and `data/questions.json` over HTTP.

## Tests

```bash
npm test             # unit tests for scoring, dates, parsing, selection, calculator, bank builder
npm run validate     # checks data/questions.json and that it matches data/bank/*.json
npm run e2e          # plays a full puzzle in headless Chromium
```

The end-to-end test needs Playwright and a Chromium build, which are not installed by default:

```bash
npm install playwright && npx playwright install chromium
```

## How a day's puzzle is chosen

- Puzzle **No. 1** is 2026‑10‑21 and the number increases by one each local calendar day (`EPOCH_DATE_KEY` in `src/logic.js`).
- Categories rotate in the order listed in `scripts/build-bank.mjs`; day *n* uses five consecutive categories from that cycle, so the five are always distinct. Adding or removing a category changes that cycle and therefore re-rolls every puzzle that has not been played yet, so treat the category list as fixed once the game is live.
- Inside a category, questions are served in the order they appear in `data/questions.json`, cycling only when that category is exhausted. A question comes back only after every other question in its category has been played; `npm run validate` prints the first day on which anything repeats.
- A finished puzzle remembers which question ids it used, so your history stays correct even if the bank is reordered later.

There is no server, so the same puzzle appears for everyone on the same calendar date, which is what makes sharing scores fun.

## Adding questions

1. Edit a file in `data/bank/<category>.json` (new categories also need an entry at the end of `CATEGORIES` in `scripts/build-bank.mjs`). Each entry looks like:

   ```json
   {
     "id": "transport-heathrow-2023",
     "question": "How many passengers used London Heathrow airport in 2023?",
     "answer": 79200000,
     "unit": "passengers",
     "source_title": "Heathrow Airport — Wikipedia",
     "source_url": "https://en.wikipedia.org/wiki/Heathrow_Airport",
     "explainer": "Roughly 217,000 people a day, making it Europe's busiest airport.",
     "difficulty": 2,
     "as_of": "2023"
   }
   ```

   `id` is a stable handle (lowercase letters, digits, hyphens) that links players' saved results to the question, so keep it when you fix a typo or move the entry; an entry without one gets an id derived from its wording. `answer` is a plain number in `unit` (write `79200000`, never `79.2` with unit "million"). `difficulty` is 1 (easy) to 3 (hard). `as_of` is the year the figure refers to, or `"stable"`.

2. Run `npm run build:bank`. It validates every entry, keeps the order of questions that are already published (so scheduled puzzles do not change) and appends the new ones. It refuses to continue if an entry looks like a duplicate of another (set `"allow_similar": true` on one of them if they really are different facts) or if a published question would disappear (pass `--allow-remove` to confirm; players who finished that day lose the result).

3. Run `npm run validate` and commit `data/bank/` together with `data/questions.json`. Validation fails if the merged file is out of date with the source files, so CI catches a forgotten build.

New categories go at the **end** of `CATEGORIES` in `scripts/build-bank.mjs`.

## Accounts (optional)

The game works without accounts. If you want players to create a username and password so their history follows them between devices, deploy the small API in `worker/` to Cloudflare Workers (free tier) and point the game at it.

What it is: one Worker (`worker/src/index.js`) and a D1 database. Passwords are hashed with PBKDF2-SHA256 and a per-user salt; sessions are random bearer tokens stored hashed and valid for 90 days; sign-in attempts are rate limited; every endpoint is covered by `tests/worker.test.js`, which runs the real Worker against an in-memory SQLite database.

To deploy it:

1. In Cloudflare, create an API token (My Profile → API Tokens → Create Token → use the "Edit Cloudflare Workers" template, then add **D1 → Edit** under Account permissions).
2. In this repository on GitHub, go to Settings → Secrets and variables → Actions and add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the Workers overview page).
3. Run the **Deploy accounts API** workflow (Actions tab → Run workflow). It creates the database, applies the schema and deploys. The log ends with the API's URL, something like `https://fermi-api.<your-subdomain>.workers.dev`.
4. Put that URL into `config.js` as `apiUrl`, commit, and the Statistics page gains Sign in / Create account.

Optional hardening: in `worker/wrangler.toml` set `ALLOWED_ORIGINS` to your site's origin (for example `https://jameswallace35.github.io`) so only your page can call the API.

For local development, `npm run dev:api` starts the same Worker on http://127.0.0.1:8787 with an in-memory database; set `apiUrl` to that address.

## Deploying

The repository includes a GitHub Pages workflow (`.github/workflows/pages.yml`). In the repository settings, set **Pages → Source** to **GitHub Actions**; every push to `main` then publishes the site.

## Project layout

```
index.html              page shell and dialogs
config.js               deployment settings (accounts API URL)
styles.css              theme tokens, layout, components
src/logic.js            pure game rules: dates, scoring, parsing, selection, stats, share text
src/calc.js             safe expression evaluator
src/storage.js          localStorage wrapper and backup codes
src/sync.js             claude.ai per-account sync (no-op elsewhere)
src/account.js          username/password accounts client
worker/                 Cloudflare Worker + D1 accounts API
src/main.js             UI controller
data/bank/*.json        question sources, one file per category
data/questions.json     merged bank served to the game (generated)
scripts/                dev server, bank build and validation
tests/                  unit tests (node --test) and the Playwright smoke test
```

## Credits

Game design inspired by fermi.gg. Named after Enrico Fermi, patron saint of back-of-the-envelope estimates.
