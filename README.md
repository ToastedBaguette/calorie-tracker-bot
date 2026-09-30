# Calorie Tracker Bot

Personal Discord bot that estimates calories and nutrition from a **photo of your food** (or a
screenshot of a GoFood/GrabFood order, or a nutrition label) using **Gemini Vision**, and logs
every item to **Google Sheets**. Replies are in Bahasa Indonesia.

Sister project of [expense-tracker-bot](https://github.com/ToastedBaguette/expense-tracker-bot) —
same stack: Node.js, discord.js, `@google/genai`, Google Sheets API, Docker Compose.

## Features

| | |
|---|---|
| 📸 **Photo → nutrition** | Send one or more photos. Each food/drink is listed separately with portion, kcal, protein, carbs, fat, fiber, sugar, sodium. Add a caption to steer it: `setengah porsi, tanpa nasi`. |
| ⌨️ **Text logging** | `nasi padang rendang + es teh manis`, `sarapan 2 telur rebus`, `kemarin malam martabak 2 potong` |
| 🍳 **Meal tagging** | Sarapan / Makan Siang / Camilan / Makan Malam — from your words, otherwise from the time (Asia/Jakarta) and the food: nasi + ayam at 16:30 is a late Makan Siang, a kopi on its own is Camilan. |
| 🎯 **Daily target** | `target 2000 p120 k250 l60` → every reply shows what's left for today. |
| ↩️ **Undo & correct** | Every entry has a **Batalkan** button. Fix the latest entry with a follow-up message (`nasinya cuma 1`, `tambah kerupuk tadi`, `itu makan siang`) or reply to any entry to fix that one. |
| 📊 **Summaries** | `hari ini`, `kemarin`, `minggu ini` |

Estimates are AI guesses from a picture — good for trends, not lab-grade.

## Commands

| Message | What it does |
|---|---|
| *(photo, optional caption)* | Analyze and log |
| *(any food text)* | Analyze and log |
| *(follow-up within 3 h)* | `nasinya cuma 1`, `tambah kerupuk tadi` — corrects the latest entry; other food is logged as new |
| *(reply to an entry)* | Correct or delete that entry |
| `hari ini` / `today` | Today's totals, progress, items per meal |
| `kemarin` / `yesterday` | Yesterday's summary |
| `minggu ini` / `week` | Last 7 days, daily chart, averages |
| `target` | Show daily targets |
| `target 2000 p120 k250 l60` | Set kcal / protein / carbs / fat targets (`target p0` clears one) |
| `bantuan` / `help` | Usage guide |

## Google Sheet layout

The bot creates these tabs on first start — no template to import. Use a blank spreadsheet.

| Tab | Content |
|---|---|
| `Log` | One row per food item: ID, Tanggal, Jam, Waktu Makan, Makanan, Porsi, Kalori, Protein, Karbo, Lemak, Serat, Gula, Natrium, Sumber, Keyakinan. Rows of one meal share an ID (the Discord message ID). |
| `Target` | Daily targets (B2:B5), set with the `target` command or typed in directly. |
| `Harian` | Per-day totals, computed live from `Log` with a `QUERY` formula (rewritten by the bot on every start). |

You can edit or delete rows in `Log` by hand; summaries read the sheet every time.

## Setup

### 1. Discord bot

1. <https://discord.com/developers/applications> → **New Application** (e.g. "Calorie Bot").
2. **Bot** → **Reset Token** → copy it into `DISCORD_TOKEN`.
3. **Bot** → enable **MESSAGE CONTENT INTENT**.
4. **OAuth2 → URL Generator** → scope `bot`, permissions *View Channels, Send Messages, Embed Links,
   Read Message History* → open the URL and add the bot to your server.
5. Create a channel for it (e.g. `#kalori`). With Developer Mode on, right-click the channel → **Copy
   Channel ID** → `DISCORD_CHANNEL_ID`. Restricting the channel keeps it from answering in other
   bots' channels.
6. Optional: right-click yourself → **Copy User ID** → `DISCORD_AUTHORIZED_USERS`.

### 2. Google Sheets

1. Create a service account and download its JSON key as `service_account.json` in the repo root:
   ```bash
   gcloud iam service-accounts create calorie-tracker-bot --project=<PROJECT>
   gcloud iam service-accounts keys create service_account.json \
     --iam-account=calorie-tracker-bot@<PROJECT>.iam.gserviceaccount.com
   ```
   The Google Sheets API must be enabled in the project.
2. Create a blank spreadsheet (<https://sheets.new>), **Share** it with the service account's
   `client_email` as **Editor**, and put its URL or ID in `SPREADSHEET_ID`.

### 3. Gemini

Get an API key at <https://aistudio.google.com/> → `GEMINI_API_KEY`.

### 4. Configure

```bash
cp .env.example .env   # then fill it in
```

## Run

```bash
# Docker (how it runs in production)
docker compose up -d --build
docker compose logs -f

# Or directly with Node 20+
npm install
npm start

# Unit tests
npm test
```

Look for `🤖 Discord Calorie Bot online` and `📗 Spreadsheet ready` in the logs.

## Deployment

Runs 24/7 as one Docker Compose project at `/opt/calorie-tracker-bot` on a shared GCP e2-micro
VM, next to the expense bot. Only one copy may run at a time — stop the local one
(`docker compose down`) before starting it anywhere else, or every message gets answered twice.

```bash
# Deploy new code (push to GitHub first)
gcloud compute ssh rony@expense-bot --zone=us-central1-a \
  --command="cd /opt/calorie-tracker-bot && sudo git pull && sudo docker compose up -d --build"

# Logs
gcloud compute ssh rony@expense-bot --zone=us-central1-a \
  --command="cd /opt/calorie-tracker-bot && sudo docker compose logs -f --tail=50"
```

## Project structure

```
src/
  index.js      Discord client, message & button handlers
  gemini.js     Gemini prompts, JSON schemas, model fallback
  sheets.js     Google Sheets storage (tab setup, log, targets)
  nutrition.js  Pure helpers: time zone, meal inference, totals, target parsing
  embeds.js     Discord embeds (Indonesian)
test/           node:test unit tests (pure helpers, correction wording)
```

## License

MIT
