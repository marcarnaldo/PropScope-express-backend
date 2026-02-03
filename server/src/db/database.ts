import pg from "pg";
import "dotenv/config";

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

    this.pool.on("error", (err) => {
      console.error("Unexpected database error", err);
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

  public async query(sql: string, params?: any[]): Promise<pg.QueryResult> {
    return this.pool.query(sql, params);
  }

  public async close(): Promise<void> {
    await this.pool.end();
    console.log("Database connection closed");
  }
}
