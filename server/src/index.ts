import express from "express";
import "dotenv/config";
import { SiaApiService } from "./api/siaApi";
import { FanduelOddsApiService } from "./api/oddsApi";
import { Database } from "./db/database";
import { initNbaSchema } from "./db/schemas";
import { initDailyScheduler, Scheduler } from "./services/scheduler";
import {
  getNbaFixturesFromDb,
  getNbaNormalizedOdds,
} from "./db/nbaRepositories";

const app = express();
const port = process.env.PORT;

// const main = async () => {
//   const siaApiService = new SiaApiService();
//   await siaApiService.initialize(); // ← Missing this?
//   const fdApiService = new FanduelOddsApiService();
//   const fixtures = await siaApiService.getFixtures(SIA_URLS.nba.fixtures);

//   fixtures.forEach(async (fixture: any) => {
//     const awayTeam = fixture.participants[0].name.value;
//     const homeTeam = fixture.participants[1].name.value;
//     const markets = await siaApiService.getSiaPlayerOverUnders(
//       fixture.id,
//       awayTeam,
//       homeTeam,
//       fixture,
//     );

//     const aggregateOdds = await aggregateSiaAndFdOdds(
//       fixture.id,
//       fixture,
//       siaApiService,
//       fdApiService,
//     );

//     const filteredSameLine = filterSameLines(aggregateOdds);
//     const normalizedOdds = normalizeOdds(filteredSameLine);

//     await fs.writeFile(
//       `normalizedOdds_${awayTeam}_vs_${homeTeam}.json`,
//       JSON.stringify(normalizedOdds, null, 2),
//     );
//   });
// };

// await main();

const db = Database.getInstance();
await initNbaSchema(db);
const siaService = new SiaApiService();
await siaService.initialize();
const fdService = new FanduelOddsApiService();
const scheduler = new Scheduler();

await initDailyScheduler(db, siaService, fdService, scheduler);

app.get("/nba/normalizedOdds", async (req, res) => {
  const nbaNormalizedOdds = await getNbaNormalizedOdds(db);
  res.json(nbaNormalizedOdds);
});

app.get("/nba/games", async (req, res) => {
  const games = await getNbaFixturesFromDb(db);
  res.json(games);
});

app.listen(port, () => {
  console.log(`Server Running on Port ${port}`);
});

// SIGINT happens when we stop the server (ctrl + c)
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  scheduler.shutdown();
  await db.close();
  await siaService.close();
  process.exit(0);
});

// SIGTERM happens when the server is killed or stopped
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  scheduler.shutdown();
  await db.close();
  await siaService.close();
  process.exit(0);
});
