/**
 * Sports Interaction (SIA) API Service
 *
 * Scrapes player prop odds from SIA using a headless browser (Puppeteer).
 * SIA requires browser cookies/session to access their internal API,
 * so we use puppeteer-stealth to bypass Cloudflare protection.
 * All requests are made through the browser's page context.
 */

import { logger } from "../utils/errorHandling.ts";
import {
  PROP_MARKETS_SIAAPI,
  SIA_URLS,
  PROP_TYPE_MAP,
} from "../config/siaConstants.ts";
import { BrowserManager } from "../services/browser.ts";
import { getErrorMessage, MAX_RETRIES } from "../utils/errorHandling.ts";
import {
  SiaFixture,
  SiaMarket,
  SiaMarketOption,
  SiaFixtureParticipant,
  PlayerPropsResponse,
} from "../config/types.ts";

const PAGE_TIMEOUT = 15000; // 15 seconds

/** Races a promise against a timeout. Rejects if the promise takes too long. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Page evaluate timed out")), ms),
    ),
  ]);
};

export class SiaApiService {
  private browserManager: BrowserManager;
  private readonly SIA_MAIN_URL = "https://www.sportsinteraction.com";

  constructor() {
    this.browserManager = new BrowserManager();
  }

  /** Launches the headless browser and navigates to SIA to establish cookies/session. */
  public async initialize(): Promise<void> {
    await this.browserManager.initializeBrowser(this.SIA_MAIN_URL);
  }

  /** Fetches all upcoming fixtures (games) for a given sport from SIA's internal API. */
  public async getFixtures(eventsUrl: string): Promise<SiaFixture[]> {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Wait until there is an available page to use
      const page = await this.browserManager.acquirePage();
      try {
        // If the page.evaluate does not succeed within 15 seconds, we must retry by throwing an error and letting the catch block do its thing
        const events = await withTimeout(
          page.evaluate(async (url: string) => {
            const res = await fetch(url);
            if (!res.ok)
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            return res.json();
          }, eventsUrl),
          PAGE_TIMEOUT,
        );

        return events.fixtures;
      } catch (error) {
        lastError = error;
        const errorMessage = getErrorMessage(error);
        if (attempt === MAX_RETRIES) break;

        const waitTime = Math.pow(2, attempt) * 1000;

        logger.warn(
          {
            attempt,
            maxRetries: MAX_RETRIES,
            error: errorMessage,
            waitMs: waitTime,
          },
          "getFixtures failed, retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } finally {
        // Release the page back to the pool once done using
        this.browserManager.releasePage(page);
      }
    }

    throw new Error(
      `Failed to fetch fixtures after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  /** Fetches a single fixture's full data including all option markets (player props, spreads, etc). */
  private async getSpecificFixture(
    specificEventUrl: string,
  ): Promise<SiaFixture> {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Wait until there is an available page to use
      const page = await this.browserManager.acquirePage();
      try {
        // If the page.evaluate does not succeed within 15 seconds, we must retry by throwing an error and letting the catch block do its thing
        const events = await withTimeout(
          page.evaluate(async (url: string) => {
            const res = await fetch(url);
            if (!res.ok)
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            return res.json();
          }, specificEventUrl),
          PAGE_TIMEOUT,
        );

        return events.fixture; // instead of fixtures, we only need the fixture (1 specific event)
      } catch (error) {
        lastError = error;
        const errorMessage = getErrorMessage(error);
        if (attempt === MAX_RETRIES) break;

        const waitTime = Math.pow(2, attempt) * 1000;

        logger.warn(
          {
            attempt,
            maxRetries: MAX_RETRIES,
            error: errorMessage,
            waitMs: waitTime,
          },
          "getSpecificFixture failed, retrying",
        );

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } finally {
        // Release the page back to the pool once done using
        this.browserManager.releasePage(page);
      }
    }

    throw new Error(
      `Failed to fetch fixtures after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  /**
   * Fetches and parses player prop odds from SIA for a specific fixture.
   * Filters markets to only "Player specials" that match our target prop types,
   * then organizes by player name and prop type.
   */
  public async getSiaOdds(
    fixtureId: number,
    homeTeam: string,
    awayTeam: string,
    fixture: SiaFixture,
  ): Promise<PlayerPropsResponse> {
    try {
      const specificFixture = await this.getSpecificFixture(
        SIA_URLS.nba.markets(fixtureId),
      );

      const filteredMarket =
        specificFixture.optionMarkets?.filter(
          (market: SiaMarket) =>
            // Check if the market has a templateCategory of "Player specials" because the ones that I want belongs here
            market.templateCategory?.name?.value === "Player specials" &&
            // We must only get the ones with the same patterns as in the PROP_MARKETS_SIAAPI since that is all the over unders that I want
            PROP_MARKETS_SIAAPI.NBA.some((pattern) =>
              market.name.value.includes(pattern),
            ),
        ) ?? [];

      const propsByPlayer: PlayerPropsResponse = {
        ht: homeTeam,
        at: awayTeam,
        props: {},
      };

      filteredMarket.forEach((market: SiaMarket) => {
        // This JSON is made up of player props so the market.id is the participant ID a.k.a the player's id.
        const playerName = this.getPlayerShortName(fixture, market.player1Id);
        if (!playerName) return;

        const line = parseFloat(market.attr);

        // Example: Points, Rebound, etc.
        const propType = this.getPropType(market.name.value);
        if (!propType) return; // Since not all players has the prop type I am looking for, we need to check if the prop type is null so we do not include it

        // Check if the player already exist in the entry. If not, then create an entry.
        if (!propsByPlayer.props[playerName]) {
          propsByPlayer.props[playerName] = {};
        }

        const overOdds = market.options.find(
          (option: SiaMarketOption) => option.totalsPrefix === "Over",
        )?.price.americanOdds;

        const underOdds = market.options.find(
          (option: SiaMarketOption) => option.totalsPrefix === "Under",
        )?.price.americanOdds;

        if (overOdds === undefined || underOdds === undefined) return;

        // For each propType available to a player, we create an entry for it and fill it with odds of over and under
        propsByPlayer.props[playerName][propType] = {
          line,
          over: overOdds,
          under: underOdds,
        };
      });

      return propsByPlayer;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error(
        { fixtureId, homeTeam, awayTeam, error: errorMessage },
        "getSiaOdds error, failed getting odds for SportsIntercation",
      );

      throw error;
    }
  }

  /** Resolves a participant ID to their short display name (e.g. "Jason Tatum"). */
  private getPlayerShortName = (
    fixture: SiaFixture,
    participantId: number,
  ): string | undefined => {
    const player = fixture.participants?.find(
      (participant: SiaFixtureParticipant) =>
        participant.participantId === participantId,
    );
    return player?.name.short;
  };

  /** Maps a SIA market name string to our standardized prop type key (e.g. ": Points" -> "points"). */
  private getPropType = (marketName: string): string | null => {
    const match = Object.keys(PROP_TYPE_MAP).find((pattern) =>
      marketName.includes(pattern),
    ) as keyof typeof PROP_TYPE_MAP | undefined;

    return match ? PROP_TYPE_MAP[match] : null;
  };

  public async close(): Promise<void> {
    await this.browserManager.closeBrowser();
  }

  public async isBrowserHealthy(): Promise<boolean> {
    return this.browserManager.isHealthy();
  }
}
