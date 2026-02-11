/**
 * FanDuel Odds API Service
 *
 * Fetches player prop odds from FanDuel via The Odds API (https://the-odds-api.com).
 * FanDuel is used as the "anchor" book — the sharp reference for true odds.
 * Each API call costs credits, so we only fetch when needed (scheduled before game time).
 */

import "dotenv/config";
import { logger } from "../utils/errorHandling.ts";
import {
  ANCHOR_BOOK,
  PROP_MARKETS_ODDSAPI,
  SPORTS,
} from "../config/oddsapiConstants.ts";
import { getErrorMessage, MAX_RETRIES } from "../utils/errorHandling.ts";
import {
  FdEvent,
  FdEventOddsResponse,
  FdMarket,
  FdOutcome,
  PlayerPropsResponse,
} from "../config/types.ts";

export class FanduelOddsApiService {
  private readonly API_KEY = process.env.ODDS_API_KEY;

  /** Fetches all upcoming events for a given sport from The Odds API. */
  private async getFanduelEvents(sport: string): Promise<FdEvent[]> {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${this.API_KEY}`;
        const res = await fetch(url);

        // Throw an error if the HTTP response is not successful
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const data: FdEvent[] = await res.json();
        return data;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        lastError = error;

        if (attempt === MAX_RETRIES) break;

        // Exponential backoff 2^attempt seconds
        const waitTime = Math.pow(2, attempt) * 1000; //
        logger.warn(
          {
            attempt,
            maxRetries: MAX_RETRIES,
            error: errorMessage,
            waitMs: waitTime,
          },
          "getFanduelEvents failed, retrying",
        );

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    // Throw an error if all retries failed
    throw new Error(
      `Failed to fetch events after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  /**
   * Fetches player prop odds for a specific event from The Odds API.
   * Tracks remaining API credits and reduces market count if running low.
   */
  private async getPlayerProps(
    sport: string,
    eventId: string,
    markets: readonly string[],
    anchor: string,
  ): Promise<FdEventOddsResponse> {
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
          logger.warn(
            { remainingCredits, requiredCredits: marketPropsLength },
            "Insufficient API credits, reducing markets",
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
        logger.info(
          { remainingCredits, usedCredits, totalCredits, lastUsedCredits },
          "API credit status",
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const data: FdEventOddsResponse = await res.json();
        return data;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        lastError = error;

        if (attempt === MAX_RETRIES) break;

        // Exponential backoff 2^attempt seconds
        const waitTime = Math.pow(2, attempt) * 1000;

        logger.warn(
          {
            attempt,
            maxRetries: MAX_RETRIES,
            error: errorMessage,
            waitMs: waitTime,
          },
          "getPlayerProps for fanduel failed, retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new Error(
      `Failed to fetch events after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  /**
   * Fetches and parses FanDuel player prop odds for a specific game.
   * Matches the event by home/away team to ensure we get the correct game.
   * Organizes odds by player name and prop type.
   */
  // Need to pass both home and away team so that I do not get any teams that are going back to back
  public async getFanduelOdds(homeTeam: string, awayTeam: string): Promise<PlayerPropsResponse | null> {
    try {
      const events = await this.getFanduelEvents(SPORTS.NBA);

      // Filter the event based on passed homeTeam and awayTeam to make sure that we get the same event as sia
      const filteredEvent = events.find((event: FdEvent) => {
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

      const fdMarkets: FdMarket[] = fdData.bookmakers[0].markets || [];

      const propsByPlayer: PlayerPropsResponse = {
        ht: homeTeam,
        at: awayTeam,
        props: {},
      };

      fdMarkets.forEach((market: FdMarket) => {
        // Example of odds_api propType key: player_assists. Thus, we need to remove "player" to nothing to get just the type.
        const propType = market.key.replace("player_", "");

        market.outcomes.forEach((outcome: FdOutcome) => {
          const playerName = outcome.description;
          const line = outcome.point;
          const odds = outcome.price;
          // over or under
          const side = outcome.name.toLowerCase() as "over" | "under";

          // Check if the player is in the entry. If not, make one.
          if (!propsByPlayer.props[playerName]) {
            propsByPlayer.props[playerName] = {};
          }

          // Check if proptype is already in the entry. If not, make one and populate with the line.
          if (!propsByPlayer.props[playerName][propType]) {
            propsByPlayer.props[playerName][propType] = { line } as any; // Partially built, over/under added below
          }

          // Just putting over: odds or under:odds
          propsByPlayer.props[playerName][propType][side] = odds;
        });
      });

      return propsByPlayer;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error(
        { homeTeam, awayTeam, error: errorMessage },
        "Failed to get fanduel odds",
      );

      return null;
    }
  }
}