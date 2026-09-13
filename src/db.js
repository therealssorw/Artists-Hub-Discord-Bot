import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Storage for per-day, per-user message counts. Unique senders for a day are
 * simply the number of rows for that day; messages are the sum of `count`.
 */
export class StatsStore {
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_user_messages (
        day     TEXT    NOT NULL,
        user_id TEXT    NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_user_messages_day ON daily_user_messages (day);

      CREATE TABLE IF NOT EXISTS reports (
        day       TEXT PRIMARY KEY,
        posted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.stmts = {
      increment: this.db.prepare(`
        INSERT INTO daily_user_messages (day, user_id, count) VALUES (?, ?, ?)
        ON CONFLICT (day, user_id) DO UPDATE SET count = count + excluded.count
      `),
      dayTotals: this.db.prepare(`
        SELECT COALESCE(SUM(count), 0) AS messages, COUNT(*) AS uniqueSenders
        FROM daily_user_messages WHERE day = ?
      `),
      rangeTotals: this.db.prepare(`
        SELECT day, SUM(count) AS messages, COUNT(*) AS uniqueSenders
        FROM daily_user_messages
        WHERE day >= ? AND day <= ?
        GROUP BY day
        ORDER BY day
      `),
      clearDay: this.db.prepare('DELETE FROM daily_user_messages WHERE day = ?'),
      firstDay: this.db.prepare('SELECT MIN(day) AS day FROM daily_user_messages'),
      markReported: this.db.prepare(
        'INSERT OR REPLACE INTO reports (day, posted_at) VALUES (?, ?)',
      ),
      wasReported: this.db.prepare('SELECT 1 FROM reports WHERE day = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    };
  }

  /** Record `count` messages from `userId` on `day`. */
  recordMessage(day, userId, count = 1) {
    this.stmts.increment.run(day, userId, count);
  }

  /** Replace all data for a day with the given { userId: count } map. */
  replaceDay(day, countsByUser) {
    const tx = this.db.transaction(() => {
      this.stmts.clearDay.run(day);
      for (const [userId, count] of Object.entries(countsByUser)) {
        this.stmts.increment.run(day, userId, count);
      }
    });
    tx();
  }

  /** { messages, uniqueSenders } for a single day (zeros if nothing recorded). */
  getDay(day) {
    return this.stmts.dayTotals.get(day);
  }

  /** Array of { day, messages, uniqueSenders } for days in [from, to] that have data. */
  getRange(from, to) {
    return this.stmts.rangeTotals.all(from, to);
  }

  /** Earliest day with any data, or null. */
  getFirstDay() {
    return this.stmts.firstDay.get().day ?? null;
  }

  /** Day tracking began, as recorded by the bot on first start (may be null). */
  getTrackingSince() {
    return this.stmts.getMeta.get('tracking_since')?.value ?? null;
  }

  setTrackingSinceIfUnset(day) {
    if (!this.getTrackingSince()) {
      this.stmts.setMeta.run('tracking_since', day);
    }
  }

  markReported(day, postedAt = new Date()) {
    this.stmts.markReported.run(day, postedAt.toISOString());
  }

  wasReported(day) {
    return Boolean(this.stmts.wasReported.get(day));
  }

  close() {
    this.db.close();
  }
}
