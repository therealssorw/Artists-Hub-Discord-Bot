# Artists Hub Discord Bot

A small Discord bot that tracks server activity and posts a daily stats report.

Every day at **12:00 AM America/New_York** (Eastern time, DST-aware) it posts to the
configured stats channel:

- **Messages** sent that day
- **Unique senders** that day
- The **30-day average** of both
- **Growth** of those averages compared with the previous 30 days

The same report is available on demand with **`/stats`** (today so far, or yesterday).

## Setup

1. Install Node.js 18.17 or newer.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`. The other values have
   sensible defaults (`STATS_CHANNEL_ID` already points at the stats channel).

   Never commit `.env`. If a token is ever pasted somewhere public, regenerate it in the
   Discord Developer Portal.

4. In the Discord Developer Portal, invite the bot with the `bot` and
   `applications.commands` scopes. It needs **View Channel** and **Read Message History**
   in the channels it should count, and **Send Messages** + **Embed Links** in the stats
   channel. The privileged *Message Content* intent is **not** required.

5. Start the bot:

   ```sh
   npm start
   ```

## Backfilling history

Averages and growth need 60 days of data to be fully meaningful. Instead of waiting, rebuild
the counts from channel history once after deploying:

```sh
npm run backfill          # last 60 days
npm run backfill -- 90    # or any number of days
```

The script scans every text/announcement channel and public thread the bot can read, ignoring
bot messages, and overwrites the stored counts for those days. It is safe to run again later.

## How it works

- `src/index.js` – Discord client, the `/stats` command, and the midnight cron job.
  If the bot was offline at midnight it posts the missed report on the next startup.
- `src/db.js` – SQLite store (`data/stats.db`) with one row per day and user.
- `src/stats.js` – computes the day totals, 30-day averages and growth.
- `src/report.js` – builds the Discord embed.
- `src/backfill.js` – one-off history import.

Averages only divide by days that were actually tracked, so a freshly deployed bot does not
average in weeks of empty days. Growth is the percentage change of the daily average over the
last 30 days versus the 30 days before that.

## Configuration

| Variable           | Default                 | Purpose                                                   |
| ------------------ | ----------------------- | --------------------------------------------------------- |
| `DISCORD_TOKEN`    | –                       | Bot token (required)                                      |
| `STATS_CHANNEL_ID` | `1548706786893238322`   | Channel that receives the daily report                    |
| `GUILD_ID`         | –                       | Register `/stats` and count messages only in this server  |
| `DATABASE_PATH`    | `./data/stats.db`       | SQLite file location                                      |
| `TIMEZONE`         | `America/New_York`      | Day boundaries and report time                            |

## Tests

```sh
npm test
```
