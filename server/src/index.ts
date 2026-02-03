import express from "express";
import "dotenv/config";
import { initBrowser } from "./api/siaApi.ts";
import {
  initFetchAndSaveNewFixtureToDb,
  initMinuteScrapingScheduler,
} from "./services/scheduler.ts";

import { Database } from "./db/database.ts";
import { initNbaSchema } from "./db/schemas.ts";
import { getNbaNormalizedOdds } from "./db/nbaRepositories.ts";

const app = express();
const port = process.env.PORT;

// Open the browser and tabs
await initBrowser();

// Connect to db
const db = Database.getInstance();
// Create the tables
await initNbaSchema(db);

initFetchAndSaveNewFixtureToDb(db);
initMinuteScrapingScheduler(db);

app.get("/nba/normalizedOdds", async (req, res) => {
  const nbaNormalizedOdds = await getNbaNormalizedOdds(db);
  res.json(nbaNormalizedOdds);
});

app.listen(port, () => {
  console.log(`Server Running on Port ${port}`);
});

// SIGINT happens when we stop the server (ctrl + c)
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await db.close();
  process.exit(0);
});

// SIGTERM happens when the server is killed or stopped
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await db.close();
  process.exit(0);
});
