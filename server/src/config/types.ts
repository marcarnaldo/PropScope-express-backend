// ===== Shared / Core =====

export interface PropOdds {
  line: number;
  over: number;
  under: number;
}

export const SPORTS = {
  NBA: 'nba',
  NFL: 'nfl',
  NHL: 'nhl'
}

// ===== SIA API Shapes (external) =====

export interface SiaFixtureParticipant {
  participantId: number;
  name: {
    value: string;
    short: string;
  };
}

export interface SiaFixture {
  id: number;
  startDate: string;
  participants: SiaFixtureParticipant[];
  optionMarkets?: SiaMarket[];
}

export interface SiaMarketOption {
  totalsPrefix: string;
  price: {
    americanOdds: number;
  };
}

export interface SiaMarket {
  player1Id: number;
  attr: string;
  name: { value: string };
  templateCategory?: { name?: { value: string } };
  options: SiaMarketOption[];
}

// ===== FanDuel / Odds API Shapes (external) =====

export interface FdEvent {
  id: string;
  home_team: string;
  away_team: string;
}

export interface FdOutcome {
  description: string;
  point: number;
  price: number;
  name: string;
}

export interface FdMarket {
  key: string;
  outcomes: FdOutcome[];
}

export interface FdBookmaker {
  markets: FdMarket[];
}

export interface FdEventOddsResponse {
  bookmakers: FdBookmaker[];
}

// ===== Player Props Response (both SIA and FD APIs return this shape) =====

export interface PlayerPropsResponse {
  ht: string;
  at: string;
  props: Record<string, Record<string, PropOdds>>;
}

// ===== Aggregated (after merging SIA + FD) =====

export interface AggregatedProp {
  sia: PropOdds;
  fd: PropOdds;
}

export interface AggregatedOdds {
  ht: string;
  at: string;
  props: Record<string, Record<string, AggregatedProp>>;
}

// ===== Filtered (only props where SIA and FD have the same line) =====

export interface FilteredProp {
  line: number;
  siaOdds: { over: number; under: number };
  fdOdds: { over: number; under: number };
}

export interface FilteredOdds {
  homeTeam: string;
  awayTeam: string;
  props: Record<string, Record<string, FilteredProp>>;
}

// ===== Normalized (vig removed, true probabilities calculated) =====

export interface NormalizedProp {
  line: number;
  siaOdds: { over: number; under: number };
  fdOdds: { over: number; under: number };
  siaOddsNoVig: { over: number; under: number };
  fdOddsNoVig: { over: number; under: number };
}

export interface NormalizedOdds {
  homeTeam: string;
  awayTeam: string;
  props: Record<string, Record<string, NormalizedProp>>;
}

// ===== Database Row Shapes =====

export interface FixtureRow {
  fixture_id: number;
  home_team: string;
  away_team: string;
  start_date: string;
  status: string;
  raw_data: string;
}

// ===== API Response Shapes =====

export interface Fixture {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  startDate: string;
  status: string;
}

export interface OddsSnapshot {
  fixtureId: number;
  oddsData: NormalizedOdds;
  snapshotTime: string;
}

export interface PropParams {
  sport: string;
  eventId: string;
}