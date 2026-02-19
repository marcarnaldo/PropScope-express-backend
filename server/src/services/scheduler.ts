/**
 * Scheduler Service
 *
 * Manages the lifecycle of odds scraping for NBA games.
 * - Fetches fixtures from SIA hourly (6AM-11PM)
 * - Schedules scraping to start 2 hours before each game
 * - Scrapes odds every 5 minutes until game time
 * - Stops scraping and marks fixture as "close" when the game starts
 */

import schedule from "node-schedule";
import cron from "node-cron";
import { logger } from "../utils/errorHandling.ts";
import { SiaApiService } from "../api/siaApi.ts";
import { getErrorMessage } from "../utils/errorHandling.ts";
import { SIA_URLS } from "../config/siaConstants.ts";
import { Database } from "../db/database.ts";
import {
  filterSameLines,
  normalizeOdds,
  aggregateSiaAndFdOdds,
} from "./oddsAggregator.ts";
import {
  upsertFixture,
  insertOddsSnapshot,
  getScrapableFixtures,
  updateFixtureStatus,
  markStartedFixtures,
} from "../db/nbaRepositories.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";
import { SiaFixture, FixtureRow } from "../config/types.ts";
import { sseManager } from "./sseManager.ts";

export class Scheduler {
  private activeJobs: schedule.Job[];
  // Stores fixture dat
  private activeFixtures: Map<number, FixtureRow>;
  private scrapeInterval: ReturnType<typeof setInterval> | null;

  constructor() {
    this.activeJobs = [];
    this.activeFixtures = new Map();
    this.scrapeInterval = null;
  }

  addJob(time: Date, callback: () => void): schedule.Job {
    const job = schedule.scheduleJob(time, callback);
    this.activeJobs.push(job);
    return job;
  }

  isScrapingFixture(fixtureId: number): boolean {
    return this.activeFixtures.has(fixtureId);
  }

  addFixture(fixtureRow: FixtureRow): void {
    this.activeFixtures.set(fixtureRow.fixture_id, fixtureRow);
  }

  // If no more fixtures to scrape, stop the shared interval
  removeFixture(fixtureId: number): void {
    this.activeFixtures.delete(fixtureId);
    if (this.activeFixtures.size === 0) this.stopScrapeInterval();
  }

  getActiveFixtures(): FixtureRow[] {
    return Array.from(this.activeFixtures.values());
  }

  startScrapeInterval(interval: number, callback: () => void): void {
    if (this.scrapeInterval) return;
    this.scrapeInterval = setInterval(callback, interval);
  }

  stopScrapeInterval(): void {
    if (this.scrapeInterval) {
      clearInterval(this.scrapeInterval);
      this.scrapeInterval = null;
    }
  }

  shutdown(): void {
    this.activeJobs.forEach((job) => job.cancel());
    this.activeJobs = [];
    this.activeFixtures.clear();
    this.stopScrapeInterval();
  }
}
Map<number, FixtureRow>
/**
 * Initializes the daily scheduler. Runs immediately on startup to catch up
 * after any downtime, then runs hourly (6AM-11PM) to pick up reschedules or cancellations.
 */
export const initDailyScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
  sport: string,
): Promise<void> => {
  // Run as soon as server server starts so that if server shutdown, we can just fetch asap
  await fetchAndSchedule(db, siaService, fdService, scheduler, sport);
  // We then run it hourly just to make sure we get any re-schedules, cancellations, etc.
  cron.schedule("0 6-23 * * *", () =>
    fetchAndSchedule(db, siaService, fdService, scheduler, sport),
  );
};

/**
 * Fetches today's fixtures from SIA, saves them to the database,
 * and kicks off the scraping scheduler for each game.
 */
const fetchAndSchedule = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
  sport: string,
): Promise<void> => {
  try {
    await markStartedFixtures(db, sport);
    const fixtures: SiaFixture[] = await siaService.getFixtures(
      SIA_URLS.nba.fixtures,
    );

    // Just exit if there are no NBA games today
    if (fixtures.length === 0) {
      logger.info("No NBA games today, skipping");
      return;
    }

    // save each fixture to db
    for (const fixture of fixtures) {
      await upsertFixture(db, fixture.id, fixture, fixture.startDate, sport);
    }

    await initScrapingScheduler(db, siaService, fdService, scheduler, sport);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { error: errorMessage },
      "Hourly fixture fetch failed, go to initDailyScheduler",
    );
  }
};

/**
 * For each open fixture today, schedules a scraper to start 2 hours before game time.
 * If the scraping window is already active (less than 2 hours to game), starts immediately.
 * Skips fixtures that are already being scraped.
 */
const initScrapingScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
  sport: string,
): Promise<void> => {
  try {
    const fixturesFromDb: FixtureRow[] = await getScrapableFixtures(db, sport);

    // Skip scraping scheduling if no games today
    if (fixturesFromDb.length === 0) {
      logger.info("No NBA games today, skipping scraping scheduler");
      return;
    }

    const timeNow = new Date();

    // For each game, schedule a scraper every 5 minute to save odds to db
    fixturesFromDb.forEach((fixtureRow: FixtureRow) => {
      const fixtureId = fixtureRow.fixture_id;

      // Check if the fixture is already being scraped. If so, we just skip it.
      if (scheduler.isScrapingFixture(fixtureId)) return;

      const gameTime = new Date(fixtureRow.start_date);

      // No need to scrape when the time now is already past game time or is game time
      if (gameTime <= timeNow) return;

      const twoHoursInMs = 2 * 60 * 60 * 1000;
      const scrapeTime = new Date(gameTime.getTime() - twoHoursInMs);
      const scrapeInteval = 60 * 5000; // 5 minutes

      // If the time now is within the scrapTime and gameTime, we must scrape now since the window for scraping is currently active
      if (scrapeTime <= timeNow) {
        startScraping(
          db,
          fixtureRow,
          scrapeInteval,
          siaService,
          fdService,
          scheduler,
        );
      } else {
        // We schedule scraping later if the scrape window is still not hit
        scheduler.addJob(scrapeTime, () => {
          startScraping(
            db,
            fixtureRow,
            scrapeInteval,
            siaService,
            fdService,
            scheduler,
          );
        });
      }
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { error: errorMessage },
      "Failed to initialize scraping scheduler",
    );
  }
};

/**
 * Starts the 5-minute interval scraper for a fixture.
 * Also schedules a job at game time to stop scraping and mark the fixture as closed.
 */
// NEW startScraping — just registers fixture, starts shared interval if not running
const startScraping = (
  db: Database,
  fixtureRow: FixtureRow,
  interval: number,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
): void => {
  const fixtureId = fixtureRow.fixture_id;
  const gameTime = new Date(fixtureRow.start_date);

  // Add this fixture to the active set
  scheduler.addFixture(fixtureRow);

  // Start the shared interval if it's not already running
  // This callback scrapes ALL active fixtures each tick
  scheduler.startScrapeInterval(interval, async () => {
    await scrapeAllFixtures(db, siaService, fdService, scheduler);
  });

  // Schedule stop at game time
  scheduler.addJob(gameTime, async () => {
    scheduler.removeFixture(fixtureId);
    await updateFixtureStatus(db, fixtureId, "close");
    logger.info({ fixtureId, gameTime }, "Game started, stopped scraping");
  });

  logger.info({ fixtureId, gameTime }, "Started scraping fixture");
};

/**
 * Fetches odds from both SIA and FanDuel, filters to matching lines,
 * normalizes (removes vig), and saves the snapshot to the database.
 */
const updateOddsToDb = async (
  db: Database,
  fixtureId: number,
  fixture: SiaFixture,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
): Promise<number | null> => {
  try {
    const aggregatedOdds = await aggregateSiaAndFdOdds(
      fixtureId,
      fixture,
      siaService,
      fdService,
    );

    if (!aggregatedOdds) {
      logger.info(
        { fixtureId },
        "Skipping saving to db since there is no aggregated odds available",
      );
      return null;
    }

    const filteredOdds = filterSameLines(aggregatedOdds);
    const normalizedOdds = normalizeOdds(filteredOdds);
    await insertOddsSnapshot(db, fixtureId, normalizedOdds);

    logger.info({ fixtureId }, "updated odds for fixture");
    return fixtureId; // Return instead of notifying SSE
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { fixtureId, error: errorMessage },
      "Failed to update odds for this fixture",
    );
    return null;
  }
};

// NEW — scrapes all active fixtures, sends one batched SSE event
const scrapeAllFixtures = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
): Promise<void> => {
  const activeFixtures = scheduler.getActiveFixtures();
  logger.info({ count: activeFixtures.length }, "Scraping all active fixtures");
  if (activeFixtures.length === 0) return;

  // Scrape all fixtures concurrently
  const results = await Promise.allSettled(
    activeFixtures.map((fixtureRow) =>
      updateOddsToDb(
        db,
        fixtureRow.fixture_id,
        fixtureRow.raw_data as SiaFixture,
        siaService,
        fdService,
      ),
    ),
  );

  // Collect fixture IDs that succeeded
  const updatedFixtureIds: number[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      updatedFixtureIds.push(activeFixtures[index].fixture_id);
    }
  });

  // One SSE event with all updated fixtures
  if (updatedFixtureIds.length > 0) {
    sseManager.notifyBatchUpdate(updatedFixtureIds);
  }
};
