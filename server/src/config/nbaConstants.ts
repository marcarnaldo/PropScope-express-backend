function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed, so 0 = Jan

  // NBA season starts in October. If we're Oct-Dec, season is year-(year+1)
  // If we're Jan-Sep, season is (year-1)-year
  if (month >= 9) {
    return `${year}-${(year + 1).toString().slice(-2)}`;
  }
  return `${year - 1}-${year.toString().slice(-2)}`;
}

export const PLAYER_AVERAGE_URL = (playerId: number): string =>
  `https://stats.nba.com/stats/playerdashboardbygeneralsplits?PlayerID=${playerId}&Season=${getCurrentSeason}&MeasureType=Base&PerMode=PerGame&SeasonType=Regular+Season&PaceAdjust=N&PlusMinus=N&Rank=N&Month=0&OpponentTeamID=0&LastNGames=0&Period=0&DateFrom=&DateTo=&GameSegment=&LeagueID=&Location=&Outcome=&PORound=&SeasonSegment=&ShotClockRange=&VsConference=&VsDivision=`;

export const PLAYER_INFO: string = `https://stats.nba.com/stats/commonallplayers?LeagueID=00&Season=${getCurrentSeason()}&IsOnlyCurrentSeason=1`

export const NBA_STATS_HEADERS = {
  'Host': 'stats.nba.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:61.0) Gecko/20100101 Firefox/61.0',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://stats.nba.com/',
  'Connection': 'keep-alive',
};