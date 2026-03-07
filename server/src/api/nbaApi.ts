import {
  NBA_STATS_HEADERS,
  PLAYER_AVERAGE_URL,
  PLAYER_INFO,
} from "../config/nbaConstants";

let playerCache: Map<string, number> | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export const getPlayerAverages = async (
  playerName: string,
  statLabel: string,
): Promise<number | null> => {
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
  const index = headers.indexOf(statLabel);

  if (index === -1) return null;

  return row[index];
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
