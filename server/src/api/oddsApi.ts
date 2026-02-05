import "dotenv/config";
import {
  ANCHOR_BOOK,
  PROP_MARKETS_ODDSAPI,
  SPORTS,
} from "../config/oddsapiConstants.ts";
import { getErrorMessage, MAX_RETRIES } from "../utils/errorHandling.ts";

export class FanduelOddsApiService {
  private readonly API_KEY = process.env.ODDS_API_KEY;

  private async getFanduelEvents(sport: string): Promise<any[]> {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${this.API_KEY}`;
        const res = await fetch(url);

        // Throw an error if the HTTP response is not successful
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const data = await res.json();
        return data;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        lastError = error;

        if (attempt === MAX_RETRIES) break;

        // Exponential backoff 2^attempt seconds
        const waitTime = Math.pow(2, attempt) * 1000; //
        console.warn(
          `[Retry ${attempt}/${MAX_RETRIES}] getFanduelEvents failed: ${errorMessage}. Retrying in ${waitTime}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    // Throw an error if all retries failed
    throw new Error(
      `Failed to fetch events after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }
  // Get the player prop of the specified sport and the event
  private async getPlayerProps(
    sport: string,
    eventId: string,
    markets: any,
    anchor: string,
  ): Promise<any> {
    let lastError;
    let remainingCredits = Infinity;
    const marketPropsLength = markets.length;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const maxMarkets =
          remainingCredits !== Infinity && remainingCredits < marketPropsLength
            ? remainingCredits
            : marketPropsLength;

        if (maxMarkets === 0)
          throw new Error(
            "No API credits remaining - cannot fetch any markets",
          );

        if (maxMarkets < marketPropsLength)
          console.warn(
            `Only ${remainingCredits} credits left, but need ${marketPropsLength} credits to get markets. Reducing to ${remainingCredits} markets instead.`,
          );

        const marketsToFetch = markets.slice(0, maxMarkets).join(",");

        const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds?apiKey=${this.API_KEY}&regions=us&markets=${marketsToFetch}&bookmakers=${anchor}&oddsFormat=american`;
        const res = await fetch(url);

        remainingCredits = parseInt(
          res.headers.get("x-requests-remaining") || "0",
        );
        const usedCredits = parseInt(res.headers.get("x-requests-used") || "0");
        const totalCredits = remainingCredits + usedCredits;
        const lastUsedCredits = parseInt(
          res.headers.get("x-requests-last") || "0",
        );

        console.log(`Remaining credits: ${remainingCredits}`);
        console.log(`Total consumption ${usedCredits}/${totalCredits}`);
        console.log(`Number of credits that just used: ${lastUsedCredits}`);

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const data = await res.json();
        return data;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        lastError = error;

        if (attempt === MAX_RETRIES) break;

        // Exponential backoff 2^attempt seconds
        const waitTime = Math.pow(2, attempt) * 1000; //
        console.warn(
          `[Retry ${attempt}/${MAX_RETRIES}] getPlayerProps failed: ${errorMessage}. Retrying in ${waitTime}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new Error(
      `Failed to fetch events after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  // Need to pass both home and away team so that I do not get any teams that are going back to back
  public async getFanduelOdds(homeTeam: string, awayTeam: string) {
    try {
      const events = await this.getFanduelEvents(SPORTS.NBA);

      // Filter the event based on passed homeTeam and awayTeam to make sure that we get the same event as sia
      const filteredEvent = events.find((event: any) => {
        return event.home_team === homeTeam && event.away_team === awayTeam;
      });

      if (!filteredEvent)
        throw new Error(
          `No matching FanDuel event found for ${homeTeam} vs ${awayTeam}`,
        );

      const fdData = await this.getPlayerProps(
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
        // Example of odds_api propType key: player_assists. Thus, we need to remove "player" to nothing to get just the type.
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

      return propsByPlayer;
    } catch (error) {
      console.error(
        `Failed to get FanDuel odds for ${homeTeam} vs ${awayTeam}:`,
        getErrorMessage(error),
      );
      return null;
    }
  }
}
