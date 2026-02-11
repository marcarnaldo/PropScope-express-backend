import { Database } from "./database.ts";
import { logger } from "../utils/errorHandling.ts";
export const initNbaSchema = async (db: Database) => {
  await db.query(/* SQL */`
    CREATE TABLE IF NOT EXISTS nba_fixtures (
      fixture_id INTEGER PRIMARY KEY,
      home_team VARCHAR(100) NOT NULL,
      away_team VARCHAR(100) NOT NULL,
      start_date TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'scheduled',
      raw_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(/* SQL */`
    CREATE TABLE IF NOT EXISTS nba_odds_snapshots (
      fixture_id INTEGER NOT NULL,
      odds_data JSONB NOT NULL,
      snapshot_time TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (fixture_id, snapshot_time),
      FOREIGN KEY (fixture_id) REFERENCES nba_fixtures(fixture_id)
    )
  `);

  await db.query(/* SQL */`
  CREATE INDEX IF NOT EXISTS idx_fixture_start_date 
  ON nba_fixtures(start_date)
`);

await db.query(/* SQL */`
  CREATE INDEX IF NOT EXISTS idx_odds_fixture_time 
  ON nba_odds_snapshots(fixture_id, snapshot_time)
`);
  
  logger.info('Database schema initialized');
};