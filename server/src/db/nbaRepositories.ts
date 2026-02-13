/**
 * NBA Repositories
 *
 * Database access layer for NBA fixtures and odds snapshots.
 * All SQL queries for reading/writing fixture and odds data live here.
 */

import {
  Fixture,
  OddsSnapshot,
} from "../config/types.ts";
import { Database } from "./database.ts";

export const upsertFixture = async (
  db: Database,
  fixtureId: number,
  fixtureData: any,
  startDate: string,
  sport: string,
) => {
  const awayTeam = fixtureData.participants[0].name.value;
  const homeTeam = fixtureData.participants[1].name.value;

  await db.query(
    /* SQL */ `
        INSERT INTO fixtures (fixture_id, sport, home_team, away_team, start_date, raw_data)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (fixture_id)
        DO UPDATE SET home_team = $3, away_team = $4, start_date = $5, raw_data = $6`,
    [fixtureId, sport, homeTeam, awayTeam, startDate, JSON.stringify(fixtureData)],
  );
};

export const updateFixtureStatus = async (
  db: Database,
  fixtureId: number,
  status: string,
) => {
  await db.query(
    /* SQL */ `
    UPDATE fixtures SET status = $2 WHERE fixture_id = $1`,
    [fixtureId, status],
  );
};

export const insertOddsSnapshot = async (
  db: Database,
  fixtureId: number,
  oddsData: any,
) => {
  await db.query(
    /* SQL */ `
    INSERT INTO odds_snapshots (fixture_id, odds_data)
    VALUES ($1, $2)`,
    [fixtureId, JSON.stringify(oddsData)],
  );
};

export const getFixturesFromDb = async (
  db: Database,
  sport: string,
): Promise<Fixture[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT fixture_id, home_team, away_team, start_date, status
    FROM fixtures
    WHERE sport = $1 AND start_date::date = CURRENT_DATE
    `,
    [sport],
  );
  return result.rows.map((row) => ({
    fixtureId: row.fixture_id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    startDate: row.start_date,
    status: row.status,
  }));
};

export const getScrapableFixtures = async (
  db: Database,
  sport: string,
): Promise<any[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT fixture_id, home_team, away_team, start_date, status, raw_data
    FROM fixtures
    WHERE sport = $1
    AND start_date::date = CURRENT_DATE
    AND status = 'open'
    `,
    [sport],
  );

  return result.rows;
};

export const getLatestNormalizedOdds = async (
  db: Database,
  sport: string,
): Promise<OddsSnapshot[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT DISTINCT ON (s.fixture_id)
      s.fixture_id, s.odds_data, s.snapshot_time
    FROM odds_snapshots s
    JOIN fixtures f ON s.fixture_id = f.fixture_id
    WHERE f.sport = $1
    ORDER BY s.fixture_id, s.snapshot_time DESC
    `,
    [sport],
  );

  return result.rows.map((row) => ({
    fixtureId: row.fixture_id,
    oddsData: JSON.parse(row.odds_data),
    snapshotTime: row.snapshot_time,
  }));
};

export const getOddsHistory = async (
  db: Database,
  fixtureId: number,
): Promise<OddsSnapshot[]> => {
  const result = await db.query(
    /* SQL */
    `
    SELECT fixture_id, odds_data, snapshot_time
    FROM odds_snapshots
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

export const markStartedFixtures = async (db: Database, sport: string) => {
  await db.query(
    /* SQL */
    `UPDATE fixtures 
     SET status = 'close' 
     WHERE sport = $1 AND start_date <= NOW() AND status = 'open'`,
    [sport],
  );
};