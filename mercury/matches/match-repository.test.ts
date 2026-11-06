import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
    getEligibleMatchesForTeams,
    getMatchById,
    getScheduledMatchesWithinWindow,
} from "./match-repository.js";
import {
    applyFixtureImport,
    planFixtureImport,
    summarizeFixturePlan,
} from "./fixture-import.js";
import { normalizeScheduledAt } from "./timestamps.js";

const TEAM_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TEAM_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const MATCH_A = "111111111111111111111111";
const MATCH_B = "222222222222222222222222";

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
        CREATE TABLE matches (
            id TEXT PRIMARY KEY,
            home_team TEXT NOT NULL,
            away_team TEXT NOT NULL,
            scheduled_at TEXT,
            stage TEXT,
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO players (id, name, challenge_player_id, team_id) VALUES
            ('p1', 'One', 'cp1', '${TEAM_A}'),
            ('p2', 'Two', 'cp2', '${TEAM_B}');
    `);
    return database;
}

test("normalizes timezone-qualified timestamps and rejects ambiguous dates", () => {
    assert.equal(
        normalizeScheduledAt("2026-11-01T12:00:00-05:00"),
        "2026-11-01T17:00:00.000Z",
    );
    assert.equal(normalizeScheduledAt("2026-11-01T12:00:00"), null);
    assert.equal(normalizeScheduledAt("2026-02-30T12:00:00Z"), null);
});

test("fixture import is transactional, idempotent, and preserves absent fixtures", () => {
    const database = createDatabase();
    const input = [{
        id: MATCH_A,
        homeTeam: TEAM_A,
        awayTeam: TEAM_B,
        scheduledAt: "2026-11-01T12:00:00-05:00",
        stage: "League of Legends",
        status: "SCHEDULED",
    }];

    const firstPlan = planFixtureImport(database, input);
    assert.deepEqual(summarizeFixturePlan(firstPlan), {
        input: 1,
        inserted: 1,
        updated: 0,
        unchanged: 0,
        invalid: 0,
        unresolved: 0,
    });
    assert.deepEqual(applyFixtureImport(database, firstPlan), { inserted: 1, updated: 0 });

    database.prepare(`
        INSERT INTO matches (id, home_team, away_team, scheduled_at, stage, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(MATCH_B, TEAM_B, TEAM_A, "2026-11-02T17:00:00.000Z", null, "SCHEDULED");

    const secondPlan = planFixtureImport(database, input);
    assert.equal(secondPlan.unchanged.length, 1);
    assert.deepEqual(applyFixtureImport(database, secondPlan), { inserted: 0, updated: 0 });
    assert.equal(
        (database.prepare("SELECT COUNT(*) AS count FROM matches").get() as { count: number }).count,
        2,
    );
    database.close();
});

test("fixture import rejects invalid timestamps and unknown competitor IDs", () => {
    const database = createDatabase();
    const invalidPlan = planFixtureImport(database, [{
        id: MATCH_A,
        homeTeam: TEAM_A,
        awayTeam: TEAM_B,
        scheduledAt: "2026-11-01T12:00:00",
        status: "SCHEDULED",
    }]);
    assert.equal(invalidPlan.invalid.length, 1);

    const unresolvedPlan = planFixtureImport(database, [{
        id: MATCH_A,
        homeTeam: TEAM_A,
        awayTeam: "cccccccccccccccccccccccc",
        scheduledAt: "2026-11-01T17:00:00Z",
        status: "SCHEDULED",
    }]);
    assert.equal(unresolvedPlan.unresolved.length, 1);
    database.close();
});

test("repository queries handle unordered teams, windows, and eligibility", () => {
    const database = createDatabase();
    const insert = database.prepare(`
        INSERT INTO matches (id, home_team, away_team, scheduled_at, stage, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(MATCH_A, TEAM_A, TEAM_B, "2026-11-01T17:00:00.000Z", "Stage", "SCHEDULED");
    insert.run(MATCH_B, TEAM_B, TEAM_A, "2026-11-01T18:00:00.000Z", "Stage", "CANCELLED");

    assert.equal(getMatchById(database, MATCH_A)?.homeTeam, TEAM_A);
    assert.deepEqual(
        getEligibleMatchesForTeams(database, TEAM_B, TEAM_A).map((fixture) => fixture.id),
        [MATCH_A],
    );
    assert.deepEqual(
        getScheduledMatchesWithinWindow(
            database,
            "2026-11-01T16:30:00Z",
            "2026-11-01T18:30:00Z",
        ).map((fixture) => fixture.id),
        [MATCH_A],
    );
    database.close();
});
