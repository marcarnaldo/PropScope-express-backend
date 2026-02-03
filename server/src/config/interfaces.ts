export interface PropParams {
    sport: string
    eventId: string
}

export interface Fixture {
  fixtureId: number;
  fixtureData: any;
  startDate: string;
  createdAt?: string;
}

export interface OddsSnapshot {
  fixtureId: number;
  oddsData: any;
  lastUpdated?: string;
}