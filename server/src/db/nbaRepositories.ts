import { OddsSnapshot } from "../config/interfaces";
import { Database } from "./database";

export const upsertFixture = async (
  db: Database,
  fixtureId: number,
  fixtureData: any,
  startDate: string,
) => {
  await db.query(
    /* SQL */ `
        INSERT INTO nba_fixtures (fixture_id, fixture_data, start_date)
        VALUES ($1, $2, $3)
        ON CONFLICT (fixture_id)
        DO UPDATE SET fixture_data = $2, start_date = $3`,
    [fixtureId, JSON.stringify(fixtureData), startDate],
  );
};

export const upsertOdds = async (
  db: Database,
  fixtureId: number,
  oddsData: any,
) => {
  await db.query(
    /* SQL */ `
        INSERT INTO nba_odds_snapshots (fixture_id, odds_data, last_updated)
        VALUES ($1, $2, NOW())
        ON CONFLICT (fixture_id)
        DO UPDATE SET odds_data = $2, last_updated = NOW()`,
    [fixtureId, JSON.stringify(oddsData)],
  );
};

export const getNbaFixturesFromDb = async (
  db: Database,
  date: string,
): Promise<any[]> => {
  const result = await db.query(
    /* SQL */ `
        SELECT * FROM nba_fixtures
        WHERE DATE(start_date) = $1`,
    [date],
  );
  return result.rows;
};

export const getNbaNormalizedOdds = async (
  db: Database,
): Promise<OddsSnapshot[]> => {
  const result = await db.query(/* SQL */ `SELECT * FROM nba_odds_snapshots`);
  
  return result.rows.map((row) => ({
    fixtureId: row.fixture_id,
    oddsData: JSON.parse(row.odds_data),
    lastUpdated: row.last_updated,
  }));
};
