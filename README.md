# NBA Player Props Odds Scraper

A backend service that scrapes and compares NBA player prop odds from **Sports Interaction (SIA)** and **FanDuel** to find pricing discrepancies between sportsbooks. Removes the vig (juice) from both books to calculate true implied probabilities.

## How It Works

The system compares odds from two sportsbooks:

- **FanDuel** — the "anchor" book, treated as the sharp reference for true odds. Fetched via [The Odds API](https://the-odds-api.com).
- **Sports Interaction (SIA)** — the "target" book where mispriced lines are identified. Scraped via headless browser (Puppeteer) since SIA requires browser cookies to access their internal API.

### Pipeline

```
SIA Odds ──┐
            ├──► Aggregate ──► Filter Same Lines ──► Remove Vig ──► Save to DB
FanDuel ───┘
```

1. **Aggregate** — Merges player props from both books. Only players found in both are kept.
2. **Filter** — Drops props where the lines differ (e.g. SIA has 25.5 but FD has 26.5). Comparing odds is only meaningful when the line is identical.
3. **Remove Vig** — Uses the power method (binary search for exponent *k* where `P(over)^k + P(under)^k ≈ 1`) to calculate fair no-vig probabilities for both books.
4. **Save** — Snapshots are stored in PostgreSQL with timestamps for tracking line movement over time.

### Scheduling

The scraper doesn't run 24/7. It uses a smart scheduling approach:

- **On startup** — Immediately fetches today's fixtures from SIA and saves them to the database. This handles recovery after any downtime.
- **Daily at 6AM** — Fetches fixtures again via cron to pick up any schedule changes.
- **1 hour before each game** — Starts scraping odds every 5 minutes. If the 1-hour window is already active at startup, scraping begins immediately.
- **At game time** — Stops scraping and marks the fixture as closed.

The browser is only launched when there are active fixtures to scrape and is closed when no fixtures remain, saving resources.

### Real-Time Updates

Connected clients receive live updates via Server-Sent Events (SSE). After each scrape cycle, a single batched event is sent with all fixture IDs that were successfully updated.

### Vig Removal Math

Sportsbooks build in a margin (vig) so implied probabilities sum to more than 100%. For example, -110/-110 implies 52.38% each side = 104.76% total.

The power method finds exponent *k* such that:

```
implied_over^k + implied_under^k = 1
```

This gives the true probability each book assigns to over/under, enabling fair comparison.

## Supported Markets

| Market                      | Example                    |
| --------------------------- | -------------------------- |
| Points                      | J. Tatum Over 25.5 Points  |
| Rebounds                    | J. Tatum Over 8.5 Rebounds |
| Assists                     | J. Tatum Over 5.5 Assists  |
| Three-Pointers Made         | J. Tatum Over 2.5 3PM      |
| Points + Rebounds + Assists | J. Tatum Over 39.5 PRA     |
| Points + Assists            | J. Tatum Over 31.5 PA      |
| Points + Rebounds           | J. Tatum Over 34.5 PR      |
| Rebounds + Assists          | J. Tatum Over 14.5 RA      |


## Tech Stack

- **Runtime** — Node.js with JavaScript
- **Web Scraping** — Puppeteer with Stealth Plugin (bypasses Cloudflare)
- **Database** — PostgreSQL (singleton connection pool via `pg`)
- **Scheduling** — node-schedule (one-time date jobs) + node-cron (daily recurring)
- **Real-Time** — Server-Sent Events (SSE)
- **Logging** — Pino (structured JSON)
- **External API** — [The Odds API](https://the-odds-api.com) (FanDuel data)
- **Proxy** — proxy-chain + iProyal residential proxies

## Project Structure

```
src/
├── api/
│   ├── siaApi.ts              # SIA scraper (headless browser)
│   └── oddsApi.ts             # FanDuel via The Odds API
├── config/
│   ├── types.ts               # TypeScript interfaces and constants
│   ├── siaConstants.ts        # SIA URLs and market patterns
│   └── oddsapiConstants.ts    # Odds API config and markets
├── db/
│   ├── database.ts            # PostgreSQL singleton connection pool
│   ├── schemas.ts             # Table and index creation
│   └── nbaRepositories.ts     # All SQL queries (fixtures + odds)
├── services/
│   ├── scheduler.ts           # Job scheduling and scraping lifecycle
│   ├── oddsAggregator.ts      # Merge, filter, and normalize odds
│   ├── browser.ts             # Puppeteer browser manager with page pool and auto-recovery
│   └── sseManager.ts          # SSE client manager for real-time updates
├── utils/
│   └── errorHandling.ts       # Logger and error utilities
└── index.ts                   # Express server entry point
```

## API

### `GET /sse/odds`

SSE endpoint. Clients connect here to receive real-time odds update notifications.

**Events:**

- `connected` — Sent immediately on connection as a heartbeat.
- `odds-update` — Sent after each scrape cycle with the fixture IDs that were updated.

```json
event: odds-update
data: {"fixtureIds": [12345, 67890]}
```

## Database Schema

### `fixtures`

Stores today's games and their metadata.

| Column     | Type         | Description                       |
| ---------- | ------------ | --------------------------------- |
| fixture_id | INTEGER (PK) | Unique fixture ID from SIA        |
| sport      | VARCHAR(20)  | Sport identifier (e.g. `nba`)     |
| home_team  | VARCHAR(100) | Home team name                    |
| away_team  | VARCHAR(100) | Away team name                    |
| start_date | TIMESTAMPTZ  | Scheduled game start time         |
| status     | VARCHAR(20)  | `open` or `closed`                |
| raw_data   | JSONB        | Full raw fixture payload from SIA |
| created_at | TIMESTAMPTZ  | Row creation time                 |
| updated_at | TIMESTAMPTZ  | Row update time                   |


### `odds_snapshots`

Point-in-time snapshots of normalized odds for each fixture.

| Column        | Type                               | Description                      |
| ------------- | ---------------------------------- | -------------------------------- |
| fixture_id    | INTEGER (FK → fixtures.fixture_id) | References the related fixture   |
| snapshot_time | TIMESTAMPTZ                        | When the snapshot was recorded   |
| odds_data     | JSONB                              | Normalized odds with vig removed |


## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL
- Chromium (installed automatically by Puppeteer)

### Environment Variables

Create a `.env` file:

```env
LOG_LEVEL=info

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_USER=your_user
DB_PASSWORD=your_password
DB_NAME=oddsdb

# The Odds API (https://the-odds-api.com)
ODDS_API_KEY=your_api_key

# Residential Proxy (for SIA scraping)
PROXY_HOST=your_proxy_host
PROXY_PORT=your_proxy_port
PROXY_USERNAME=your_proxy_user
PROXY_PASSWORD=your_proxy_password
```

### Installation

```bash
npm install
```

### Running

```bash
# Development
npm run dev

# Production
npm start
```

The server automatically creates database tables on startup, fetches today's fixtures, and begins scheduling scrapers. It listens on port 3001.

## Error Handling

Every external call (SIA scraping, Odds API, database) uses retry logic with exponential backoff (up to 3 attempts). The browser manager maintains a pool of 3 reusable pages and checks browser health before each scrape cycle, automatically relaunching if Puppeteer becomes unresponsive. All logging is structured JSON via Pino.