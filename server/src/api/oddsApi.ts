import "dotenv/config";
import {
  ANCHOR_BOOK,
  PROP_MARKETS_ODDSAPI,
  SPORTS,
} from "../config/oddsapiConstants.ts";

const apiKey = process.env.ODDS_API_KEY;

// Get the upcoming events of the specified sport
const getEvents = async (sport: string) => {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${apiKey}`;
  const res = await fetch(url);

  return res.json();
};

// Get the player prop of the specified sport and the event
const getPlayerProps = async (
  sport: string,
  eventId: string,
  markets: any,
  anchor: string,
) => {
  const marketProps = markets.join(",");
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=${marketProps}&bookmakers=${anchor}&oddsFormat=american`;
  const res = await fetch(url);

  console.log("Remaining:", res.headers.get("x-requests-remaining"));
  console.log("Used:", res.headers.get("x-requests-used"));
  return res.json();
};

// Need to pass both home and away team so that I do not get any teams that are going back to back
export const getFanduelOdds = async (homeTeam: string, awayTeam: string) => {
  const events = await getEvents(SPORTS.NBA);

  // Filter the event based on passed homeTeam and awayTeam to make sure that we get the same event as sia
  const filteredEvent = events.find((event: any) => {
    return event.home_team === homeTeam && event.away_team === awayTeam;
  });

  if (!filteredEvent) return null;

  const fdData = await getPlayerProps(
    SPORTS.NBA,
    filteredEvent.id,
    PROP_MARKETS_ODDSAPI.NBA,
    ANCHOR_BOOK,
  );

  const fdMarkets = fdData.bookmakers[0].markets || [];

  const propsByPlayer = { 
    ht: homeTeam, 
    at: awayTeam,
    props: {} as Record<string, any>,
  };

  fdMarkets.forEach((market: any) => {
    // Example of odds_api propType key: player_assists. Thus, we need to remove "player" to nothing.
    const propType = market.key.replace("player_", "");

    market.outcomes.forEach((outcome: any) => {
      const playerName = outcome.description;
      const line = outcome.point;
      const odds = outcome.price;
      // over or under
      const side = outcome.name.toLowerCase();

      // Check if the player is in the entry. If not, make one.
      if (!propsByPlayer.props[playerName]) {
        propsByPlayer.props[playerName] = {};
      }

      // Check if proptype is already in the entry. If not, make one and populate with the line.
      if (!propsByPlayer.props[playerName][propType]) {
        propsByPlayer.props[playerName][propType] = { line }; // { line } is a shorthand for { line: line }
      }

      // Just putting over: odds or under:odds
      propsByPlayer.props[playerName][propType][side] = odds;
    });
  });

  return propsByPlayer
};
