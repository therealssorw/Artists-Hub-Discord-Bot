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

      CREATE TABLE IF NOT EXISTS member_events (
        day      TEXT    NOT NULL,
        guild_id TEXT    NOT NULL,
        user_id  TEXT    NOT NULL,
        kind     TEXT    NOT NULL CHECK (kind IN ('join', 'leave')),
        ts       INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, kind, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_member_events_day ON member_events (day);

      CREATE TABLE IF NOT EXISTS bump_settings (
        guild_id TEXT PRIMARY KEY,
        role_id  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bump_reminders (
        guild_id   TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        due_at     INTEGER NOT NULL
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
      firstTimeSenders: this.db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT user_id, MIN(day) AS first_day FROM daily_user_messages GROUP BY user_id
        ) WHERE first_day = ?
      `),
      addMemberEvent: this.db.prepare(`
        INSERT OR IGNORE INTO member_events (day, guild_id, user_id, kind, ts) VALUES (?, ?, ?, ?, ?)
      `),
      memberEventCounts: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'join'  THEN 1 ELSE 0 END), 0) AS joins,
          COALESCE(SUM(CASE WHEN kind = 'leave' THEN 1 ELSE 0 END), 0) AS leaves
        FROM member_events WHERE day = ?
      `),
      clearJoinsForDay: this.db.prepare("DELETE FROM member_events WHERE day = ? AND kind = 'join'"),
      firstDay: this.db.prepare('SELECT MIN(day) AS day FROM daily_user_messages'),
      markReported: this.db.prepare(
        'INSERT OR REPLACE INTO reports (day, posted_at) VALUES (?, ?)',
      ),
      wasReported: this.db.prepare('SELECT 1 FROM reports WHERE day = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      getBumpRole: this.db.prepare('SELECT role_id AS roleId FROM bump_settings WHERE guild_id = ?'),
      setBumpRole: this.db.prepare(
        'INSERT OR REPLACE INTO bump_settings (guild_id, role_id) VALUES (?, ?)',
      ),
      clearBumpRole: this.db.prepare('DELETE FROM bump_settings WHERE guild_id = ?'),
      getBumpReminder: this.db.prepare(
        'SELECT guild_id AS guildId, channel_id AS channelId, due_at AS dueAt FROM bump_reminders WHERE guild_id = ?',
      ),
      allBumpReminders: this.db.prepare(
        'SELECT guild_id AS guildId, channel_id AS channelId, due_at AS dueAt FROM bump_reminders',
      ),
      setBumpReminder: this.db.prepare(
        'INSERT OR REPLACE INTO bump_reminders (guild_id, channel_id, due_at) VALUES (?, ?, ?)',
      ),
      clearBumpReminder: this.db.prepare('DELETE FROM bump_reminders WHERE guild_id = ?'),
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

  /** Number of users whose first recorded message was on `day`. */
  getFirstTimeSenders(day) {
    return this.stmts.firstTimeSenders.get(day).count;
  }

  /** Record a member joining or leaving. `kind` is 'join' or 'leave'. */
  recordMemberEvent(day, guildId, userId, kind, ts = Date.now()) {
    this.stmts.addMemberEvent.run(day, guildId, userId, kind, ts);
  }

  /** { joins, leaves } for a single day. */
  getMemberEvents(day) {
    return this.stmts.memberEventCounts.get(day);
  }

  /** Replace recorded joins for a day (used by backfill from member join dates). */
  replaceJoins(day, joins) {
    const tx = this.db.transaction(() => {
      this.stmts.clearJoinsForDay.run(day);
      for (const { guildId, userId, ts } of joins) {
        this.stmts.addMemberEvent.run(day, guildId, userId, 'join', ts);
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

  // ----- Disboard bump reminders -----

  /** Role to ping when the server can be bumped again, or null if not set. */
  getBumpRole(guildId) {
    return this.stmts.getBumpRole.get(guildId)?.roleId ?? null;
  }

  setBumpRole(guildId, roleId) {
    this.stmts.setBumpRole.run(guildId, roleId);
  }

  clearBumpRole(guildId) {
    this.stmts.clearBumpRole.run(guildId);
  }

  /** Pending reminder for a guild: { guildId, channelId, dueAt } or null. */
  getBumpReminder(guildId) {
    return this.stmts.getBumpReminder.get(guildId) ?? null;
  }

  getAllBumpReminders() {
    return this.stmts.allBumpReminders.all();
  }

  setBumpReminder(guildId, channelId, dueAt) {
    this.stmts.setBumpReminder.run(guildId, channelId, dueAt);
  }

  clearBumpReminder(guildId) {
    this.stmts.clearBumpReminder.run(guildId);
  }

  close() {
    this.db.close();
  }
}
