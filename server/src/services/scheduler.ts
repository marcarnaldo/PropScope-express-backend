/**
 * Scheduler Service
 *
 * Manages the lifecycle of odds scraping for NBA games.
 * - Fetches fixtures from SIA hourly (6AM-11PM)
 * - Schedules scraping to start 2 hours before each game
 * - Scrapes odds every 5 minutes until game time using concurrent tab pool
 * - Checks browser health once per scrape cycle, recovers if needed
 * - Stops scraping and marks fixture as "close" when the game starts
 * - Sends one batched SSE event per cycle to notify connected clients
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
  // Stores fixture data for all games currently being scraped
  private activeFixtures: Map<number, FixtureRow>;
  // Single shared interval that scrapes all active fixtures each tick
  private scrapeInterval: ReturnType<typeof setInterval> | null;

  constructor() {
    this.activeJobs = [];
    this.activeFixtures = new Map();
    this.scrapeInterval = null;
  }

  /** Schedules a one-time job at a specific time (e.g. 2hrs before game, or at game time). */
  addJob(time: Date, callback: () => void): schedule.Job {
    const job = schedule.scheduleJob(time, callback);
    this.activeJobs.push(job);
    return job;
  }

  /** Returns true if the fixture is already being actively scraped. */
  isScrapingFixture(fixtureId: number): boolean {
    return this.activeFixtures.has(fixtureId);
  }

  /** Registers a fixture for scraping. */
  addFixture(fixtureRow: FixtureRow): void {
    this.activeFixtures.set(fixtureRow.fixture_id, fixtureRow);
  }

  /** Removes a fixture from scraping. Stops the shared interval if no fixtures remain. */
  removeFixture(fixtureId: number): void {
    this.activeFixtures.delete(fixtureId);
    if (this.activeFixtures.size === 0) this.stopScrapeInterval();
  }

  /** Returns all fixtures currently being scraped. */
  getActiveFixtures(): FixtureRow[] {
    return Array.from(this.activeFixtures.values());
  }

  /**
   * Starts the shared scrape interval if not already running.
   * Runs the callback immediately on start, then every `interval` ms.
   * Only one interval exists at a time — all fixtures share it.
   */
  startScrapeInterval(interval: number, callback: () => void): void {
    if (this.scrapeInterval) return;
    callback();
    this.scrapeInterval = setInterval(callback, interval);
  }

  /** Stops the shared scrape interval. */
  stopScrapeInterval(): void {
    if (this.scrapeInterval) {
      clearInterval(this.scrapeInterval);
      this.scrapeInterval = null;
    }
  }

  /** Cancels all scheduled jobs, clears active fixtures, and stops the scrape interval. */
  shutdown(): void {
    this.activeJobs.forEach((job) => job.cancel());
    this.activeJobs = [];
    this.activeFixtures.clear();
    this.stopScrapeInterval();
  }
}

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
  // Run as soon as server starts so that if server shutdown, we can just fetch asap
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

    // Save each fixture to db
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

    // For each game, schedule a scraper every 5 minutes to save odds to db
    fixturesFromDb.forEach((fixtureRow: FixtureRow) => {
      const fixtureId = fixtureRow.fixture_id;

      // Check if the fixture is already being scraped. If so, we just skip it.
      if (scheduler.isScrapingFixture(fixtureId)) return;

      const gameTime = new Date(fixtureRow.start_date);

      // No need to scrape when the time now is already past game time or is game time
      if (gameTime <= timeNow) return;

      const twoHoursInMs = 2 * 60 * 60 * 1000;
      const scrapeTime = new Date(gameTime.getTime() - twoHoursInMs);
      const scrapeInterval = 60 * 5000; // 5 minutes

      // If the time now is within the scrapeTime and gameTime, we must scrape now since the window for scraping is currently active
      if (scrapeTime <= timeNow) {
        startScraping(
          db,
          fixtureRow,
          scrapeInterval,
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
            scrapeInterval,
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
 * Registers a fixture for scraping and starts the shared interval if not already running.
 * Also schedules a job at game time to stop scraping and mark the fixture as closed.
 */
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

  // Start the shared interval if it's not already running.
  // This callback scrapes ALL active fixtures each tick.
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
 * Fetches odds from both SIA and FanDuel for a single fixture,
 * filters to matching lines, normalizes (removes vig),
 * and saves the snapshot to the database.
 * Returns the fixtureId on success, null on failure.
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

    logger.info({ fixtureId }, "Updated odds for fixture");
    return fixtureId;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { fixtureId, error: errorMessage },
      "Failed to update odds for this fixture",
    );
    return null;
  }
};

/**
 * Scrapes all active fixtures concurrently, then sends one batched SSE event.
 *
 * Flow per cycle:
 * 1. Check browser health — reinitialize if the browser is unresponsive
 * 2. Scrape all fixtures in parallel via Promise.allSettled (each gets its own browser tab from the pool)
 * 3. Collect successful fixture IDs
 * 4. Send a single SSE event with all updated fixture IDs to notify connected clients
 */
const scrapeAllFixtures = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
): Promise<void> => {
  const activeFixtures = scheduler.getActiveFixtures();
  if (activeFixtures.length === 0) return;

  const healthy = await siaService.isBrowserHealthy();
  if (!healthy) {
    logger.warn("Browser unhealthy, reinitializing before scrape cycle");
    await siaService.close();
    await siaService.initialize();
    logger.info("Browser reinitialization successful");
  }

  // Scrape all fixtures concurrently — each acquires its own tab from the page pool
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