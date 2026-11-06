import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

process.env.MERCURY_DATABASE_PATH = ":memory:";
const databaseModule = await import("./database.js");
const {
    CURRENT_SCHEMA_VERSION,
    db: defaultDatabase,
    migrateDatabase,
    schemaVersion,
} = databaseModule;

test.after(() => defaultDatabase.close());

test("a fresh database reaches schema version 3", () => {
    assert.equal(schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(
        defaultDatabase.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'matches'",
        ).get(),
        { name: "matches" },
    );
});

test("migration 3 preserves schema-v2 players and is idempotent", () => {
    const database = new Database(":memory:");
    database.exec(`
        CREATE TABLE players (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            challenge_player_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            team_id TEXT,
            nickname TEXT
        );
        CREATE INDEX idx_teams ON players(team_id);
        INSERT INTO players (id, name, challenge_player_id, team_id, nickname)
        VALUES ('internal-1', 'Player One', 'challenge-1', 'team-1', 'One');
        PRAGMA user_version = 2;
    `);

    assert.equal(migrateDatabase(database), 3);
    assert.deepEqual(
        database.prepare(`
            SELECT id, name, challenge_player_id, team_id, nickname FROM players
        `).get(),
        {
            id: "internal-1",
            name: "Player One",
            challenge_player_id: "challenge-1",
            team_id: "team-1",
            nickname: "One",
        },
    );
    const indexes = database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE 'idx_matches_%'
        ORDER BY name
    `).all();
    assert.deepEqual(indexes, [
        { name: "idx_matches_schedule" },
        { name: "idx_matches_teams" },
    ]);
    assert.equal(migrateDatabase(database), 3);
    assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM matches").get() as { count: number }).count,
        0,
    );
    database.close();
});
