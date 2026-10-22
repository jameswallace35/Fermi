// Username-and-password accounts, backed by the Worker in worker/. Only active
// when config.js names an API URL. The session token lives in localStorage and
// is sent as a bearer token; nothing here uses cookies.

const KEY = 'fermi5:account';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function apiUrl() {
  const c = typeof window !== 'undefined' ? window.FERMI_CONFIG : null;
  return c && typeof c.apiUrl === 'string' ? c.apiUrl.trim().replace(/\/+$/, '') : '';
}

export function available() {
  return apiUrl() !== '';
}

export function session() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    return s && typeof s.token === 'string' && typeof s.username === 'string' ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}

async function request(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(apiUrl() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Could not reach the accounts server. Check your connection and try again.');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `The accounts server answered ${res.status}`);
  return data;
}

export async function signup(username, password) {
  const d = await request('POST', '/api/signup', { body: { username, password } });
  saveSession({ token: d.token, username: d.username });
  return d.username;
}

export async function login(username, password) {
  const d = await request('POST', '/api/login', { body: { username, password } });
  saveSession({ token: d.token, username: d.username });
  return d.username;
}

/** Forget the session locally and tell the server; never throws. */
export async function logout() {
  const s = session();
  saveSession(null);
  if (!s) return;
  try {
    await request('POST', '/api/logout', { token: s.token });
  } catch {
    // the local sign-out is what matters
  }
}

/** Drop the local session without calling the server (used when it reports 401). */
export function forgetSession() {
  saveSession(null);
}

/** Record a guess and get the community statistics for that question. */
export async function submitGuess({ questionId, guess, answer, anonymousId }) {
  const s = session();
  const body = { question_id: questionId, guess, answer };
  if (!s) body.player = anonymousId;
  return request('POST', '/api/guesses', { body, token: s ? s.token : undefined });
}

/** Community statistics for a question, optionally compared against a guess. */
export async function fetchStats({ questionId, answer, guess }) {
  const params = new URLSearchParams({ question_id: questionId, answer: String(answer) });
  if (guess) params.set('guess', String(guess));
  return request('GET', `/api/stats?${params}`);
}

/** The leaderboard for one puzzle (`{ n }`) or all time (`{ scope: 'all' }`). Needs a session. */
export async function fetchLeaderboard({ scope, n }) {
  const s = session();
  if (!s) throw new ApiError(401, 'Sign in to see the leaderboard');
  const params = scope === 'all' ? new URLSearchParams({ scope: 'all' }) : new URLSearchParams({ n: String(n) });
  return request('GET', `/api/leaderboard?${params}`, { token: s.token });
}

/** A sync handle with the same shape as the claude.ai one, or null when signed out. */
export function connectAccountSync() {
  const s = session();
  if (!s) return null;
  return {
    kind: 'account',
    username: s.username,
    async pull() {
      const d = await request('GET', '/api/puzzles', { token: s.token });
      return d && d.puzzles && typeof d.puzzles === 'object' ? d.puzzles : {};
    },
    async push(n, state) {
      await request('PUT', '/api/puzzles', { token: s.token, body: { puzzles: { [n]: state } } });
    },
  };
}
