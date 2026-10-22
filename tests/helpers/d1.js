// A tiny stand-in for Cloudflare's D1 binding, backed by Node's built-in
// SQLite, so the Worker can be tested without Wrangler.
import { DatabaseSync } from 'node:sqlite';

export function createD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql);

  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => statement(sql, p),
    async first(column) {
      const row = db.prepare(sql).get(...params);
      if (row === undefined) return null;
      return column ? row[column] : { ...row };
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async all() {
      return { success: true, results: db.prepare(sql).all(...params).map((r) => ({ ...r })) };
    },
  });

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    async exec(sql) {
      db.exec(sql);
    },
    raw: db,
  };
}
