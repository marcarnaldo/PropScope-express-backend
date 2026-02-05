import {
  PROP_MARKETS_SIAAPI,
  SIA_URLS,
  PROP_TYPE_MAP,
} from "../config/siaConstants.ts";
import { BrowserManager } from "../services/browser.ts";
import { getErrorMessage, MAX_RETRIES } from "../utils/errorHandling.ts";

export class SiaApiService {
  private browserManager: BrowserManager;
  private readonly SIA_MAIN_URL = "https://www.sportsinteraction.com";

  constructor() {
    this.browserManager = new BrowserManager();
  }

  public async initialize() {
    await this.browserManager.initializeBrowser(this.SIA_MAIN_URL);
  }

  public async getFixtures(eventsUrl: string): Promise<any[]> {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.browserManager.ensureHealthy();
        const page = this.browserManager.getPage();

        const events = await page.evaluate(async (url: string) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          return res.json();
        }, eventsUrl);

        return events.fixtures;
      } catch (error) {
        lastError = error;

        if (attempt === MAX_RETRIES) break;

        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(
          `[Retry ${attempt}/${MAX_RETRIES}] getFixtures failed. Retrying in ${waitTime}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new Error(
      `Failed to fetch fixtures after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  private async getSpecificFixture(specificEventUrl: string): Promise<any> {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.browserManager.ensureHealthy();
        const page = this.browserManager.getPage();

        const events = await page.evaluate(async (url: string) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          return res.json();
        }, specificEventUrl);

        return events.fixture; // instead of fixtures, we only need the fixture (1 specific event)
      } catch (error) {
        lastError = error;

        if (attempt === MAX_RETRIES) break;

        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(
          `[Retry ${attempt}/${MAX_RETRIES}] getFixtures failed. Retrying in ${waitTime}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new Error(
      `Failed to fetch fixtures after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  public async getSiaPlayerOverUnders(
    fixtureId: number,
    homeTeam: string,
    awayTeam: string,
    fixture: any,
  ): Promise<any> {
    try {
      const specificFixture = await this.getSpecificFixture(
        SIA_URLS.nba.markets(fixtureId),
      );

      const filteredMarket = specificFixture.optionMarkets?.filter(
        (market: any) =>
          // Check if the market has a templateCategory of "Player Special" because the ones that I want belongs here
          market.templateCategory?.name?.value === "Player specials" &&
          // We must only get the ones with the same patterns as in the PROP_MARKETS_SIAAPI since that is all the over unders that I want
          PROP_MARKETS_SIAAPI.NBA.some((pattern) => {
            market.name.value.includes(pattern);
          }),
      );

      const propsByPlayer = {
        ht: homeTeam,
        at: awayTeam,
        props: {} as Record<string, any>,
      };

      filteredMarket.forEach((market: any) => {
        // This JSON is made up of player props so the market.id is the participant ID a.k.a the player's id.
        const playerName = this.getPlayerShortName(fixture, market.player1Id);
        const line = parseFloat(market.attr);

        // Example: Points, Rebound, etc.
        const propType = this.getPropType(market.name.value);
        if (!propType) return; // Since not all players has the prop type I am looking for, we need to check if the prop type is null so we do not include it

        // Check if the player already exist in the entry. If not, then create an entry.
        if (!propsByPlayer.props[playerName]) {
          propsByPlayer.props[playerName] = {};
        }

        // For each propType available to a player, we create an entry for it and fill it with odds of over and under
        propsByPlayer.props[playerName][propType] = {
          line,
          over: market.options.find(
            (option: any) => option.totalsPrefix === "Over",
          )?.price.americanOdds,
          under: market.options.find(
            (option: any) => option.totalsPrefix === "Under",
          )?.price.americanOdds,
        };
      });

      return propsByPlayer;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error(
        `Failed to get SIA odds for fixture ${fixtureId} (${homeTeam} vs ${awayTeam}): ${errorMessage}`,
      );
      throw error;
    }
  }

  private getPlayerShortName = (
    fixture: any,
    participantId: number,
  ): string => {
    const player = fixture.participants?.find(
      (participant: any) => participant.participantId === participantId,
    );
    return player?.name.short;
  };

  private getPropType = (marketName: string): string | null => {
    const match = Object.keys(PROP_TYPE_MAP).find((pattern) =>
      marketName.includes(pattern),
    ) as keyof typeof PROP_TYPE_MAP | undefined;

    return match ? PROP_TYPE_MAP[match] : null;
  };

  public async close(): Promise<void> {
    await this.browserManager.closeBrowser();
  }
}
