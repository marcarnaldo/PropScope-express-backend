import schedule from "node-schedule";
import cron from "node-cron";
import { getFixtures } from "../api/siaApi.ts";
import { SIA_URLS } from "../config/siaConstants.ts";
import {
  connectDb,
  getNbaFixturesFromDb,
  getNbaNormalizedOdds,
  upsertFixture,
  upsertOdds,
} from "../db/database.ts";
import { filterSameLines, aggregateOdds, normalizeOdds } from "./services.ts";

connectDb();

// Daily schedule to fetch nba fixtures from sia api
export const initFetchAndSaveNewFixtureToDb = () => {
  // Fetch fixtures everyday at 8:00 A.M
  cron.schedule("0 8 * * *", async () => {
    const fixtures = await getFixtures(SIA_URLS.nba.fixtures);
    // Find out the earliest game time
    let earliestGameTime: Date | undefined;

    // Save each fixture to db
    fixtures.forEach((fixture: any) => {
      const gameTime = new Date(fixture.startDate);
      upsertFixture(fixture.id, fixture, fixture.startDate);

      if (!earliestGameTime) earliestGameTime = gameTime;
      if (gameTime < earliestGameTime) earliestGameTime = gameTime;
    });

    // Our minute by minute scraping will start at this time so we must stop fetching the fixtures
    let stopTime = new Date(earliestGameTime!.getTime() - 2 * 60 * 60 * 1000);

    // We refetch the fixtures every 2 hours after the initial fetch just incase the league decided to reschedule. It is very rare for the leauge to reschedule or cancel games once a game starts in that day.
    const updateInterval = setInterval(
      async () => {
        const now = new Date();
        const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

        // Need to clear earliest game time just in case there is a new earliest game time in the event of a rescheduled game
        earliestGameTime = undefined;

        // While we are still away from stop time, keep refetching every 2 hours
        const reFetchedFixtures = await getFixtures(SIA_URLS.nba.fixtures);
        reFetchedFixtures.forEach((fixture: any) => {
          const gameTime = new Date(fixture.startDate);
          upsertFixture(fixture.id, fixture, fixture.startDate);

          if (!earliestGameTime) earliestGameTime = gameTime;
          if (gameTime < earliestGameTime!) earliestGameTime = gameTime;
        });

        stopTime = new Date(earliestGameTime!.getTime() - 2 * 60 * 60 * 1000);

        // Check if 2 hours from now go over stop time or right at it. We must stop when that happens. No need to refetch since we are going to do the minute by minute scraping
        if (twoHoursFromNow >= stopTime) {
          clearInterval(updateInterval);
          return;
        }
      },
      2 * 60 * 60 * 1000,
    );
  });
};

export const initMinuteScrapingScheduler = (io: any) => {
  // Look at db at 8:01 A.M
  cron.schedule("1 8 * * *", () => {
    // Separate the time and date and only get date
    const dateToday = new Date().toISOString().split("T")[0];

    let fixturesFromDb = getNbaFixturesFromDb(dateToday);
    const gameDates = fixturesFromDb.map((data: any) => data.start_date);

    const sortedDates = gameDates
      .map((row: string) => new Date(row))
      .sort((a, b) => a.getTime() - b.getTime());

    let earliestSchedule = sortedDates[0];
    let isChanged: boolean;

    const checkIfScheduleChanged = () => {
      const scrapeTime = new Date(
        earliestSchedule.getTime() - 2 * 60 * 60 * 1000,
      );

      schedule.scheduleJob(scrapeTime, () => {
        fixturesFromDb = getNbaFixturesFromDb(dateToday);

        const currentGameDates = fixturesFromDb.map(
          (data: any) => data.start_date,
        );

        const currentSortedGameDates = currentGameDates
          .map((row) => new Date(row))
          .sort((a, b) => a.getTime() - b.getTime());

        const currentEarliest = currentSortedGameDates[0];

        // If the game time is not the same as the one we got earlier at 8:01 A.M we check again later 2 hours before the new time
        if (currentEarliest.getTime() !== earliestSchedule.getTime()) {
          earliestSchedule = currentEarliest;
          isChanged = true;
          checkIfScheduleChanged();
        } else {
          fixturesFromDb.forEach((data: any) => {
            const fixtureScrapeTime = new Date(
              new Date(data.start_date).getTime() - 2 * 60 * 60 * 1000,
            );
            schedule.scheduleJob(fixtureScrapeTime, () => {
              const scrapeInterval = setInterval(async () => {
                await updateOddsToDb(
                  data.fixture_id,
                  JSON.parse(data.fixture_data),
                );

                const normalizedOdds = getNbaNormalizedOdds();
                const parsed = normalizedOdds.map((odds: any) => ({
                  ...odds,
                  odds_data: JSON.parse(odds.odds_data),
                }));
                // Need to emit (send) here so that every time we scrape, we are sending updates to all connected clients
                io.emit("oddsUpdate", parsed);
              }, 60 * 5000); // Interval is every 5 minutes

              // We need to stop scraping once gameTime has been hit since sportsbooks locks away the pregame props
              schedule.scheduleJob(new Date(data.start_date), () => {
                clearInterval(scrapeInterval);
                console.log("Game started, stopped scraping");
              });
            });
          });
        }
      });
    };
    checkIfScheduleChanged();
  });
};

const updateOddsToDb = async (fixtureId: number, fixture: any) => {
  const aggregatedOdds = await aggregateOdds(fixtureId, fixture);
  const filteredOdds = filterSameLines(aggregatedOdds);
  const normalizedOdds = normalizeOdds(filteredOdds);
  upsertOdds(fixtureId, normalizedOdds);
};
