import express from "express";
import "dotenv/config";
import { initBrowser } from "./api/siaApi.ts";
import { closeDb, connectDb, getNbaNormalizedOdds } from "./db/database.ts";
import {
  initFetchAndSaveNewFixtureToDb,
  initMinuteScrapingScheduler,
} from "./services/scheduler.ts";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = process.env.PORT;

await initBrowser();
connectDb();

initFetchAndSaveNewFixtureToDb();
initMinuteScrapingScheduler(io);

io.on("connection", (socket) => {
  console.log("Client connected");
  const normalizedOdds = getNbaNormalizedOdds();
  const parsed = normalizedOdds.map((odds: any) => ({
    ...odds,
    odds_data: JSON.parse(odds.odds_data),
  }));
  socket.emit("oddsUpdate", parsed);

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

app.get("/nba/normalizedOdds", (req, res) => {
  const nbaNormalizedOdds = getNbaNormalizedOdds();
  const parsed = nbaNormalizedOdds.map((odds: any) => ({
    ...odds,
    odds_data: JSON.parse(odds.odds_data),
  }));

  res.json(parsed); 
});

httpServer.listen(port, () => {
  console.log(`Server Running on Port ${port}`);
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
