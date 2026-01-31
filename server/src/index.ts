import express from "express";
import "dotenv/config";
import { initBrowser } from "./api/siaApi.ts";
import { closeDb, connectDb } from "./db/database.ts";
import { initFetchAndSaveNewFixtureToDb, initMinuteScrapingScheduler } from "./services/scheduler.ts";

const app = express();
const port = process.env.PORT;

await initBrowser();
connectDb();

initFetchAndSaveNewFixtureToDb()
initMinuteScrapingScheduler()

app.listen(port, () => {
  `Server Running on Port ${port}`;
});

// SIGINT happens when we stop the server (ctrl + c)
process.on("SIGINT", () => {
  console.log("Shutting down...");
  // Need to close the db when this happens
  closeDb();
  process.exit(0);
});

// SIGTERM happens when the server is killed or stopped
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  // Need to close the db when this happens
  closeDb();
  process.exit(0);
});
