export const SPORTS = {
  NBA: "basketball_nba",
  NFL: "americanfootball_nfl",
  NHL: "icehockey_nhl",
} as const;

export const ANCHOR_BOOK = "fanduel"


export const PROP_MARKETS_ODDSAPI = {
  NBA: [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_threes",
    "player_points_rebounds_assists",
    "player_points_assists",
    "player_points_rebounds",
    "player_rebounds_assists"
  ],
  // NFL: [
  //   "player_pass_yds",
  //   "player_rush_yds",
  //   "player_reception_yds",
  //   "player_pass_tds",
  //   "player_rush_attempts",
  //   "player_receptions",
  //   "player_rush_reception_yds",
  // ],
  // NHL: [
  //   "player_power_play_points",
  //   "player_assists",
  //   "player_total_saves",
  //   "player_shots_on_goal",
  //   "player_points",
  // ],
};