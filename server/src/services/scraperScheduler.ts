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
import { logger, MAX_RETRIES } from "../utils/errorHandling.ts";
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
  private pendingFirstScrape: ReturnType<typeof setTimeout> | null = null;
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
    logger.info(
      { fixtureId, remainingFixtures: this.activeFixtures.size },
      "Removed fixture from active scraping",
    );
    if (this.activeFixtures.size === 0) this.stopScrapeInterval();
  }

  /** Returns all fixtures currently being scraped. */
  getActiveFixtures(): FixtureRow[] {
    return Array.from(this.activeFixtures.values());
  }

  /**
   * Starts the shared scrape interval if not already running.
   * Debounces the first scrape by 3 seconds so that fixtures
   * scheduled at the same time all get registered before the
   * first cycle runs. After that, scrapes every `interval` ms.
   * Only one interval exists at a time — all fixtures share it.
   */
  startScrapeInterval(interval: number, callback: () => void): void {
    if (this.scrapeInterval) return;
    this.scrapeInterval = setInterval(callback, interval);

    // Debounce the first scrape so all fixtures register first
    if (this.pendingFirstScrape) clearTimeout(this.pendingFirstScrape);
    this.pendingFirstScrape = setTimeout(() => {
      this.pendingFirstScrape = null;
      callback();
    }, 3000);
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

let retryInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initializes the daily scheduler. Runs immediately on startup to catch up
 * after any downtime. Runs daily at 8:00 A.M to fetch for new games.
 * If the fetch fails, retries every 15 minutes until it succeeds.
 */
export const initDailyScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
  sport: string,
): Promise<void> => {
  const attemptFetch = async () => {
    const success = await fetchAndSchedule(
      db,
      siaService,
      fdService,
      scheduler,
      sport,
    );
    if (success && retryInterval) {
      clearInterval(retryInterval);
      retryInterval = null;
      logger.info("Daily fetch succeeded, stopped retrying");
    }
  };

  // Run immediately on startup, retry every 15 min if it fails
  const success = await fetchAndSchedule(
    db,
    siaService,
    fdService,
    scheduler,
    sport,
  );
  if (!success) {
    retryInterval = setInterval(attemptFetch, 15 * 60 * 1000);
  }

  // Daily at 8 AM, start fresh attempt cycle
  cron.schedule(
    "0 8 * * *",
    async () => {
      const success = await fetchAndSchedule(
        db,
        siaService,
        fdService,
        scheduler,
        sport,
      );
      if (!success && !retryInterval) {
        retryInterval = setInterval(attemptFetch, 15 * 60 * 1000);
      }
    },
    { timezone: "America/Vancouver" },
  );
};

/**
 * Fetches today's fixtures from SIA, saves them to the database,
 * and kicks off the scraping scheduler for each game.
 * Returns true on success, false on failure.
 */
const fetchAndSchedule = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
  sport: string,
): Promise<boolean> => {
  try {
    await markStartedFixtures(db, sport);
    // Initialize the browser only when needed
    logger.info("Initializing browser to fetch fixtures");
    await siaService.initialize();
    const fixtures: SiaFixture[] = await siaService.getFixtures(
      SIA_URLS.nba.fixtures,
    );
    // Close the browser once done
    logger.info("Closing browser after fetching fixtures");
    await siaService.close();

    // Just exit if there are no NBA games today
    if (fixtures.length === 0) {
      logger.info("No NBA games today, skipping");
      return true;
    }

    logger.info(
      { fixtureCount: fixtures.length },
      "Fetched today's NBA fixtures from Sports Interaction",
    );

    // Save each fixture to db
    for (const fixture of fixtures) {
      await upsertFixture(db, fixture.id, fixture, fixture.startDate, sport);
    }

    await initScrapingScheduler(db, siaService, fdService, scheduler, sport);
    return true;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { error: errorMessage },
      "Daily fixture fetch failed, retrying in 15 minutes",
    );
    // Make sure browser is closed even if something fails
    await siaService.close();
    return false;
  }
};

/**
 * For each open fixture today, schedules a scraper to start 1 hours before game time.
 * If the scraping window is already active (less than 1 hours to game), starts immediately.
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
    for (const fixtureRow of fixturesFromDb) {
      const fixtureId = fixtureRow.fixture_id;

      // Check if the fixture is already being scraped. If so, we just skip it.
      if (scheduler.isScrapingFixture(fixtureId)) {
        logger.info({ fixtureId }, "Fixture already being scraped, skipping");
        continue;
      }

      const gameTime = new Date(fixtureRow.start_date);

      // No need to scrape when the time now is already past game time or is game time
      if (gameTime <= timeNow) {
        logger.info(
          { fixtureId, gameTime },
          "Game time already passed, skipping",
        );
        continue;
      }

      const oneHourInMs = 60 * 60 * 1000; // 1 hour
      const scrapeTime = new Date(gameTime.getTime() - oneHourInMs);
      const scrapeInterval = 5 * 60 * 1000; // 5 minutes

      // If the time now is within the scrapeTime and gameTime, we must scrape now since the window for scraping is currently active
      if (scrapeTime <= timeNow) {
        logger.info(
          { fixtureId, gameTime },
          "Scrape window already active, starting immediately",
        );
        await startScraping(
          db,
          fixtureRow,
          scrapeInterval,
          siaService,
          fdService,
          scheduler,
        );
      } else {
        // We schedule scraping later if the scrape window is still not hit
        scheduler.addJob(scrapeTime, async () => {
          try {
            await startScraping(
              db,
              fixtureRow,
              scrapeInterval,
              siaService,
              fdService,
              scheduler,
            );
          } catch (error) {
            logger.error(
              { fixtureId, error: getErrorMessage(error) },
              "Failed to start scheduled scraping",
            );
          }
        });
        logger.info(
          { fixtureId, scrapeTime, gameTime },
          "Scheduled scraping for later",
        );
      }
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { error: errorMessage },
      "Failed to initialize scraping scheduler",
    );
  }
};

let browserInitializing = false;
/**
 * Registers a fixture for scraping and starts the shared interval if not already running.
 * Also schedules a job at game time to stop scraping and mark the fixture as closed.
 */
