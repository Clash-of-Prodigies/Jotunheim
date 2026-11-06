import Database from "better-sqlite3";
import { join } from "node:path";

export const CURRENT_SCHEMA_VERSION = 3;

export function configureDatabase(database: Database.Database): void {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = FULL");
}

export function migrateDatabase(database: Database.Database): number {
    let version = Number(database.pragma("user_version", { simple: true }));

    if (version > CURRENT_SCHEMA_VERSION) {
        throw new Error(`Unsupported database schema version: ${version}`);
    }

    if (version < 1) {
        database.transaction(() => {
            database.exec(`
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
            database.pragma("user_version = 1");
        })();
        version = 1;
    }

    if (version < 2) {
        database.transaction(() => {
            database.exec(`
                ALTER TABLE players ADD COLUMN team_id TEXT;
                ALTER TABLE players ADD COLUMN nickname TEXT;
                CREATE INDEX idx_teams ON players(team_id);
                DROP TABLE player_aliases;
            `);
            database.pragma("user_version = 2");
        })();
        version = 2;
    }

    if (version < 3) {
        database.transaction(() => {
            database.exec(`
                CREATE TABLE matches (
                    id TEXT PRIMARY KEY,
                    home_team TEXT NOT NULL,
                    away_team TEXT NOT NULL,
                    scheduled_at TEXT,
                    stage TEXT,
                    status TEXT NOT NULL DEFAULT 'SCHEDULED'
                        CHECK (status IN (
                            'SCHEDULED',
                            'ACTIVE',
                            'COMPLETED',
                            'POSTPONED',
                            'CANCELLED'
                        )),
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CHECK (home_team <> away_team)
                );

                CREATE INDEX idx_matches_teams
                ON matches(home_team, away_team);

                CREATE INDEX idx_matches_schedule
                ON matches(status, scheduled_at);
            `);
            database.pragma("user_version = 3");
        })();
        version = 3;
    }

    return version;
}

export function openDatabase(path: string): Database.Database {
    const database = new Database(path);
    configureDatabase(database);
    migrateDatabase(database);
    return database;
}

const databasePath = process.env.MERCURY_DATABASE_PATH ?? join(import.meta.dirname, "mercury.sqlite");

export const db = openDatabase(databasePath);
export const schemaVersion = Number(db.pragma("user_version", { simple: true }));