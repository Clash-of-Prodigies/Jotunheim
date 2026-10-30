import Database from "better-sqlite3";
import { join } from "node:path";

// Track the database schema version.
const CURRENT_SCHEMA_VERSION = 1;

// Open or create the SQLite database.
export const db = new Database(join(import.meta.dirname, "mercury.sqlite"));

// Configure SQLite.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = FULL");

const version = Number(db.pragma("user_version", { simple: true }));

if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported database schema version: ${version}`);
}

// Migration 1: Initial player registry.
if (version < 1) {
    db.transaction(() => {
        db.exec(`
            CREATE TABLE players (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                challenge_player_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        
            CREATE TABLE player_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL,
                normalized_alias TEXT NOT NULL,
                FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
                UNIQUE (player_id, normalized_alias)
            );
            CREATE INDEX idx_player_alias ON player_aliases(normalized_alias);
        `);
        db.pragma("user_version = 1");
    })();
}

export const schemaVersion = Number(db.pragma("user_version", { simple: true }));