const startScraping = async (
  db: Database,
  fixtureRow: FixtureRow,
  interval: number,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
): Promise<void> => {
  const fixtureId = fixtureRow.fixture_id;
  const gameTime = new Date(fixtureRow.start_date);

  // Launch browser only when a fixture needs scraping
  if (scheduler.getActiveFixtures().length === 0) {
    if (browserInitializing) {
      // Another fixture is already initializing — wait for it
      while (browserInitializing) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } else {
      browserInitializing = true;
      try {
        logger.info("No active fixtures yet — initializing browser");
        await siaService.initialize();
      } finally {
        browserInitializing = false;
      }
    }
  }

  scheduler.addFixture(fixtureRow);
  logger.info(
    { fixtureId, activeCount: scheduler.getActiveFixtures().length },
    "Added fixture to active scraping",
  );

  scheduler.startScrapeInterval(interval, async () => {
    await scrapeAllFixtures(db, siaService, fdService, scheduler);
  });

  // Schedule stop at game time
  scheduler.addJob(gameTime, async () => {
    try {
      scheduler.removeFixture(fixtureId);
      await updateFixtureStatus(db, fixtureId, "close");
      logger.info({ fixtureId, gameTime }, "Game started, stopped scraping");

      if (scheduler.getActiveFixtures().length === 0) {
        logger.info("No active fixtures remaining — closing browser");
        await siaService.close();
      }
    } catch (error) {
      logger.error(
        { fixtureId, error: getErrorMessage(error) },
        "Failed to stop scraping at game time",
      );
    }
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
  logger.info({ fixtureId }, "Starting odds update for fixture");
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
    const normalizedOdds = await normalizeOdds(filteredOdds);
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
 * 1. Validate SIA session with a real request — reinitialize if stale
 * 2. Scrape all fixtures in parallel via Promise.allSettled
 * 3. If ALL fixtures failed, reinit browser (up to 3 attempts) and retry once
 * 4. Collect successful fixture IDs
 * 5. Send a single SSE event with all updated fixture IDs to notify connected clients
 */
const scrapeAllFixtures = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
): Promise<void> => {
  const activeFixtures = scheduler.getActiveFixtures();
  if (activeFixtures.length === 0) {
    logger.info("No active fixtures to scrape, skipping cycle");
    return;
  }

  // Validate SIA session with a real request
  const healthy = await siaService.isBrowserHealthy();
  if (!healthy) {
    logger.warn("SIA session invalid, reinitializing before scrape cycle");
    const reinitSuccess = await reinitBrowser(siaService);
    if (!reinitSuccess) return;
  }

  // Scrape all fixtures concurrently — each acquires its own tab from the page pool
  let results = await Promise.allSettled(
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

  if (updatedFixtureIds.length === 0 && activeFixtures.length > 0) {
    logger.warn(
      { fixtureCount: activeFixtures.length },
      "All fixtures failed — reinitializing browser and retrying once",
    );

    const reinitSuccess = await reinitBrowser(siaService);

    if (!reinitSuccess) {
      logger.error("Skipping scrape cycle — browser reinitialization failed");
      return;
    }

    results = await Promise.allSettled(
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

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) {
        updatedFixtureIds.push(activeFixtures[index].fixture_id);
      }
    });

    logger.info(
      { succeeded: updatedFixtureIds.length, total: activeFixtures.length },
      "Retry after reinit complete",
    );
  }

  // One SSE event with all updated fixtures
  if (updatedFixtureIds.length > 0) {
    sseManager.notifyBatchUpdate(updatedFixtureIds);
  }
  logger.info(
    {
      total: activeFixtures.length,
      succeeded: updatedFixtureIds.length,
      failed: activeFixtures.length - updatedFixtureIds.length,
    },
    "Scrape cycle complete",
  );
};

/**
 * Closes and reinitializes the browser with retry.
 * Each attempt launches a fresh proxy session (new IP) to avoid blocked IPs.
 * Returns true on success, false if all attempts fail.
 */
const reinitBrowser = async (siaService: SiaApiService): Promise<boolean> => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await siaService.close();
      await siaService.initialize();
      logger.info({ attempt }, "Browser reinitialization successful");
      return true;
    } catch (error) {
      logger.warn(
        { attempt, maxRetries: MAX_RETRIES, error: getErrorMessage(error) },
        "Browser reinitialization attempt failed",
      );
      if (attempt === MAX_RETRIES) break;
    }
  }
  logger.error("All browser reinitialization attempts failed, skipping scrape cycle");
  return false;
};
