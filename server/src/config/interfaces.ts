export interface PropParams {
    sport: string
    eventId: string
}

export interface OddsSnapshot {
  fixtureId: number;
  oddsData: any;
  snapshotTime: string;
}

export interface Fixture {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  startDate: string;
  status: string;
}
