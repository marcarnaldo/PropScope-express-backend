import Database from "better-sqlite3";
import path from "path";

let db: Database.Database | null = null;

export const connectDb = () => {
  if (!db) {
    const dbPath = path.join(process.cwd(), "data", "odds.db");
    db = new Database(dbPath);

    console.log("Connected to SQLite database.");
  }

  return db;
};

export const closeDb = () => {
    if (db) {
        db.close()
        db = null
        console.log('Database connection closed.')
    }
}

