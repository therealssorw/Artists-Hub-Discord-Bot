import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const REMINDER_COLUMNS = `
  id, guild_id AS guildId, channel_id AS channelId, creator_id AS creatorId, message, pings,
  due_at AS dueAt, repeat, created_at AS createdAt
`;

function toReminder(row) {
  return { ...row, pings: JSON.parse(row.pings) };
}

/**
 * Storage for per-server, per-day, per-user message counts. Unique senders for
 * a day are simply the number of rows for that server and day; messages are
 * the sum of `count`.
 */
export class StatsStore {
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_messages (
        guild_id TEXT    NOT NULL,
        day      TEXT    NOT NULL,
        user_id  TEXT    NOT NULL,
        count    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, day, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_guild_messages_user ON guild_messages (guild_id, user_id);

      CREATE TABLE IF NOT EXISTS guild_reports (
        guild_id  TEXT NOT NULL,
        day       TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, day)
      );

      CREATE TABLE IF NOT EXISTS stats_settings (
        guild_id    TEXT PRIMARY KEY,
        channel_id  TEXT NOT NULL,
        report_time TEXT NOT NULL -- HH:MM in the configured timezone
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
      CREATE INDEX IF NOT EXISTS idx_member_events_day ON member_events (guild_id, day);

      CREATE TABLE IF NOT EXISTS bump_settings (
        guild_id TEXT PRIMARY KEY,
        role_id  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bump_reminders (
        guild_id   TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        due_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT    NOT NULL,
        channel_id TEXT    NOT NULL,
        creator_id TEXT    NOT NULL,
        message    TEXT    NOT NULL,
        pings      TEXT    NOT NULL, -- JSON { users: [], roles: [], everyone: null | 'everyone' | 'here' }
        due_at     INTEGER NOT NULL,
        repeat     TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_guild ON reminders (guild_id, creator_id);

      CREATE TABLE IF NOT EXISTS levels (
        guild_id   TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        xp         INTEGER NOT NULL DEFAULT 0,
        messages   INTEGER NOT NULL DEFAULT 0, -- messages that earned XP
        last_xp_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_levels_rank ON levels (guild_id, xp DESC);

      CREATE TABLE IF NOT EXISTS level_rewards (
        guild_id TEXT    NOT NULL,
        role_id  TEXT    NOT NULL,
        level    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );
    `);

    this.migrateSingleServerTables();

    this.stmts = {
      increment: this.db.prepare(`
        INSERT INTO guild_messages (guild_id, day, user_id, count) VALUES (?, ?, ?, ?)
        ON CONFLICT (guild_id, day, user_id) DO UPDATE SET count = count + excluded.count
      `),
      dayTotals: this.db.prepare(`
        SELECT COALESCE(SUM(count), 0) AS messages, COUNT(*) AS uniqueSenders
        FROM guild_messages WHERE guild_id = ? AND day = ?
      `),
      rangeTotals: this.db.prepare(`
        SELECT day, SUM(count) AS messages, COUNT(*) AS uniqueSenders
        FROM guild_messages
        WHERE guild_id = ? AND day >= ? AND day <= ?
        GROUP BY day
        ORDER BY day
      `),
      userTotal: this.db.prepare(
        'SELECT COALESCE(SUM(count), 0) AS count FROM guild_messages WHERE guild_id = ? AND user_id = ?',
      ),
      clearDay: this.db.prepare('DELETE FROM guild_messages WHERE guild_id = ? AND day = ?'),
      firstTimeSenders: this.db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT user_id, MIN(day) AS first_day FROM guild_messages WHERE guild_id = ? GROUP BY user_id
        ) WHERE first_day = ?
      `),
      addMemberEvent: this.db.prepare(`
        INSERT OR IGNORE INTO member_events (day, guild_id, user_id, kind, ts) VALUES (?, ?, ?, ?, ?)
      `),
      memberEventCounts: this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'join'  THEN 1 ELSE 0 END), 0) AS joins,
          COALESCE(SUM(CASE WHEN kind = 'leave' THEN 1 ELSE 0 END), 0) AS leaves
        FROM member_events WHERE guild_id = ? AND day = ?
      `),
      clearJoinsForDay: this.db.prepare(
        "DELETE FROM member_events WHERE guild_id = ? AND day = ? AND kind = 'join'",
      ),
      firstDay: this.db.prepare('SELECT MIN(day) AS day FROM guild_messages WHERE guild_id = ?'),
      markReported: this.db.prepare(
        'INSERT OR REPLACE INTO guild_reports (guild_id, day, posted_at) VALUES (?, ?, ?)',
      ),
      wasReported: this.db.prepare('SELECT 1 FROM guild_reports WHERE guild_id = ? AND day = ?'),
      getStatsSettings: this.db.prepare(
        'SELECT guild_id AS guildId, channel_id AS channelId, report_time AS time FROM stats_settings WHERE guild_id = ?',
      ),
      allStatsSettings: this.db.prepare(
        'SELECT guild_id AS guildId, channel_id AS channelId, report_time AS time FROM stats_settings',
      ),
      setStatsSettings: this.db.prepare(
        'INSERT OR REPLACE INTO stats_settings (guild_id, channel_id, report_time) VALUES (?, ?, ?)',
      ),
      clearStatsSettings: this.db.prepare('DELETE FROM stats_settings WHERE guild_id = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      deleteMeta: this.db.prepare('DELETE FROM meta WHERE key = ?'),
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
      addReminder: this.db.prepare(`
        INSERT INTO reminders (guild_id, channel_id, creator_id, message, pings, due_at, repeat, created_at)
        VALUES (@guildId, @channelId, @creatorId, @message, @pings, @dueAt, @repeat, @createdAt)
      `),
      getReminder: this.db.prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`),
      allReminders: this.db.prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders ORDER BY due_at`),
      guildReminders: this.db.prepare(
        `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE guild_id = ? ORDER BY due_at`,
      ),
      userReminders: this.db.prepare(
        `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE guild_id = ? AND creator_id = ? ORDER BY due_at`,
      ),
      rescheduleReminder: this.db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?'),
      deleteReminder: this.db.prepare('DELETE FROM reminders WHERE id = ?'),
      getLevel: this.db.prepare(
        'SELECT xp, messages, last_xp_at AS lastXpAt FROM levels WHERE guild_id = ? AND user_id = ?',
      ),
      addXp: this.db.prepare(`
        INSERT INTO levels (guild_id, user_id, xp, messages, last_xp_at) VALUES (@guildId, @userId, MAX(0, @xp), @messages, @at)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET
          xp = MAX(0, xp + @xp),
          messages = messages + @messages,
          last_xp_at = MAX(last_xp_at, @at)
      `),
      rankOf: this.db.prepare('SELECT COUNT(*) + 1 AS rank FROM levels WHERE guild_id = ? AND xp > ?'),
      leaderboard: this.db.prepare(`
        SELECT user_id AS userId, xp, messages FROM levels
        WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?
      `),
      rankedCount: this.db.prepare('SELECT COUNT(*) AS count FROM levels WHERE guild_id = ? AND xp > 0'),
      usersWithXp: this.db.prepare('SELECT user_id AS userId, xp FROM levels WHERE guild_id = ? AND xp >= ?'),
      setReward: this.db.prepare('INSERT OR REPLACE INTO level_rewards (guild_id, role_id, level) VALUES (?, ?, ?)'),
      deleteReward: this.db.prepare('DELETE FROM level_rewards WHERE guild_id = ? AND role_id = ?'),
      rewards: this.db.prepare(
        'SELECT role_id AS roleId, level FROM level_rewards WHERE guild_id = ? ORDER BY level, role_id',
      ),
    };
  }

  /**
   * Before servers were tracked separately, counts lived in daily_user_messages
   * and reports in reports, with no server id. Move them into the per-server
   * tables under the placeholder server '' until claimLegacyStats() learns
   * which server they belong to.
   */
  migrateSingleServerTables() {
    const exists = (name) =>
      Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const tx = this.db.transaction(() => {
      if (exists('daily_user_messages')) {
        this.db.exec(`
          INSERT INTO guild_messages (guild_id, day, user_id, count)
          SELECT '', day, user_id, count FROM daily_user_messages WHERE true
          ON CONFLICT (guild_id, day, user_id) DO UPDATE SET count = count + excluded.count;
          DROP TABLE daily_user_messages;
        `);
      }
      if (exists('reports')) {
        this.db.exec(`
          INSERT OR IGNORE INTO guild_reports (guild_id, day, posted_at) SELECT '', day, posted_at FROM reports;
          DROP TABLE reports;
        `);
      }
      this.db.exec("UPDATE meta SET key = 'tracking_since:' WHERE key = 'tracking_since'");
    });
    tx();
  }

  /** Is there pre-multi-server data waiting to be assigned to a server? */
  hasLegacyStats() {
    return Boolean(
      this.db.prepare("SELECT 1 FROM guild_messages WHERE guild_id = '' LIMIT 1").get() ||
        this.db.prepare("SELECT 1 FROM guild_reports WHERE guild_id = '' LIMIT 1").get() ||
        this.getMeta('tracking_since:'),
    );
  }

  /** Assign pre-multi-server data to `guildId` (the server the bot was set up for). */
  claimLegacyStats(guildId) {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO guild_messages (guild_id, day, user_id, count)
          SELECT ?, day, user_id, count FROM guild_messages WHERE guild_id = ''
          ON CONFLICT (guild_id, day, user_id) DO UPDATE SET count = count + excluded.count
        `)
        .run(guildId);
      this.db.prepare("DELETE FROM guild_messages WHERE guild_id = ''").run();
      this.db
        .prepare("INSERT OR IGNORE INTO guild_reports (guild_id, day, posted_at) SELECT ?, day, posted_at FROM guild_reports WHERE guild_id = ''")
        .run(guildId);
      this.db.prepare("DELETE FROM guild_reports WHERE guild_id = ''").run();
      const legacySince = this.getMeta('tracking_since:');
      if (legacySince) {
        this.setTrackingSince(guildId, legacySince);
        this.deleteMeta('tracking_since:');
      }
    });
    tx();
  }

  /** Record `count` messages from `userId` in a server on `day`. */
  recordMessage(guildId, day, userId, count = 1) {
    this.stmts.increment.run(guildId, day, userId, count);
  }

  /** Replace a server's data for a day with the given { userId: count } map. */
  replaceDay(guildId, day, countsByUser) {
    const tx = this.db.transaction(() => {
      this.stmts.clearDay.run(guildId, day);
      for (const [userId, count] of Object.entries(countsByUser)) {
        this.stmts.increment.run(guildId, day, userId, count);
      }
    });
    tx();
  }

  /** All messages ever recorded for a user in a server. */
  getUserMessageCount(guildId, userId) {
    return this.stmts.userTotal.get(guildId, userId).count;
  }

  /** Number of users whose first recorded message in the server was on `day`. */
  getFirstTimeSenders(guildId, day) {
    return this.stmts.firstTimeSenders.get(guildId, day).count;
  }

  /** Record a member joining or leaving. `kind` is 'join' or 'leave'. */
  recordMemberEvent(guildId, day, userId, kind, ts = Date.now()) {
    this.stmts.addMemberEvent.run(day, guildId, userId, kind, ts);
  }

  /** { joins, leaves } for a server on a single day. */
  getMemberEvents(guildId, day) {
    return this.stmts.memberEventCounts.get(guildId, day);
  }

  /** Replace a server's recorded joins for a day (used by backfill from member join dates). */
  replaceJoins(guildId, day, joins) {
    const tx = this.db.transaction(() => {
      this.stmts.clearJoinsForDay.run(guildId, day);
      for (const { userId, ts } of joins) {
        this.stmts.addMemberEvent.run(day, guildId, userId, 'join', ts);
      }
    });
    tx();
  }

  /** { messages, uniqueSenders } for a server on a single day (zeros if nothing recorded). */
  getDay(guildId, day) {
    return this.stmts.dayTotals.get(guildId, day);
  }

  /** Array of { day, messages, uniqueSenders } for days in [from, to] that have data. */
  getRange(guildId, from, to) {
    return this.stmts.rangeTotals.all(guildId, from, to);
  }

  /** Earliest day with any data for a server, or null. */
  getFirstDay(guildId) {
    return this.stmts.firstDay.get(guildId).day ?? null;
  }

  /** Day tracking began for a server, as recorded by the bot (may be null). */
  getTrackingSince(guildId) {
    return this.getMeta(`tracking_since:${guildId}`);
  }

  /** Move a server's tracking start back to `day` (never forward). */
  setTrackingSince(guildId, day) {
    const existing = this.getTrackingSince(guildId);
    if (!existing || existing > day) this.setMeta(`tracking_since:${guildId}`, day);
  }

  setTrackingSinceIfUnset(guildId, day) {
    if (!this.getTrackingSince(guildId)) this.setMeta(`tracking_since:${guildId}`, day);
  }

  markReported(guildId, day, postedAt = new Date()) {
    this.stmts.markReported.run(guildId, day, postedAt.toISOString());
  }

  wasReported(guildId, day) {
    return Boolean(this.stmts.wasReported.get(guildId, day));
  }

  /** Daily report settings for a server: { guildId, channelId, time: 'HH:MM' } or null. */
  getStatsSettings(guildId) {
    return this.stmts.getStatsSettings.get(guildId) ?? null;
  }

  getAllStatsSettings() {
    return this.stmts.allStatsSettings.all();
  }

  setStatsSettings(guildId, channelId, time) {
    this.stmts.setStatsSettings.run(guildId, channelId, time);
  }

  clearStatsSettings(guildId) {
    this.stmts.clearStatsSettings.run(guildId);
  }

  getMeta(key) {
    return this.stmts.getMeta.get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.stmts.setMeta.run(key, value);
  }

  deleteMeta(key) {
    this.stmts.deleteMeta.run(key);
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

  // ----- /remind reminders -----

  /** Save a reminder and return its id. `pings` is { users, roles, everyone }. */
  addReminder({ guildId, channelId, creatorId, message, pings, dueAt, repeat = null, createdAt = Date.now() }) {
    const info = this.stmts.addReminder.run({
      guildId,
      channelId,
      creatorId,
      message,
      pings: JSON.stringify(pings),
      dueAt,
      repeat,
      createdAt,
    });
    return Number(info.lastInsertRowid);
  }

  getReminder(id) {
    const row = this.stmts.getReminder.get(id);
    return row ? toReminder(row) : null;
  }

  getAllReminders() {
    return this.stmts.allReminders.all().map(toReminder);
  }

  /** Pending reminders in a guild, soonest first; only `creatorId`'s if given. */
  listReminders(guildId, creatorId = null) {
    const rows = creatorId
      ? this.stmts.userReminders.all(guildId, creatorId)
      : this.stmts.guildReminders.all(guildId);
    return rows.map(toReminder);
  }

  rescheduleReminder(id, dueAt) {
    this.stmts.rescheduleReminder.run(dueAt, id);
  }

  deleteReminder(id) {
    return this.stmts.deleteReminder.run(id).changes > 0;
  }

  // ----- Levels -----

  /** { xp, messages, lastXpAt } for a member (zeros if they have none). */
  getLevel(guildId, userId) {
    return this.stmts.getLevel.get(guildId, userId) ?? { xp: 0, messages: 0, lastXpAt: 0 };
  }

  /**
   * Add `xp` (may be negative; the total never drops below 0). `messages` is
   * how many XP-earning messages this adds. Returns the new total.
   */
  addXp(guildId, userId, xp, { messages = 0, at = 0 } = {}) {
    this.stmts.addXp.run({ guildId, userId, xp, messages, at });
    return this.getLevel(guildId, userId).xp;
  }

  /** 1-based leaderboard position for a member with `xp`. */
  getRank(guildId, xp) {
    return this.stmts.rankOf.get(guildId, xp).rank;
  }

  /** A page of [{ userId, xp, messages }], most XP first. */
  getLeaderboard(guildId, limit = 10, offset = 0) {
    return this.stmts.leaderboard.all(guildId, limit, offset);
  }

  getRankedCount(guildId) {
    return this.stmts.rankedCount.get(guildId).count;
  }

  /** Members with at least `minXp`. */
  getUsersWithXp(guildId, minXp) {
    return this.stmts.usersWithXp.all(guildId, minXp);
  }

  setLevelReward(guildId, roleId, level) {
    this.stmts.setReward.run(guildId, roleId, level);
  }

  deleteLevelReward(guildId, roleId) {
    return this.stmts.deleteReward.run(guildId, roleId).changes > 0;
  }

  /** [{ roleId, level }], lowest level first. */
  getLevelRewards(guildId) {
    return this.stmts.rewards.all(guildId);
  }

  close() {
    this.db.close();
  }
}
