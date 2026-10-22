# Ballpark — five estimation questions a day

**Ballpark** is a daily estimation game with **five questions per day**, plus an unlimited mode and a five-minute timed mode. Every question is a back-of-the-envelope estimate; the game asks whether your answer is in the ballpark.

Every day the game asks five questions like *"How many Hershey's Kisses, side by side, would it take to carpet Greenland?"* You get one guess per question, in any order. Your score for a question is **how many times off** you were: `1×` is exact, `2×` means you guessed double or half the real answer. Lower is better. Your daily score is the average of the five multiples, and you can share it as a line of emoji without spoiling the answers.

It is a static site: plain HTML, CSS and JavaScript modules, no build step, no server. Progress, streaks and statistics live in your browser's `localStorage`; statistics are derived from the saved puzzles, so a backup code of those puzzles carries everything. Accounts, leaderboards, community statistics and the owner view need the small API in `worker/` (see below); the claude.ai artifact version also saves results to the viewer's Claude account through the platform's per-viewer database (`src/sync.js`).

## Features

- **Five questions a day**, drawn from fourteen categories so no two questions in a day share a category.
- **Times-off scoring**: a multiple per question, daily average, 🎯🟢🟡🟠🔴 tiers. Answer the five in any order.
- **Unlimited mode** (fresh questions for as long as you like, leaderboard by questions answered) and **timed mode** (five minutes, leaderboard by answers within 10×).
- **Notes**: a scratchpad in the calculator, saved with each puzzle and shown with its results, so you can see how you worked it out.
- **Flexible input**: `1500`, `1.5k`, `2 million`, `3B`, `1e9`, or an expression such as `330M * 1.5 * 52`.
- **Unit switching**: answer in miles, feet, pounds, gallons, °F and so on; the unit menu in the guess box converts to the question's own unit for scoring and remembers your preference.
- **Built-in calculator** with k / M / B keys that can drop its result straight into your guess.
- **Reveal card** with your guess, the real answer, a log-scale "how far off" bar, a short explainer and the source.
- **Share text**, streaks (puzzles finished on their own day), statistics with a tier histogram and a list of every finished puzzle, and an **archive** of past puzzles.
- **Results that travel**: a backup code copies your whole history to another browser, and when the page runs on claude.ai (as a published artifact) results are also saved to your Claude account.
- **How others guessed and leaderboards** (with the accounts API deployed): every result card shows the number of players, the typical guess, a histogram of other guesses and the share of players you beat; signed-in players get leaderboards for the day's puzzle, all time, unlimited and timed, scored on the server from its own copy of the answers.
- **Suggestions box** at the bottom of the page, read only by the game's owner.
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

### What makes a good question

Every question must make the player **estimate** at least one real-world quantity they do not know exactly: how heavy a grain of rice is, how many searches Google handles in a day, how fast an airliner cruises, what a Big Mac costs. The fun is in reasoning from everyday knowledge to a number.

- **No arithmetic puzzles.** If every input is stated in the question and a calculator alone gives the exact answer ("Spending $1,000 a day, how many years would it take to get through a billion dollars?"), it is not an estimation question. Do not hand over the key rate or size either: say "walking all day, every day", "a lifetime", "an airliner at cruising speed", and let the explainer state the figure used.
- **No trivia.** A question whose answer hinges on one exact fact nobody could reason towards (a date, a record time, a precise count) tests recall, not estimation.
- **Keep it playful.** Familiar things measured in other familiar things; no science jargon, no bare statistics.

The explainer, shown after the answer, is where the real figures and the working go.

## Accounts (optional)

The game works without accounts. If you want players to create a username and password so their history follows them between devices, deploy the small API in `worker/` to Cloudflare Workers (free tier) and point the game at it.

What it is: one Worker (`worker/src/index.js`) and a D1 database. Passwords are hashed with PBKDF2-SHA256 and a per-user salt; sessions are random bearer tokens stored hashed and valid for 90 days; sign-in attempts are rate limited; every endpoint is covered by `tests/worker.test.js`, which runs the real Worker against an in-memory SQLite database.

To deploy it:

1. In Cloudflare, create an API token (My Profile → API Tokens → Create Token → use the "Edit Cloudflare Workers" template, then add **D1 → Edit** under Account permissions).
2. In this repository on GitHub, go to Settings → Secrets and variables → Actions and add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the Workers overview page).
3. Run the **Deploy accounts API** workflow (Actions tab → Run workflow). It creates the database, applies the schema and deploys. The log ends with the API's URL, something like `https://fermi-api.<your-subdomain>.workers.dev`.
4. Put that URL into `config.js` as `apiUrl`, commit, and the Statistics page gains Sign in / Create account.

**Owner view.** Signing in with the username `owner` and the owner key as the password opens the owner view in the leaderboard dialog: every account, every answer each player gave in every mode (with their notes), everyone's answers to the current puzzle including guests, the suggestions people sent in, and a button to set a new password on any account. Passwords themselves are stored as salted PBKDF2 hashes and are never shown to anyone. The key is not in the repository; `worker/wrangler.toml` holds only its SHA-256 (`ADMIN_KEY_HASH`). To choose a new key, run
`node -e "const c=require('crypto');const k=c.randomBytes(16).toString('hex');console.log(k, c.createHash('sha256').update(k).digest('hex'))"`, put the second value into `wrangler.toml`, deploy, and sign in with the first.

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
src/account.js          accounts client (sign-in, plays, suggestions, owner calls)
worker/                 Cloudflare Worker + D1 API: accounts, community stats, modes, owner view
src/main.js             UI controller
data/bank/*.json        question sources, one file per category
data/questions.json     merged bank served to the game (generated)
scripts/                dev server, bank build and validation
tests/                  unit tests (node --test) and the Playwright smoke test
```

## Credits

The questions are Fermi problems, after Enrico Fermi, patron saint of back-of-the-envelope estimates.
