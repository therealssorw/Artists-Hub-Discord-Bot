# Artists Hub Discord Bot

A small Discord bot that tracks server activity and posts a daily stats report.

Every day at **12:00 AM America/New_York** (Eastern time, DST-aware) it posts to the
configured stats channel:

- **Messages** sent that day
- **Unique senders** that day
- **Joined** and **left**: member count changes that day
- **Started chatting**: members who sent their first ever message that day
- The **30-day average** of both
- **Growth** of those averages compared with the previous 30 days

The same report is available on demand with **`/stats`** (today so far, or yesterday).

It also sends **Disboard bump reminders**: two hours after someone runs Disboard's `/bump`
successfully, the bot pings a role of your choice in the same channel so the server gets
bumped again as soon as the cooldown ends.

- `/bumpreminder set role:@Role` – choose the role to ping (needs Manage Server)
- `/bumpreminder status` – show the role and when the next reminder is due
- `/bumpreminder disable` – turn reminders off

Pending reminders are saved to the database, so a restart does not lose them.

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
   channel. Under **Bot → Privileged Gateway Intents**, turn on both **Server Members**
   (needed to count joins and leaves) and **Message Content** (lets the bot read Disboard's
   "Bump done!" reply and ignore failed bumps). Without them the bot still runs, but joins and
   leaves stay at zero and it reminds after every `/bump` attempt, including rejected ones.

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
bot messages, and overwrites the stored counts for those days. It also records joins from each
current member's join date (members who already left cannot be recovered; leaves are only
tracked live). It is safe to run again later.

## How it works

- `src/index.js` – Discord client, slash commands, and the midnight cron job.
- `src/bump.js` – Disboard bump detection, the `/bumpreminder` command, and reminder timers.
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

## Deploying to a Linux VM (Oracle Cloud, etc.)

SSH into the server and run:

```sh
curl -fsSL https://raw.githubusercontent.com/therealssorw/Artists-Hub-Discord-Bot/claude/daily-bot-stats-message-dlozpl/deploy/setup.sh | bash -s -- YOUR_DISCORD_TOKEN
```

This installs Node.js 20, clones the repo into `~/artists-hub-bot`, backfills 60 days of
history, and runs the bot as the `artists-hub-bot` systemd service (auto-start on boot,
restart on crash). Re-run the same command to update to the latest code.

```sh
journalctl -u artists-hub-bot -f        # live logs
sudo systemctl restart artists-hub-bot  # restart
```
