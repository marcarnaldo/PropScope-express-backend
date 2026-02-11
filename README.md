# NBA Player Props Odds Scraper

A backend service that scrapes and compares NBA player prop odds from **Sports Interaction (SIA)** and **FanDuel** to identify pricing discrepancies between sportsbooks. Removes the vig (juice) from both books to calculate true implied probabilities.

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

- **Hourly (6AM–11PM)** — Fetches today's fixtures from SIA and saves them to the database.
- **2 hours before each game** — Starts scraping odds every 5 minutes.
- **At game time** — Stops scraping and marks the fixture as closed.

This saves API credits (The Odds API charges per request) and avoids unnecessary load when there are no games.

### Vig Removal Math

Sportsbooks build in a margin (vig) so implied probabilities sum to more than 100%. For example, -110/-110 implies 52.38% each side = 104.76% total.

The power method finds exponent *k* such that:

```
implied_over^k + implied_under^k = 1
```

This gives the true probability each book assigns to over/under, enabling fair comparison.

## Supported Markets

| Market Type                       | Example Bet                          |
| --------------------------------- | ------------------------------------ |
| Points                            | Jason Tatum **Over 25.5 Points**     |
| Rebounds                          | Jason Tatum **Over 8.5 Rebounds**    |
| Assists                           | Jason Tatum **Over 5.5 Assists**     |
| Three-Pointers Made               | Jason Tatum **Over 2.5 Threes Made** |
| Points + Rebounds + Assists (PRA) | Jason Tatum **Over 39.5 PRA**        |
| Points + Assists (PA)             | Jason Tatum **Over 31.5 PA**         |
| Points + Rebounds (PR)            | Jason Tatum **Over 34.5 PR**         |
| Rebounds + Assists (RA)           | Jason Tatum **Over 14.5 RA**         |


## Tech Stack

- **Runtime** — Node.js with TypeScript
- **Web Scraping** — Puppeteer with Stealth Plugin (bypasses Cloudflare)
- **Database** — PostgreSQL
- **Scheduling** — node-schedule (date-specific jobs) + node-cron (hourly recurring)
- **Logging** — Pino (structured JSON logging)
- **External API** — The Odds API (FanDuel data)

## Project Structure

```
src/
├── api/
│   ├── siaApi.ts              # SIA scraper (headless browser)
│   └── oddsApi.ts             # FanDuel via The Odds API
├── config/
│   ├── interfaces.ts          # TypeScript interfaces
│   ├── siaConstants.ts        # SIA URLs and market patterns
│   └── oddsapiConstants.ts    # Odds API config and markets
├── db/
│   ├── database.ts            # PostgreSQL singleton connection pool
│   ├── schemas.ts             # Table and index creation
│   └── nbaRepositories.ts     # All SQL queries (fixtures + odds)
├── services/
│   ├── scheduler.ts           # Job scheduling and scraping lifecycle
│   ├── oddsAggregator.ts      # Merge, filter, and normalize odds
│   └── browser.ts             # Puppeteer browser manager with auto-recovery
├── utils/
│   └── errorHandling.ts       # Logger and error utilities
└── index.ts                   # Express server entry point
```

## API Endpoints

### `GET /nba/games`

Returns today's NBA fixtures.

```json
[
  {
    "fixtureId": 12345,
    "homeTeam": "Boston Celtics",
    "awayTeam": "Miami Heat",
    "startDate": "2025-02-10T00:00:00Z",
    "status": "open"
  }
]
```

### `GET /nba/odds/:fixtureId/history`

Returns all odds snapshots for a fixture in chronological order. Useful for tracking line movement.

```json
[
  {
    "fixtureId": 12345,
    "oddsData": {
      "homeTeam": "Boston Celtics",
      "awayTeam": "Miami Heat",
      "props": {
        "J. Tatum": {
          "points": {
            "line": 25.5,
            "siaOdds": { "over": -110, "under": -110 },
            "fdOdds": { "over": -115, "under": -105 },
            "siaOddsNoVig": { "over": 0.5, "under": 0.5 },
            "fdOddsNoVig": { "over": 0.525, "under": 0.475 }
          }
        }
      }
    },
    "snapshotTime": "2025-02-10T17:30:00Z"
  }
]
```

### `GET /health`

Health check for the server, database, and browser.

```json
{
  "status": "healthy",
  "database": "connected",
  "browser": "alive",
  "uptime": 3600
}
```

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL
- Chromium (installed automatically by Puppeteer)

### Environment Variables

Create a `.env` file:

```env
PORT=3000
LOG_LEVEL=info

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_USER=your_user
DB_PASSWORD=your_password
DB_NAME=odds_db

# The Odds API (https://the-odds-api.com)
ODDS_API_KEY=your_api_key
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

The server will automatically create the database tables on startup, fetch today's fixtures, and begin scheduling scrapers.

## Database Schema

### `nba_fixtures`

Stores today's games and their metadata.

| Column     | Type         | Description                                     |
| ---------- | ------------ | ----------------------------------------------- |
| fixture_id | INTEGER (PK) | Unique fixture ID from Sports Interaction (SIA) |
| home_team  | VARCHAR(100) | Home team name                                  |
| away_team  | VARCHAR(100) | Away team name                                  |
| start_date | TIMESTAMPTZ  | Scheduled game start time                       |
| status     | VARCHAR(20)  | Fixture status (`open` or `closed`)             |
| raw_data   | JSONB        | Full raw fixture payload from SIA API           |


### `nba_odds_snapshots`

Point-in-time snapshots of normalized odds for each fixture.

| Column        | Type         | Description                                   |
| ------------- | ------------ | --------------------------------------------- |
| fixture_id    | INTEGER (FK) | References `sia_fixtures.fixture_id`          |
| odds_data     | JSONB        | Normalized odds data with vig removed         |
| snapshot_time | TIMESTAMPTZ  | Timestamp when the odds snapshot was recorded |


## Error Handling

Every external call (SIA scraping, Odds API, database) uses retry logic with exponential backoff (3 attempts). The browser manager automatically detects when Puppeteer becomes unresponsive and relaunches it. Structured logging via Pino makes it easy to trace failures in production.