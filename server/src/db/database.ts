import Database from "better-sqlite3";
import path from "path";
import { FixtureRow } from "../config/interfaces";

let db: Database.Database | null = null;

export const connectDb = () => {
  if (!db) {
    const dbPath = path.join(process.cwd(), "data", "odds.db");
    db = new Database(dbPath);

    initSchema(db);
    console.log("Connected to SQLite database.");
  }

  return db;
};

export const closeDb = () => {
  if (db) {
    db.close();
    db = null;
    console.log("Database connection closed.");
  }
};

const initSchema = (database: Database.Database) => {
  database.exec(/* SQL */ `
    CREATE TABLE IF NOT EXISTS nba_fixtures (
      fixture_id INTEGER PRIMARY KEY,
      fixture_data TEXT NOT NULL,
      start_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nba_odds_snapshots (
      fixture_id INTEGER PRIMARY KEY,
      odds_data TEXT NOT NULL,
      last_updated TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (fixture_id) REFERENCES nba_fixtures(fixture_id)
    );

    CREATE INDEX IF NOT EXISTS idx_fixture_start_date ON nba_fixtures(start_date);
  `);

  console.log("Database schema initialized.");
};

export const upsertFixture = (
  fixtureId: number,
  fixtureData: any,
  startDate: string,
) => {
  if (!db) throw new Error("Database not connected");

  // Insert the new fixture to db
  const statement = db.prepare(/* SQL */ `
    INSERT OR REPLACE INTO nba_fixtures (fixture_id, fixture_data, start_date) 
    VALUES (?, ?, ?)
    `);
  statement.run(fixtureId, JSON.stringify(fixtureData), startDate);
};

export const upsertOdds = (fixtureId: number, oddsData: any) => {
  if (!db) throw new Error("Database not connected");
  const statement = db.prepare(/* SQL */ `
      INSERT OR REPLACE INTO nba_odds_snapshots (fixture_id, odds_data, last_updated)
      VALUES (?, ?, datetime('now'))
    `);

  statement.run(fixtureId, JSON.stringify(oddsData));
};

export const getNbaFixturesFromDb = (date: string) => {
  if (!db) throw new Error("Database not connected");

  const statement = db.prepare(/* SQL */ `
    SELECT * FROM nba_fixtures 
    WHERE DATE(start_date) = ?
    `);
  return statement.all(date);
};
