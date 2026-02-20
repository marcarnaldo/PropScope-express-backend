import "dotenv/config";
import express from "express";
import { logger } from "./utils/errorHandling";
import { SiaApiService } from "./api/siaApi";
import { FanduelOddsApiService } from "./api/oddsApi";
import { Database } from "./db/database";
import { initNbaSchema } from "./db/schemas";
import { initDailyScheduler, Scheduler } from "./services/scheduler";
import { SPORTS } from "./config/types";
import { sseManager } from "./services/sseManager";

const app = express();
const db = Database.getInstance();
await initNbaSchema(db);
const siaService = new SiaApiService();
const fdService = new FanduelOddsApiService();
const scheduler = new Scheduler();

await initDailyScheduler(db, siaService, fdService, scheduler, SPORTS.NBA);

logger.info("Worker running");

app.get("/sse/odds", (req, res) => {
  sseManager.addClient(req, res);
});

app.listen(3001, () => {
  logger.info("Backend listening on port 3001");
});

process.on("SIGINT", async () => {
  logger.info("Worker shutting down");
  scheduler.shutdown();
  await db.close();
  await siaService.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Worker shutting down");
  scheduler.shutdown();
  await db.close();
  await siaService.close();
  process.exit(0);
});
