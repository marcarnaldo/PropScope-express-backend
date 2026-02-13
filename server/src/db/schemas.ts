/**
 * Database Schema Initialization
 *
 * Creates the required tables and indexes for storing NBA fixtures
 * and odds snapshots. Uses IF NOT EXISTS so it's safe to run on every startup.
 */

import { Database } from "./database.ts";
import { logger } from "../utils/errorHandling.ts";

export const initNbaSchema = async (db: Database): Promise<void> => {
  await db.query(/* SQL */ `
    CREATE TABLE IF NOT EXISTS fixtures (
      fixture_id INTEGER PRIMARY KEY,
      sport VARCHAR(20) NOT NULL,
      home_team VARCHAR(100) NOT NULL,
      away_team VARCHAR(100) NOT NULL,
      start_date TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      raw_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(/* SQL */ `
    CREATE TABLE IF NOT EXISTS odds_snapshots (
      fixture_id INTEGER NOT NULL,
      odds_data JSONB NOT NULL,
      snapshot_time TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (fixture_id, snapshot_time),
      FOREIGN KEY (fixture_id) REFERENCES fixtures(fixture_id)
    )
  `);

  await db.query(/* SQL */ `
    CREATE INDEX IF NOT EXISTS idx_fixture_sport_start_date 
    ON fixtures(sport, start_date)
  `);

  await db.query(/* SQL */ `
    CREATE INDEX IF NOT EXISTS idx_odds_fixture_time 
    ON odds_snapshots(fixture_id, snapshot_time)
  `);

  await db.query(/* SQL */ `
    CREATE INDEX IF NOT EXISTS idx_sport 
    ON odds_snapshots(fixture_id, snapshot_time)
  `);

  logger.info("Database schema initialized");
};
