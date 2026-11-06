import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { normalizeName, resolvePlayer } from "./identity.js";

function createDatabase(): Database.Database {
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
        INSERT INTO players (id, name, challenge_player_id, team_id, nickname) VALUES
            ('1', 'Alexander Smith', 'cp-1', 'team-a', 'Alex'),
            ('2', 'Alex', 'cp-2', 'team-b', NULL);
    `);
    return database;
}

test("normalizes names with NFKC, whitespace, and case rules", () => {
    assert.equal(normalizeName("  ＡLEX\tSmith  "), "alex smith");
});

test("resolves registered names and approved nicknames", () => {
    const database = createDatabase();
    assert.equal(resolvePlayer(database, "alexander smith").status, "MATCHED");
    assert.equal(resolvePlayer(database, "unknown").status, "NOT_FOUND");
    assert.equal(resolvePlayer(database, "Alex").status, "AMBIGUOUS");
    database.close();
});

test("can restrict player resolution to fixture teams", () => {
    const database = createDatabase();
    const resolution = resolvePlayer(database, "Alex", ["team-a"]);
    assert.equal(resolution.status, "MATCHED");
    if (resolution.status === "MATCHED") assert.equal(resolution.player.id, "1");
    database.close();
});
