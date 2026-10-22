// Optional cloud sync. When the page runs inside claude.ai's artifact viewer,
// the platform offers a small per-viewer private database tied to the
// viewer's Claude account. Finished puzzles are mirrored there so results
// follow the player across devices. Anywhere else (GitHub Pages, a local
// server) this module resolves null and the game keeps using localStorage.

function runtime() {
  if (typeof window === 'undefined') return null;
  const c = window.claude;
  return c && typeof c.use === 'function' ? c : null;
}

/**
 * Connect to the viewer's private puzzle collection. Resolves null when the
 * capability is unavailable (not on claude.ai, signed out, not granted).
 */
export async function connectSync() {
  const claude = runtime();
  if (!claude) return null;
  let db;
  let user;
  try {
    [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
  } catch {
    return null;
  }
  if (!db || !user) return null;
  let id = null;
  try {
    id = await user.id();
  } catch {
    return null;
  }
  if (!id) return null;

  // data/users/<id> is the viewer's private collection; one document per puzzle
  // lives under data/users/<id>/fermi/puzzles/<n>.
  let collection;
  try {
    collection = db.doc(`data/users/${id}/fermi`).collection('puzzles');
  } catch {
    return null;
  }
  const inflight = new Map();

  return {
    /** All remote puzzle records, keyed by puzzle number. */
    async pull() {
      const snap = await collection.get();
      const out = {};
      for (const doc of snap.docs) {
        const n = Number(doc.id);
        const data = doc.data();
        if (Number.isInteger(n) && n >= 1 && data && Array.isArray(data.guesses)) out[n] = data;
      }
      return out;
    },
    /** Write one puzzle record; writes to the same puzzle are serialised. */
    push(n, state) {
      const body = {
        n,
        guesses: state.guesses,
        ids: state.ids || null,
        units: state.units || null,
        completedAt: state.completedAt || null,
      };
      if (typeof state.notes === 'string') body.notes = state.notes;
      const prev = inflight.get(n) || Promise.resolve();
      const next = prev.catch(() => {}).then(() => collection.doc(String(n)).set(body));
      inflight.set(n, next);
      return next;
    },
  };
}
