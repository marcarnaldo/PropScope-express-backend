import {
  COMBOS,
  NBA_STATS_HEADERS,
  PLAYER_AVERAGE_URL,
  PLAYER_GAME_LOG_URL,
  PLAYER_INFO,
  STAT_COLUMNS,
} from "../config/nbaConstants";

let playerCache: Map<string, number> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export const getPlayerAverages = async (
  playerName: string,
): Promise<Record<string, number> | null> => {
  const playerId = await getPlayerId(playerName);
  if (!playerId) return null;

  const url = PLAYER_AVERAGE_URL(playerId);
  const res = await fetch(url, { headers: NBA_STATS_HEADERS });
  const json = await res.json();

  const overall = json.resultSets.find(
    (rs: any) => rs.name === "OverallPlayerDashboard",
  );
  if (!overall || overall.rowSet.length === 0) return null;

  const headers: string[] = overall.headers;
  const row = overall.rowSet[0];

  const averages: Record<string, number> = {};
  for (let i = 0; i < headers.length; i++) {
    if (typeof row[i] === "number") {
      averages[headers[i]] = row[i];
    }
  }

  return averages;
};

async function buildPlayerCache(): Promise<Map<string, number>> {
  if (playerCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return playerCache;
  }

  const url = PLAYER_INFO;
  const res = await fetch(url, { headers: NBA_STATS_HEADERS });
  const json = await res.json();

  const resultSet = json.resultSets[0];
  const headers: string[] = resultSet.headers;
  const rows: any[][] = resultSet.rowSet;

  const nameIndex = headers.indexOf("DISPLAY_FIRST_LAST");
  const idIndex = headers.indexOf("PERSON_ID");

  playerCache = new Map();
  for (const row of rows) {
    const normalized = normalize(row[nameIndex]);
    playerCache.set(normalized, row[idIndex]);
  }

  cacheTimestamp = Date.now();
  return playerCache;
}

export const getPlayerId = async (
  playerName: string,
): Promise<number | null> => {
  const cache = await buildPlayerCache();
  return cache.get(normalize(playerName)) ?? null;
};

function normalize(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

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

export const getPlayerStatProfiles = async (
  playerName: string,
): Promise<Record<string, StatProfile> | null> => {
  const playerId = await getPlayerId(playerName);
  if (!playerId) return null;

  const url = PLAYER_GAME_LOG_URL(playerId);
  const res = await fetch(url, { headers: NBA_STATS_HEADERS });
  const json = await res.json();

  const resultSet = json.resultSets[0];
  const headers: string[] = resultSet.headers;
  const rows: any[][] = resultSet.rowSet;

  if (rows.length === 0) return null;

  // Build column index map
  const colIndex: Record<string, number> = {};
  for (const col of ["PTS", "REB", "AST", "FG3M"]) {
    colIndex[col] = headers.indexOf(col);
  }

  const result: Record<string, StatProfile> = {};

  // Base stats
  for (const [propType, col] of Object.entries(STAT_COLUMNS)) {
    const idx = colIndex[col];
    if (idx === -1) continue;

    const values: number[] = rows.map((r) => r[idx]);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const v =
      values.reduce((sum, x) => sum + (x - avg) ** 2, 0) / values.length;
    const sd = Math.sqrt(v);
    const overdispersed = v > avg * 1.5;

    let suggested: StatProfile["suggestedDistribution"] = "poisson";
    let nbR: number | undefined;
    let nbP: number | undefined;

    if (overdispersed) {
      suggested = "negative_binomial";
      if (v > avg) {
        nbR = (avg * avg) / (v - avg);
        nbP = avg / v;
      }
    }

    result[propType] = {
      mean: parseFloat(avg.toFixed(4)),
      variance: parseFloat(v.toFixed(4)),
      stdDev: parseFloat(sd.toFixed(4)),
      games: values.length,
      overdispersed,
      suggestedDistribution: suggested,
      ...(nbR !== undefined && { nbR: parseFloat(nbR.toFixed(4)) }),
      ...(nbP !== undefined && { nbP: parseFloat(nbP.toFixed(4)) }),
    };
  }

  // Combos — sum per game, then compute mean and stdDev
  for (const [comboType, cols] of Object.entries(COMBOS)) {
    const indices = cols.map((c) => colIndex[c]);
    if (indices.some((i) => i === -1)) continue;

    const sums = rows.map((r) =>
      indices.reduce((acc, idx) => acc + (r[idx] as number), 0),
    );
    const avg = sums.reduce((a, b) => a + b, 0) / sums.length;
    const v = sums.reduce((sum, x) => sum + (x - avg) ** 2, 0) / sums.length;
    const sd = Math.sqrt(v);

    result[comboType] = {
      mean: parseFloat(avg.toFixed(4)),
      variance: parseFloat(v.toFixed(4)),
      stdDev: parseFloat(sd.toFixed(4)),
      games: sums.length,
      overdispersed: false,
      suggestedDistribution: "normal",
    };
  }

  return result;
};
