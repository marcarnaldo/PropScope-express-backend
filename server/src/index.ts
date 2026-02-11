import express from "express";
import "dotenv/config";
import { logger } from "./utils/errorHandling";
import { SiaApiService } from "./api/siaApi";
import { FanduelOddsApiService } from "./api/oddsApi";
import { Database } from "./db/database";
import { initNbaSchema } from "./db/schemas";
import { initDailyScheduler, Scheduler } from "./services/scheduler";
import {
  getNbaFixturesFromDb,
  getOddsHistory,
} from "./db/nbaRepositories";


const app = express();
const port = process.env.PORT;

const db = Database.getInstance();
await initNbaSchema(db);
const siaService = new SiaApiService();
await siaService.initialize();
const fdService = new FanduelOddsApiService();
const scheduler = new Scheduler();

await initDailyScheduler(db, siaService, fdService, scheduler);

app.get("/nba/games", async (req, res) => {
  const games = await getNbaFixturesFromDb(db);
  res.json(games);
});

app.get("/nba/odds/:fixtureId/history", async (req, res) => {
  const fixtureId = parseInt(req.params.fixtureId);
  const history = await getOddsHistory(db, fixtureId);
  res.json(history);
});

app.get("/health", async (req, res) => {
  let dbStatus: string;
  try {
    await db.query("SELECT 1");
    dbStatus = "connected";
  } catch (error) {
    dbStatus = "disconnected";
  }

  const browserStatus = (await siaService.isBrowserHealthy())
    ? "alive"
    : "dead";

  const isHealthy = dbStatus === "connected" && browserStatus === "alive";

  const response = {
    status: isHealthy ? "healthy" : "unhealthy",
    database: dbStatus,
    browser: browserStatus,
    uptime: Math.floor(process.uptime()),
  };

  res.status(isHealthy ? 200 : 503).json(response);
});

app.listen(port, () => {
  logger.info({ port }, "server running in port");
});

// SIGINT happens when we stop the server (ctrl + c)
process.on("SIGINT", async () => {
  logger.info("Server shutting down");
  scheduler.shutdown();
  await db.close();
  await siaService.close();
  process.exit(0);
});

// SIGTERM happens when the server is killed or stopped
process.on("SIGTERM", async () => {
  logger.info("Server shutting down");
  scheduler.shutdown();
  await db.close();
  await siaService.close();
  process.exit(0);
});
