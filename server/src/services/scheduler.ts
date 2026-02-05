import schedule from "node-schedule";
import cron from "node-cron";
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

export const initDailyFixtureFetcher = async (
  db: Database,
  siaService: SiaApiService,
) => {
  const job = cron.schedule("0 6-23 * * *", async () => {
    try {
      // Find out the date today
      const dateToday = new Date().toISOString().split("T")[0];
      // Check if we already have the fixtures today on db
      const existingFixturesFromDb = await getNbaFixturesFromDb(db, dateToday);

      // Just do nothing if we already have the fixtures on db
      if (existingFixturesFromDb.length > 0) {
        console.log("Fixtures already fetched for today, skipping...");
        return;
      }

      const fixtures = await siaService.getFixtures(SIA_URLS.nba.fixtures);

      // Just exit if there are no NBA games today
      if (fixtures.length === 0) {
        console.log("No NBA games today, skipping...");
        return;
      }

      // save each fixture to db
      for (const fixture of fixtures) {
        await upsertFixture(db, fixture.id, fixture, fixture.startDate);
      }

      // Once we save the fixtures to db, stop the cron job, so we do not continue on the hourly job
      job.stop();

      // Since the cron job has been stopped, we need to restart it again for tomorrow
      scheduleRestartForTomorrow(job);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error("Hourly fixture fetch failed:", errorMessage);
    }
  });
};

const scheduleRestartForTomorrow = (job: any) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(6, 0, 0, 0);

  const timeUntilTomorrow = tomorrow.getTime() - Date.now();

  setTimeout(() => {
    job.start();
  }, timeUntilTomorrow);
};

export const initScrapingScheduler = async (
  db: Database,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
) => {
  const dateToday = new Date().toISOString().split("T")[0];

  try {
    const fixturesFromDb = await getNbaFixturesFromDb(db, dateToday);

    // Skip scraping scheduling if no games today
    if (fixturesFromDb.length === 0) {
      console.log("No NBA games today, skipping scraping scheduler");
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
      );
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Failed to initialize scraping scheduler:", errorMessage);
  }
};

const scheduleOddsScraper = (
  scrapeTime: Date,
  db: Database,
  fixtureRow: any,
  interval: number,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
) => {
  const gameTime = new Date(fixtureRow.start_date);

  schedule.scheduleJob(scrapeTime, () => {
    const scrapeInterval = setInterval(async () => {
      await updateOddsToDb(
        db,
        fixtureRow.fixture_id,
        JSON.parse(fixtureRow.fixture_data),
        siaService,
        fdService,
      );
    }, interval);

    schedule.scheduleJob(gameTime, () => {
      clearInterval(scrapeInterval);
      console.log(
        `Game started, stopped scraping fixture ${fixtureRow.fixture_id}`,
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
      console.log(
        `No odds available for fixture ${fixtureId}, skipping saving to db.`,
      );
      return;
    }
    const filteredOdds = filterSameLines(aggregatedOdds);
    const normalizedOdds = normalizeOdds(filteredOdds);
    await upsertOdds(db, fixtureId, normalizedOdds);

    console.log(`Updated odds for fixture ${fixtureId}`);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(
      `Failed to update odds for fixture ${fixtureId}:`,
      errorMessage,
    );
  }
};
