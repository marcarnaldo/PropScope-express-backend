import express from "express";
import "dotenv/config";
import { initBrowser } from "./api/siaApi.ts";
import { closeDb, connectDb, getNbaNormalizedOdds } from "./db/database.ts";
import {
  initFetchAndSaveNewFixtureToDb,
  initMinuteScrapingScheduler,
} from "./services/scheduler.ts";

const app = express();
const port = process.env.PORT;

await initBrowser();
connectDb();

initFetchAndSaveNewFixtureToDb();
initMinuteScrapingScheduler();

app.get("/nba/normalizedOdds", (req, res) => {
  const nbaNormalizedOdds = getNbaNormalizedOdds();
  const parsed = nbaNormalizedOdds.map((odds: any) => ({
    ...odds,
    odds_data: JSON.parse(odds.odds_data),
  }));

  res.json(parsed); 
});

app.listen(port, () => {
  console.log(`Server Running on Port ${port}`);
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