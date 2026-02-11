/**
 * Sports Interaction (SIA) Constants
 *
 * Configuration for scraping SIA's internal API.
 * Defines player prop market patterns to match against,
 * a mapping from SIA's naming convention to our standardized prop types,
 * and the API URLs for each sport's fixtures and markets.
 */

export const PROP_MARKETS_SIAAPI = {
  NBA: [
    ": Points",
    ": Rebounds",
    ": Assists",
    "Three-pointers made",
    "Total points, rebounds and assists",
    "Total points and assists",
    "Total points and rebounds",
    "Total assists and rebounds",
  ],
};

export const PROP_TYPE_MAP = {
  ": Points": "points",
  ": Rebounds": "rebounds",
  ": Assists": "assists",
  "Three-pointers made": "threes",
  "Total points, rebounds and assists": "points_rebounds_assists",
  "Total points and assists": "points_assists",
  "Total points and rebounds": "points_rebounds",
  "Total assists and rebounds": "rebounds_assists",
};

export const SIA_URLS = {
  nba: {
    fixtures:
      "https://www.sportsinteraction.com/cds-api/bettingoffer/fixtures?x-bwin-accessid=OGQ2ZTg0MGYtYjkwNS00ZmI1LTlkN2YtZDVmY2Y0ZDNkYmFl&lang=en-ca&country=CA&userCountry=CA&subdivision=CA-British%20Columbia&fixtureTypes=Standard&state=Latest&offerMapping=Filtered&offerCategories=Gridable&fixtureCategories=Gridable,NonGridable,Other&sportIds=7&competitionIds=6004&isPriceBoost=false&statisticsModes=None&skip=0&take=50&sortBy=Tags",
    markets: (fixtureId: number) =>
      `https://www.sportsinteraction.com/cds-api/bettingoffer/fixture-view?x-bwin-accessid=OGQ2ZTg0MGYtYjkwNS00ZmI1LTlkN2YtZDVmY2Y0ZDNkYmFl&lang=en-ca&country=CA&userCountry=CA&subdivision=CA-British%20Columbia&offerMapping=All&scoreboardMode=Full&fixtureIds=${fixtureId}&state=Latest&includePrecreatedBetBuilder=true&supportVirtual=false&isBettingInsightsEnabled=false&useRegionalisedConfiguration=true&includeRelatedFixtures=false&statisticsModes=None&firstMarketGroupOnly=false`,
  },
  nhl: {
    fixtures:
      "https://www.sportsinteraction.com/cds-api/bettingoffer/fixtures?x-bwin-accessid=OGQ2ZTg0MGYtYjkwNS00ZmI1LTlkN2YtZDVmY2Y0ZDNkYmFl&lang=en-ca&country=CA&userCountry=CA&subdivision=CA-British%20Columbia&fixtureTypes=Standard&state=Latest&offerMapping=Filtered&offerCategories=Gridable&fixtureCategories=Gridable,NonGridable,Other&sportIds=12&competitionIds=34&isPriceBoost=false&statisticsModes=None&skip=0&take=50&sortBy=Tags",
    markets: (fixtureId: number) =>
      `https://www.sportsinteraction.com/cds-api/bettingoffer/fixture-view?x-bwin-accessid=OGQ2ZTg0MGYtYjkwNS00ZmI1LTlkN2YtZDVmY2Y0ZDNkYmFl&lang=en-ca&country=CA&userCountry=CA&subdivision=CA-British%20Columbia&offerMapping=All&scoreboardMode=Full&fixtureIds=${fixtureId}&state=Latest&includePrecreatedBetBuilder=true&supportVirtual=false&isBettingInsightsEnabled=false&useRegionalisedConfiguration=true&includeRelatedFixtures=false&statisticsModes=None&firstMarketGroupOnly=false`,
  },
  nfl: {
    fixtures:
      "https://www.sportsinteraction.com/cds-api/bettingoffer/fixtures?x-bwin-accessid=OGQ2ZTg0MGYtYjkwNS00ZmI1LTlkN2YtZDVmY2Y0ZDNkYmFl&lang=en-ca&country=CA&userCountry=CA&subdivision=CA-British%20Columbia&fixtureTypes=Standard&state=Latest&offerMapping=Filtered&offerCategories=Gridable&fixtureCategories=Gridable,NonGridable,Other&sportIds=11&isPriceBoost=false&statisticsModes=None&skip=0&take=50&sortBy=Tags",
    markets: (fixtureId: number) =>
      `https://www.sportsinteraction.com/cds-api/bettingoffer/fixture-view?x-bwin-accessid=OGQ2ZTg0MGYtYjkwNS00ZmI1LTlkN2YtZDVmY2Y0ZDNkYmFl&lang=en-ca&country=CA&userCountry=CA&subdivision=CA-British%20Columbia&offerMapping=All&scoreboardMode=Full&fixtureIds=${fixtureId}&state=Latest&includePrecreatedBetBuilder=true&supportVirtual=false&isBettingInsightsEnabled=false&useRegionalisedConfiguration=true&includeRelatedFixtures=false&statisticsModes=None&firstMarketGroupOnly=false`,
  },
};
