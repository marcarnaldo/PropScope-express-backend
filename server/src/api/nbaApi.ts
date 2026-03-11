/**
 * NBA API Service
 *
 * Fetches player IDs and game logs from the NBA Stats API,
 * caching everything in Postgres to minimize API calls.
 *
 * - Player IDs: fetched once via commonallplayers, stored permanently
 * - Game logs: full season on first lookup, then daily increments
 * - Stat profiles: computed from DB rows for edge calculations
 */

import {
  NBA_STATS_HEADERS,
  PLAYER_GAME_LOG_URL,
  PLAYER_INFO,
} from "../config/nbaConstants";
import { Database } from "../db/database";
import { logger } from "../utils/errorHandling";
import {
  getPlayerIdFromDb,
  bulkInsertPlayers,
  getLatestGameLogDate,
  insertGameLogs,
  getPlayerGameLogs,
} from "../db/nbaRepositories";
import { proxiedFetch } from "../utils/proxyFetch";

function normalize(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Looks up a player's NBA ID from the DB.
 * On cache miss, fetches the full roster from the NBA API and bulk inserts all players.
 */
export const getPlayerId = async (
  db: Database,
  playerName: string,
): Promise<number | null> => {
  const normalizedName = normalize(playerName);

  // Check DB for playerID
  const playerId = await getPlayerIdFromDb(db, normalizedName);
  if (playerId) return playerId;

  logger.info("Player not found in DB, fetching full roster from NBA API");

  const res = await proxiedFetch(PLAYER_INFO, NBA_STATS_HEADERS);
  const json: any = await res.json();

  // Parse the NBA API response format
  const resultSet = json.resultSets[0];
  const headers: string[] = resultSet.headers;
  const row: any[][] = resultSet.rowSet;

  // Setup the columns
  const nameIndex = headers.indexOf("DISPLAY_FIRST_LAST");
  const idIndex = headers.indexOf("PERSON_ID");

  // Get the players and put them in rowSet with their PlayerName and PlayerID
  const players = row.map((row) => ({
    id: row[idIndex],
    name: normalize(row[nameIndex]),
  }));

  // Insert all in db
  await bulkInsertPlayers(db, players);
  logger.info({ playerCount: players.length }, "Bulk inserted players into DB");

  // Now look up the player we originally needed and return the ID
  return await getPlayerIdFromDb(db, normalizedName);
};

/**
 * Ensures the DB has up-to-date game logs for a player.
 * - No rows in DB → fetch full season log
 * - Latest game_date < today → fetch only new games since last entry
 * - Already current → do nothing
 */
const syncGameLogs = async (db: Database, playerId: number): Promise<void> => {
  // Get the last date this player played
  const lastDate = await getLatestGameLogDate(db, playerId);

  let dateFrom = "";

  if (!lastDate) {
    // If the player does not have a last date, it means they're not yet in db, so we fetch the full season to get their game records
    logger.info({ playerId }, "No game logs in DB, fetching full season");
  } else {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (lastDate >= today) return;

    // Create a new Date object from the last game date in DB (so we don't mutate the original)
    const nextDay = new Date(lastDate);
    // Move the date forward by 1 day so we only fetch games after the last one already in DB
    nextDay.setDate(nextDay.getDate() + 1);
    // Get the month as 2-digit string (getMonth() is 0-indexed, so +1). e.g. March → "03"
    const mm = String(nextDay.getMonth() + 1).padStart(2, "0");
    // Get the day as 2-digit string. e.g. 5 → "05"
    const dd = String(nextDay.getDate()).padStart(2, "0");
    // Get the full year. e.g. 2026
    const yyyy = nextDay.getFullYear();
    // Format as MM/DD/YYYY which is what the NBA API expects
    dateFrom = `${mm}/${dd}/${yyyy}`;

    logger.info({ playerId, dateFrom }, "Fetching incremental game logs");
  }

  // Fetch the full season games of a particular player
  const url = PLAYER_GAME_LOG_URL(playerId, dateFrom);
  const res = await proxiedFetch(url, NBA_STATS_HEADERS);
  const json: any = await res.json();

  // Parse the NBA API response format
  const resultSet = json.resultSets[0];
  const headers: string[] = resultSet.headers;
  const rows: any[][] = resultSet.rowSet;

  // Just skip if the player did not play any games the entire season
  if (rows.length === 0) return;

  // Setup the columns
  const dateIdx = headers.indexOf("GAME_DATE");
  const ptsIdx = headers.indexOf("PTS");
  const rebIdx = headers.indexOf("REB");
  const astIdx = headers.indexOf("AST");
  const fg3mIdx = headers.indexOf("FG3M");

  // Only get what we need
  const logs = rows.map((row) => ({
    gameDate: row[dateIdx],
    pts: row[ptsIdx],
    reb: row[rebIdx],
    ast: row[astIdx],
    fg3m: row[fg3mIdx],
  }));

  // Insert the game(s) in db
  await insertGameLogs(db, playerId, logs);
  logger.info({ playerId, newGames: logs.length }, "Synced game logs to DB");
};

export interface StatProfile {
  mean: number;
  variance: number;
  stdDev: number;
  games: number;
  overdispersed: boolean;
  suggestedDistribution: "poisson" | "negative_binomial" | "normal";
  nbR?: number;
  nbP?: number;
}

export interface GameLogRow {
  pts: number;
  reb: number;
  ast: number;
  fg3m: number;
}

/**
 * Computes stat profiles from DB game logs.
 * Syncs game logs first to ensure data is fresh.
 */
export const getPlayerStatProfiles = async (
  db: Database,
  playerName: string,
): Promise<Record<string, StatProfile> | null> => {
  // Get the playerId
  const playerId = await getPlayerId(db, playerName);
  if (!playerId) return null;

  // Sync the db to have the latest game
  await syncGameLogs(db, playerId);

  // Get the games from db for this player
  const rows = await getPlayerGameLogs(db, playerId);
  if (rows.length === 0) return null;

  const profiles: Record<string, StatProfile> = {};

  // Base stats of an nba player
  const statMap: Record<string, string> = {
    points: "pts",
    rebounds: "reb",
    assists: "ast",
    threes: "fg3m",
  };

  // Calculate the mean, variance, stdDev, and identify if the stats are overDispersed for base stats
  for (const [propType, col] of Object.entries(statMap)) {
    const values: number[] = rows.map(
      (row: GameLogRow) => row[col as keyof GameLogRow],
    );

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const overdispersed = variance > mean * 1.5;

    let suggested: StatProfile["suggestedDistribution"] = "poisson";
    let nbR: number | undefined;
    let nbP: number | undefined;

    if (overdispersed) {
      suggested = "negative_binomial";
      if (variance > mean) {
        nbR = (mean * mean) / (variance - mean);
        nbP = mean / variance;
      }
    }

    profiles[propType] = {
      mean: parseFloat(mean.toFixed(4)),
      variance: parseFloat(variance.toFixed(4)),
      stdDev: parseFloat(stdDev.toFixed(4)),
      games: values.length,
      overdispersed,
      suggestedDistribution: suggested,
      ...(nbR !== undefined && { nbR: parseFloat(nbR.toFixed(4)) }),
      ...(nbP !== undefined && { nbP: parseFloat(nbP.toFixed(4)) }),
    };
  }

  // Combos — sum per game, then compute mean and stdDev
  const comboMap: Record<string, string[]> = {
    points_rebounds_assists: ["pts", "reb", "ast"],
    points_assists: ["pts", "ast"],
    points_rebounds: ["pts", "reb"],
    rebounds_assists: ["reb", "ast"],
  };

  // Calculate the mean, variance, stdDev, and identify if the stats are overDispersed for combo stats
  for (const [comboType, cols] of Object.entries(comboMap)) {
    const sums = rows.map((row: GameLogRow) =>
      cols.reduce((acc, col) => acc + row[col as keyof GameLogRow], 0),
    );
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    const variance =
      sums.reduce((sum, x) => sum + (x - mean) ** 2, 0) / sums.length;
    const stdDev = Math.sqrt(variance);

    profiles[comboType] = {
      mean: parseFloat(mean.toFixed(4)),
      variance: parseFloat(variance.toFixed(4)),
      stdDev: parseFloat(stdDev.toFixed(4)),
      games: sums.length,
      overdispersed: false,
      suggestedDistribution: "normal",
    };
  }

  return profiles;
};
