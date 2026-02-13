import "dotenv/config";
import { logger } from "./utils/errorHandling";
import { SiaApiService } from "./api/siaApi";
import { FanduelOddsApiService } from "./api/oddsApi";
import { Database } from "./db/database";
import { initNbaSchema } from "./db/schemas";
import { initDailyScheduler, Scheduler } from "./services/scheduler";
import { SPORTS } from "./config/types";

const db = Database.getInstance();
await initNbaSchema(db);
const siaService = new SiaApiService();
await siaService.initialize();
const fdService = new FanduelOddsApiService();
const scheduler = new Scheduler();

await initDailyScheduler(db, siaService, fdService, scheduler, SPORTS.NBA);

logger.info("Worker running");

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