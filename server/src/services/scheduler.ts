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
  getNbaFixturesFromDb,
  upsertOdds,
} from "../db/nbaRepositories.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";

export class Scheduler {
  private activeIntervals: ReturnType<typeof setInterval>[];
  private activeJobs: schedule.Job[];

  constructor() {
    this.activeIntervals = [];
    this.activeJobs = [];
  }

  addInterval(
    callback: () => void,
    interval: number,
  ): ReturnType<typeof setInterval> {
    const id = setInterval(callback, interval);
    this.activeIntervals.push(id);
    return id;
  }

  addJob(time: Date, callback: () => void): schedule.Job {
    const job = schedule.scheduleJob(time, callback);
    this.activeJobs.push(job);
    return job;
  }

  shutdown(): void {
    this.activeIntervals.forEach((i) => clearInterval(i));
    this.activeJobs.forEach((j) => j.cancel());
    this.activeIntervals = [];
    this.activeJobs = [];
  }
}

export const initDailyScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  const job = cron.schedule("0 6-23 * * *", async () => {
    try {
      // Check if we already have the fixtures today on db
      const existingFixturesFromDb = await getNbaFixturesFromDb(db);

      // Just do nothing if we already have the fixtures on db
      if (existingFixturesFromDb.length > 0) {
        console.log("Fixtures already fetched for today, skipping...");
        return;
      }

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
  });
};

const initScrapingScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  try {
    const fixturesFromDb = await getNbaFixturesFromDb(db);

    // Skip scraping scheduling if no games today
    if (fixturesFromDb.length === 0) {
      logger.info("No NBA games today, skipping scraping scheduler");
      return;
    }

    // For each game, schedule a scraper every 5 minute to save odds to db
    fixturesFromDb.forEach((fixtureRow: any) => {
      const gameTime = new Date(fixtureRow.start_date);
      const twoHoursInMilliseconds = 2 * 60 * 60 * 1000;
      const scrapeTime = new Date(gameTime.getTime() - twoHoursInMilliseconds);
      const scrapeInteval = 60 * 5000; // 5 minutes
      // We schedule our scrapers 2 hours before game time since sharp money tend to flow during that time
      scheduleOddsScraper(
        scrapeTime,
        db,
        fixtureRow,
        scrapeInteval,
        siaService,
        fdService,
        scheduler,
      );
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { error: errorMessage },
      "Failed to initialize scraping scheduler",
    );
  }
};

const scheduleOddsScraper = (
  scrapeTime: Date,
  db: Database,
  fixtureRow: any,
  interval: number,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
  scheduler: Scheduler,
) => {
  const gameTime = new Date(fixtureRow.start_date);

  scheduler.addJob(scrapeTime, () => {
    const scrapeInterval = scheduler.addInterval(async () => {
      await updateOddsToDb(
        db,
        fixtureRow.fixture_id,
        JSON.parse(fixtureRow.fixture_data),
        siaService,
        fdService,
      );
    }, interval);

    scheduler.addJob(gameTime, () => {
      clearInterval(scrapeInterval);
      logger.info(
        { gameTime, fixtureId: fixtureRow.fixture_id },
        "Game has started, stopped scraping the fixture",
      );
    });
  });
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
      logger.info({ fixtureId }, "Skipping saving to db since there is no aggregated odds available")
      return;
    }
    const filteredOdds = filterSameLines(aggregatedOdds);
    const normalizedOdds = normalizeOdds(filteredOdds);
    await upsertOdds(db, fixtureId, normalizedOdds);

    logger.info({ fixtureId }, "updated odds for fixture")
    
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error({ fixtureId, error: errorMessage }, "Failed to update odds for this fixture")

  }
};
