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

export class Scheduler {
  private activeJobs: schedule.Job[];
  private activeScrapes: Map<number, ReturnType<typeof setInterval>>;

  constructor() {
    this.activeJobs = [];
    this.activeScrapes = new Map();
  }

  addJob(time: Date, callback: () => void): schedule.Job {
    const job = schedule.scheduleJob(time, callback);
    this.activeJobs.push(job);
    return job;
  }

  isScrapingFixture(fixtureId: number): boolean {
    return this.activeScrapes.has(fixtureId);
  }

  addScrape(
    fixtureId: number,
    intervalId: ReturnType<typeof setInterval>,
  ): void {
    this.activeScrapes.set(fixtureId, intervalId);
  }

  removeScrape(fixtureId: number): void {
    const intervalId = this.activeScrapes.get(fixtureId);
    if (intervalId) {
      clearInterval(intervalId);
      this.activeScrapes.delete(fixtureId);
    }
  }

  shutdown(): void {
    this.activeJobs.forEach((job) => job.cancel());
    this.activeJobs = [];
    this.activeScrapes.clear();
  }
}

export const initDailyScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  // Run as soon as server server starts so that if server shutdown, we can just fetch asap
  await fetchAndSchedule(db, siaService, fdService, scheduler)
  // We then run it hourly just to make sure we get any re-schedules, cancellations, etc.
  cron.schedule("0 6-23 * * *", () => fetchAndSchedule(db, siaService, fdService, scheduler));
};

const fetchAndSchedule = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  try {
    await markStartedFixtures(db);
    const fixtures = await siaService.getFixtures(SIA_URLS.nba.fixtures);

    // Just exit if there are no NBA games today
    if (fixtures.length === 0) {
      logger.info("No NBA games today, skipping");
      return;
    }

    // save each fixture to db
    for (const fixture of fixtures) {
      await upsertFixture(db, fixture.id, fixture, fixture.startDate);
    }

    await initScrapingScheduler(db, siaService, fdService, scheduler);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { error: errorMessage },
      "Hourly fixture fetch failed, go to initDailyScheduler",
    );
  }
};

const initScrapingScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  try {
    const fixturesFromDb = await getScrapableFixtures(db);

    // Skip scraping scheduling if no games today
    if (fixturesFromDb.length === 0) {
      logger.info("No NBA games today, skipping scraping scheduler");
      return;
    }

    const timeNow = new Date();

    // For each game, schedule a scraper every 5 minute to save odds to db
    fixturesFromDb.forEach((fixtureRow: any) => {
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

const startScraping = (
  db: Database,
  fixtureRow: any,
  interval: number,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  const fixtureId = fixtureRow.fixture_id;
  const gameTime = new Date(fixtureRow.start_date);

  const scrapeIntervalId = setInterval(async () => {
    await updateOddsToDb(
      db,
      fixtureId,
      JSON.parse(fixtureRow.raw_data),
      siaService,
      fdService,
    );
  }, interval);

  scheduler.addScrape(fixtureId, scrapeIntervalId);

  scheduler.addJob(gameTime, async () => {
    scheduler.removeScrape(fixtureId);
    await updateFixtureStatus(db, fixtureId, "close")
    logger.info({ fixtureId, gameTime }, "Game started, stopped scraping");
  });

  logger.info({ fixtureId, gameTime }, "Started scraping fixture");
};

const updateOddsToDb = async (
  db: Database,
  fixtureId: number,
  fixture: any,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
) => {
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
      return;
    }
    const filteredOdds = filterSameLines(aggregatedOdds);
    const normalizedOdds = normalizeOdds(filteredOdds);
    await insertOddsSnapshot(db, fixtureId, normalizedOdds);

    logger.info({ fixtureId }, "updated odds for fixture");
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { fixtureId, error: errorMessage },
      "Failed to update odds for this fixture",
    );
  }
};
