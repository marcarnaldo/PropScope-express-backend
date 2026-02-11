/**
 * NBA Repositories
 *
 * Database access layer for NBA fixtures and odds snapshots.
 * All SQL queries for reading/writing fixture and odds data live here.
 */

import {
  Fixture,
  FixtureRow,
  NormalizedOdds,
  OddsSnapshot,
  SiaFixture,
} from "../config/types.ts";
import { Database } from "./database.ts";

/** Inserts a new fixture or updates an existing one if the fixture_id already exists. */
export const upsertFixture = async (
  db: Database,
  fixtureId: number,
  fixtureData: SiaFixture,
  startDate: string,
): Promise<void> => {
  const awayTeam = fixtureData.participants[0].name.value;
  const homeTeam = fixtureData.participants[1].name.value;

  await db.query(
    /* SQL */ `
        INSERT INTO nba_fixtures (fixture_id, home_team, away_team, start_date, raw_data)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (fixture_id)
        DO UPDATE SET home_team = $2, away_team = $3, start_date = $4, raw_data = $5`,
    [fixtureId, homeTeam, awayTeam, startDate, JSON.stringify(fixtureData)],
  );
};

/** Updates the status of a fixture (e.g. "open" -> "close"). */
export const updateFixtureStatus = async (
  db: Database,
  fixtureId: number,
  status: string,
): Promise<void> => {
  await db.query(
    /* SQL */ `
    UPDATE nba_fixtures SET status = $2 WHERE fixture_id = $1`,
    [fixtureId, status],
  );
};

/** Inserts a point-in-time snapshot of normalized odds for a fixture. */
export const insertOddsSnapshot = async (
  db: Database,
  fixtureId: number,
  oddsData: NormalizedOdds,
): Promise<void> => {
  await db.query(
    /* SQL */ `
    INSERT INTO nba_odds_snapshots (fixture_id, odds_data)
    VALUES ($1, $2)`,
    [fixtureId, JSON.stringify(oddsData)],
  );
};

/** Returns all fixtures scheduled for today. */
export const getNbaFixturesFromDb = async (
  db: Database,
): Promise<Fixture[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT fixture_id, home_team, away_team, start_date, status
    FROM nba_fixtures
    WHERE start_date::date = CURRENT_DATE
    `,
  );
  return result.rows.map((row) => ({
    fixtureId: row.fixture_id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    startDate: row.start_date,
    status: row.status,
  }));
};

/** Returns all open fixtures for today that are eligible for scraping. */
export const getScrapableFixtures = async (db: Database): Promise<FixtureRow[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT fixture_id, home_team, away_team, start_date, status, raw_data
    FROM nba_fixtures
    WHERE start_date::date = CURRENT_DATE
    AND status =  'open'
    `,
  );

  return result.rows;
};

/** Returns the most recent odds snapshot for each fixture. */
export const getLatestNbaNormalizedOdds = async (
  db: Database,
): Promise<OddsSnapshot[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT DISTINCT ON (fixture_id)
      fixture_id, odds_data, snapshot_time
    FROM nba_odds_snapshots
    ORDER BY fixture_id, snapshot_time DESC
    `,
  );

  return result.rows.map((row) => ({
    fixtureId: row.fixture_id,
    oddsData: JSON.parse(row.odds_data),
    snapshotTime: row.snapshot_time,
  }));
};

/** Returns all odds snapshots for a fixture in chronological order, for tracking line movement. */
export const getOddsHistory = async (
  db: Database,
  fixtureId: number,
): Promise<OddsSnapshot[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT fixture_id, odds_data, snapshot_time
    FROM nba_odds_snapshots
    WHERE fixture_id = $1
    ORDER BY snapshot_time ASC`,
    [fixtureId],
  );

  return result.rows.map((row) => ({
    fixtureId: row.fixture_id,
    oddsData: JSON.parse(row.odds_data),
    snapshotTime: row.snapshot_time,
  }));
};

/** Marks all fixtures whose start time has passed as close. Safety net for missed game starts. */
export const markStartedFixtures = async (db: Database): Promise<void> => {
  await db.query(
    /* SQL */
    `UPDATE nba_fixtures 
     SET status = 'close' 
     WHERE start_date <= NOW() AND status = 'open'`
  );
};