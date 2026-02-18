import { Request, Response } from "express";
import { logger } from "../utils/errorHandling";

// Keeps track of all connected SSE clients
class SseManager {
  private clients: Set<Response> = new Set();

  // Call this when a client connects to the SSE endpoint
  addClient(req: Request, res: Response): void {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream", // This is an SSE stream, don't close
      "Cache-Control": "no-cache", // Ensure's that the browser does not cache the stream to prevent real time updates from crashing
      Connection: "keep-alive", // Prevents the server from closing the HTTP connection after sending a response
    });

    // Send a heartbeat so the client knows it's connected
    res.write("data: connected\n\n");

    this.clients.add(res);
    logger.info({ totalClients: this.clients.size }, "SSE client connected");

    // Remove client when they disconnect
    req.on("close", () => {
      this.clients.delete(res);
      logger.info(
        { totalClients: this.clients.size },
        "SSE client disconnected",
      );
    });
  }

  // Call this after inserting odds to notify all connected clients
  notifyBatchUpdate(fixtureIds: number[]): void {
    const payload = JSON.stringify({ fixtureIds });

    for (const client of this.clients) {
      client.write(`event: odds-update\ndata: ${payload}\n\n`);
    }

    logger.info(
      { fixtureIds, clientCount: this.clients.size },
      "Notified SSE clients of batch odds update",
    );
  }
}
// Single instance shared across the app
export const sseManager = new SseManager();
