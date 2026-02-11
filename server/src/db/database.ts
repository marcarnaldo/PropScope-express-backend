/**
 * Database Service
 *
 * Singleton PostgreSQL connection pool. Ensures only one pool exists
 * throughout the application, reusing connections for all queries.
 */

import pg from "pg";
import "dotenv/config";
import { logger } from "../utils/errorHandling";

export class Database {
  // Ensuring only 1 db is made throughout the entire project
  private static instance: Database;
  // Reuses existing connection
  private pool: pg.Pool;

  private constructor() {
    this.pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432"),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      // max: 10,
      // idleTimeoutMillis: 30000,
      // connectionTimeoutMillis: 2000,
    });

    this.pool.on("error", (err: NodeJS.ErrnoException & { detail?: string }) => {
      logger.error({ error: err.message, code: err.code,  detail: err.detail}, "Unexpected database error");
    });
  }

  // Singleton pattern to make sure that we are only making 1 db
  public static getInstance(): Database {
    // If instance doesn't exist, create it
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  public async query(sql: string, params?: (string | number)[]): Promise<pg.QueryResult> {
    return this.pool.query(sql, params);
  }

  public async close(): Promise<void> {
    await this.pool.end();
    logger.info("Database connection closed");
  }
}