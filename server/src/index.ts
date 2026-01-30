import express from "express";
import "dotenv/config";
import { initBrowser, getFixtures, getSiaOdds } from "./api/siaApi.ts";
import {
  filterSameLines,
  aggregateOdds,
  normalizeOdds,
} from "./services/services.ts";
import { SIA_URLS } from "./config/siaConstants.ts";
import fs from "fs";
import cron from "node-cron";
import schedule from "node-schedule";
import { closeDb, connectDb } from "./db/database.ts";

const app = express();
const port = process.env.PORT;

await initBrowser();
connectDb();

// Cron runs every 8 A.M Daily
cron.schedule("0 8 * * *", async () => {
  // Get the new set of games
  const fixtures = await getFixtures(SIA_URLS.nba.fixtures);

  // Schedule
  fixtures.forEach((fixture: any) => {
    const gameTime = new Date(fixture.startDate);
    // 2 hours before the game is the scrape time because money enters the market during this time window
    const scrapeTime = new Date(gameTime.getTime() - 2 * 60 * 60 * 1000);

    // Run whatever is in here based on scrapeTime
    schedule.scheduleJob(scrapeTime, () => {
      const scrapeInterval = setInterval(async () => {
        const fixtureId = fixture.id;
        await updateOddsToDb(fixtureId, fixture);
      }, 60 * 1000); // Interval is every minute

      // We need to stop scraping once gameTime has been hit since sportsbooks locks away the pregame props
      schedule.scheduleJob(gameTime, () => {
        clearInterval(scrapeInterval);
        console.log("Game started, stopped scraping");
      });
    });
  });
});

const updateOddsToDb = async (
  fixtureId: number,
  fixture: any,
) => {
  const aggregatedOdds = await aggregateOdds(
    fixtureId,
    fixture,
  );
  const filteredOdds = filterSameLines(aggregatedOdds);
  const normalizedOdds = normalizeOdds(filteredOdds);
};

app.listen(port, () => {
  `Server Running on Port ${port}`;
});

// SIGINT happens when we stop the server (ctrl + c)
process.on("SIGINT", () => {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
});

// SIGTERM happens when the server is killed or stopped
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
});
