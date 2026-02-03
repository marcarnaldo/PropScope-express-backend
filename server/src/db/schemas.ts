import { Database } from "./database.ts";

export const initNbaSchema = async (db: Database) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS nba_fixtures (
      fixture_id INTEGER PRIMARY KEY,
      fixture_data JSONB NOT NULL,
      start_date TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS nba_odds_snapshots (
      fixture_id INTEGER PRIMARY KEY,
      odds_data JSONB NOT NULL,
      last_updated TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (fixture_id) REFERENCES nba_fixtures(fixture_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_fixture_start_date 
    ON nba_fixtures(start_date)
  `);

  console.log('Database schema initialized');
};