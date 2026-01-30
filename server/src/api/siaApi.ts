import { Page, Browser } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  PROP_MARKETS_SIAAPI,
  SIA_URLS,
  PROP_TYPE_MAP,
} from "../config/siaConstants.ts";

puppeteer.use(StealthPlugin());

export const getFixtures = async (fixtureURL: string) => {
  if (!page) throw new Error("Browser not initialized");
  const games = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.json();
  }, fixtureURL);

  return games.fixtures;
};

const scrapeOdds = async (fixtureURL: string) => {
  if (!page) throw new Error("Browser not initialized");
  const data = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.json();
  }, fixtureURL);

  return data.fixture;
};

let browser: Browser | null = null;
let page: Page | null = null;

export const initBrowser = async () => {
  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();
  await page.goto("https://www.sportsinteraction.com", {
    waitUntil: "domcontentloaded",
  });
};

export const closeBrowser = async () => {
  await browser?.close();
};

export const getSiaOdds = async (
  fixtureId: number,
  homeTeam: string,
  awayTeam: string,
  fixtures: any,
) => {
  // Check if a page is open. If not, throw an error
  if (!page) throw new Error("Browser not initialized");

  // Scrape the odds
  const siaMarkets = await scrapeOdds(SIA_URLS.nba.markets(fixtureId));

  const siaFilteredMarkets = siaMarkets.optionMarkets?.filter(
    (market: any) =>
      // Check if the market has a templateCategory of "Player Special" because the ones that I want belongs here
      market.templateCategory?.name?.value === "Player specials" &&
      // We must only get the ones with the same patterns as in the PROP_MARKETS_SIAAPI since that is all the over unders that I want
      PROP_MARKETS_SIAAPI.NBA.some((pattern) =>
        market.name.value.includes(pattern),
      ),
  );

  const propsByPlayer = {
    ht: homeTeam,
    at: awayTeam,
    props: {} as Record<string, any>,
  };

  siaFilteredMarkets.forEach((market: any) => {
    // This JSON is made up of player props so the market.id is the participant ID a.k.a the player's id.
    const playerName = getPlayerShortName(fixtures, market.player1Id);
    const line = parseFloat(market.attr);

    // Example: Points, Rebound, etc.
    const propType = getPropType(market.name.value);

    // Check if the player already exist in the entry. If not, then create an entry.
    if (!propsByPlayer.props[playerName]) {
      propsByPlayer.props[playerName] = {};
    }

    // For each propType available to a player, we create an entry for it filled with odds of over and under
    propsByPlayer.props[playerName][propType] = {
      line,
      over: market.options.find((option: any) => option.totalsPrefix === "Over")
        ?.price.americanOdds,
      under: market.options.find(
        (option: any) => option.totalsPrefix === "Under",
      )?.price.americanOdds,
    };
  });

  return propsByPlayer;
};

const getPlayerShortName = (
  fixture: any,
  participantId: number,
) => {
  const player = fixture.participants?.find(
    (participant: any) => participant.participantId === participantId,
  );
  return player?.name.short;
};

const getPropType = (marketName: string) => {
  const match = Object.keys(PROP_TYPE_MAP).find((pattern) =>
    marketName.includes(pattern),
  );
  return match ? PROP_TYPE_MAP[match] : null;
};
