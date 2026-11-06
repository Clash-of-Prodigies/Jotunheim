import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { buildApp } from "../app.js";

const TOKEN = "synthetic-development-token";
const START = "2026-11-01T18:00:00.000Z";
const LATE = "2026-11-01T22:00:00.000Z";
const NEAR = "2026-11-01T18:20:00.000Z";
const EARLY = "2026-11-01T16:00:00.000Z";

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
            status TEXT NOT NULL DEFAULT 'SCHEDULED',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO players (id, name, challenge_player_id, team_id, nickname) VALUES
            ('alice', 'Alice Test', 'cp-alice', 'team-a', 'Alice'),
            ('bob', 'Bob Test', 'cp-bob', 'team-b', 'Bob'),
            ('carol', 'Carol Test', 'cp-carol', 'team-c', 'Carol'),
            ('dave', 'Dave Test', 'cp-dave', 'team-d', 'Dave'),
            ('erin', 'Erin Test', 'cp-erin', 'team-e', 'Erin'),
            ('finn', 'Finn Test', 'cp-finn', 'team-f', 'Finn'),
            ('shared-one', 'Shared One', 'cp-shared-one', 'team-a', 'Shared'),
            ('shared-two', 'Shared Two', 'cp-shared-two', 'team-b', 'Shared');
        INSERT INTO matches (id, home_team, away_team, scheduled_at, stage, status) VALUES
            ('match-ab', 'team-a', 'team-b', '${START}', 'Synthetic', 'SCHEDULED'),
            ('match-cd', 'team-c', 'team-d', '${START}', 'Synthetic', 'SCHEDULED'),
            ('match-ef-one', 'team-e', 'team-f', '${START}', 'Synthetic', 'SCHEDULED'),
            ('match-ef-two', 'team-f', 'team-e', '${NEAR}', 'Synthetic', 'SCHEDULED'),
            ('match-ab-late', 'team-b', 'team-a', '${LATE}', 'Synthetic', 'SCHEDULED');
        PRAGMA user_version = 3;
    `);
    return database;
}

function auth() {
    return { authorization: `Bearer ${TOKEN}` };
}

async function postEvent(
    app: ReturnType<typeof buildApp>,
    payload: Record<string, unknown>,
) {
    return app.inject({
        method: "POST",
        url: "/api/kahoot/events",
        headers: auth(),
        payload,
    });
}

async function startSession(
    app: ReturnType<typeof buildApp>,
    sessionId: string,
    occurredAt = START,
) {
    return postEvent(app, { type: "SESSION_STARTED", sessionId, occurredAt });
}

async function startScoringSession(
    app: ReturnType<typeof buildApp>,
    sessionId: string,
    liveGameId: string,
    occurredAt = START,
) {
    return postEvent(app, {
        type: "SESSION_STARTED", sessionId, liveGameId, occurredAt,
    });
}

async function join(
    app: ReturnType<typeof buildApp>,
    sessionId: string,
    controllerId: string,
    nickname: string,
    occurredAt = START,
) {
    return postEvent(app, {
        type: "PARTICIPANT_JOINED",
        sessionId,
        controllerId,
        nickname,
        occurredAt,
    });
}

interface QuestionTestResult {
    controllerId: string;
    points: number;
    reactionTimeMs?: number;
    isCorrect?: boolean;
}

async function question(
    app: ReturnType<typeof buildApp>,
    sessionId: string,
    liveGameId: string,
    questionIndex: number,
    results: QuestionTestResult[],
    complete = true,
) {
    return postEvent(app, {
        type: "QUESTION_RESULTS",
        sessionId,
        liveGameId,
        questionIndex,
        complete,
        participantSnapshotControllerIds: results.map((result) => result.controllerId),
        results,
        occurredAt: START,
    });
}

test("event API enforces authentication and JSON Schema validation", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    const unauthorized = await app.inject({
        method: "POST",
        url: "/api/kahoot/events",
        payload: { type: "SESSION_STARTED", sessionId: "one", occurredAt: START },
    });
    assert.equal(unauthorized.statusCode, 401);

    const invalid = await postEvent(app, {
        type: "PARTICIPANT_JOINED",
        sessionId: "one",
        nickname: "Alice",
        occurredAt: START,
    });
    assert.equal(invalid.statusCode, 400);

    const ambiguousTimestamp = await startSession(app, "one", "2026-11-01 12:00:00");
    assert.equal(ambiguousTimestamp.statusCode, 400);
});

test("HTTP lifecycle resolves a fixture and handles duplicate joins and departures", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    assert.equal((await startSession(app, "lifecycle")).statusCode, 200);
    let response = await join(app, "lifecycle", "controller-a", "Alice");
    let state = response.json();
    assert.equal(state.status, "WAITING_FOR_TEAMS");
    assert.equal(state.verifiedParticipantCount, 1);
    assert.equal(state.readyToPublish, false);

    response = await join(app, "lifecycle", "controller-a", "Alice");
    state = response.json();
    assert.equal(state.participantCount, 1);

    response = await join(app, "lifecycle", "controller-b", "Bob");
    state = response.json();
    assert.equal(state.confirmedMatchId, "match-ab");
    assert.deepEqual(state.detectedTeamIds, ["team-a", "team-b"]);
    assert.equal(state.publicationSafe, true);
    assert.equal(state.readyToPublish, true);

    response = await postEvent(app, {
        type: "PARTICIPANT_LEFT",
        sessionId: "lifecycle",
        controllerId: "controller-b",
        occurredAt: START,
    });
    state = response.json();
    assert.equal(state.participantCount, 1);
    assert.equal(state.confirmedMatchId, "match-ab");

    response = await postEvent(app, {
        type: "PARTICIPANT_LEFT",
        sessionId: "lifecycle",
        controllerId: "controller-b",
        occurredAt: START,
    });
    assert.equal(response.json().participantCount, 1);

    response = await postEvent(app, {
        type: "SESSION_ENDED",
        sessionId: "lifecycle",
        occurredAt: START,
    });
    assert.equal(response.json().ended, true);
    const missing = await app.inject({
        method: "GET",
        url: "/api/kahoot/sessions/lifecycle",
        headers: auth(),
    });
    assert.equal(missing.statusCode, 404);
});

test("flags unknown, ambiguous, conflicting, and third-team identities", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startSession(app, "flags");
    let state = (await join(app, "flags", "unknown", "Nobody")).json();
    assert.equal(state.flaggedIdentities[0].reason, "UNMATCHED");
    state = (await join(app, "flags", "ambiguous", "Shared")).json();
    assert.equal(
        state.flaggedIdentities.find((item: { controllerId: string }) =>
            item.controllerId === "ambiguous"
        ).reason,
        "AMBIGUOUS",
    );

    state = (await join(app, "flags", "conflict", "Alice")).json();
    state = (await join(app, "flags", "conflict", "Bob")).json();
    assert.equal(
        state.flaggedIdentities.find((item: { controllerId: string }) =>
            item.controllerId === "conflict"
        ).reason,
        "CONFLICT",
    );

    await startSession(app, "third-team");
    await join(app, "third-team", "a", "Alice");
    await join(app, "third-team", "b", "Bob");
    state = (await join(app, "third-team", "c", "Carol")).json();
    assert.equal(state.confirmedMatchId, "match-ab");
    assert.equal(state.status, "NEEDS_REVIEW");
    assert.equal(state.publicationSafe, false);
});

test("concurrent HTTP sessions stay isolated and released claims are reevaluated", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startSession(app, "first");
    await join(app, "first", "first-a", "Alice");
    let state = (await join(app, "first", "first-b", "Bob")).json();
    assert.equal(state.confirmedMatchId, "match-ab");

    await startSession(app, "blocked");
    await join(app, "blocked", "blocked-a", "Alice");
    state = (await join(app, "blocked", "blocked-b", "Bob")).json();
    assert.equal(state.confirmedMatchId, null);
    assert.equal(state.status, "NEEDS_CONFIRMATION");

    await startSession(app, "independent");
    await join(app, "independent", "independent-c", "Carol");
    state = (await join(app, "independent", "independent-d", "Dave")).json();
    assert.equal(state.confirmedMatchId, "match-cd");

    await startSession(app, "later", LATE);
    await join(app, "later", "later-a", "Alice", LATE);
    state = (await join(app, "later", "later-b", "Bob", LATE)).json();
    assert.equal(state.confirmedMatchId, "match-ab-late");

    await postEvent(app, {
        type: "SESSION_ENDED",
        sessionId: "first",
        occurredAt: START,
    });
    const reevaluated = await app.inject({
        method: "GET",
        url: "/api/kahoot/sessions/blocked",
        headers: auth(),
    });
    assert.equal(reevaluated.json().confirmedMatchId, "match-ab");
});

test("an ambiguous session does not block an unrelated fixture", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    const ambiguousStart = "2026-11-01T18:10:00.000Z";
    await startSession(app, "still-ambiguous", ambiguousStart);
    await join(app, "still-ambiguous", "still-e", "Erin", ambiguousStart);
    let state = (await join(
        app,
        "still-ambiguous",
        "still-f",
        "Finn",
        ambiguousStart,
    )).json();
    assert.equal(state.status, "NEEDS_CONFIRMATION");
    assert.equal(state.confirmedMatchId, null);

    await startSession(app, "unrelated-success");
    await join(app, "unrelated-success", "unrelated-c", "Carol");
    state = (await join(app, "unrelated-success", "unrelated-d", "Dave")).json();
    assert.equal(state.confirmedMatchId, "match-cd");

    const unchanged = await app.inject({
        method: "GET",
        url: "/api/kahoot/sessions/still-ambiguous",
        headers: auth(),
    });
    assert.equal(unchanged.json().status, "NEEDS_CONFIRMATION");
    assert.equal(unchanged.json().confirmedMatchId, null);
});

test("a confirmed claim eliminates one candidate and resolves another session", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    const ambiguousStart = "2026-11-01T18:10:00.000Z";
    await startSession(app, "ambiguous-pair", ambiguousStart);
    await join(app, "ambiguous-pair", "ambiguous-e", "Erin", ambiguousStart);
    let state = (await join(
        app,
        "ambiguous-pair",
        "ambiguous-f",
        "Finn",
        ambiguousStart,
    )).json();
    assert.equal(state.status, "NEEDS_CONFIRMATION");
    assert.deepEqual(state.candidateFixtureIds, ["match-ef-one", "match-ef-two"]);

    await startSession(app, "early-claim", EARLY);
    await join(app, "early-claim", "early-e", "Erin", EARLY);
    state = (await join(app, "early-claim", "early-f", "Finn", EARLY)).json();
    assert.equal(state.confirmedMatchId, "match-ef-one");

    const reevaluated = await app.inject({
        method: "GET",
        url: "/api/kahoot/sessions/ambiguous-pair",
        headers: auth(),
    });
    state = reevaluated.json();
    assert.equal(state.confirmedMatchId, "match-ef-two");
    assert.equal(state.readyToPublish, true);
});

test("unmatched and ambiguous identity reports remain isolated by session", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startSession(app, "unmatched-only");
    let state = (await join(app, "unmatched-only", "unknown", "Nobody")).json();
    assert.deepEqual(
        state.flaggedIdentities.map((item: { reason: string }) => item.reason),
        ["UNMATCHED"],
    );

    await startSession(app, "ambiguous-only");
    state = (await join(app, "ambiguous-only", "shared", "Shared")).json();
    assert.deepEqual(
        state.flaggedIdentities.map((item: { reason: string }) => item.reason),
        ["AMBIGUOUS"],
    );

    const first = await app.inject({
        method: "GET",
        url: "/api/kahoot/sessions/unmatched-only",
        headers: auth(),
    });
    assert.deepEqual(
        first.json().flaggedIdentities.map((item: { reason: string }) => item.reason),
        ["UNMATCHED"],
    );
});

test("readyToPublish is stricter than the publicationSafe integrity flag", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startSession(app, "readiness");
    await join(app, "readiness", "ready-a", "Alice");
    let state = (await join(app, "readiness", "ready-b", "Bob")).json();
    assert.equal(state.publicationSafe, true);
    assert.equal(state.readyToPublish, true);

    state = (await join(app, "readiness", "unknown", "Nobody")).json();
    assert.equal(state.publicationSafe, true);
    assert.equal(state.readyToPublish, false);
    assert.equal(state.confirmedMatchId, "match-ab");
});

test("HTTP question scoring is idempotent and preserves the original on conflict", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startScoringSession(app, "scoring", "live-scoring");
    await join(app, "scoring", "controller-a", "Alice");
    await join(app, "scoring", "controller-b", "Bob");

    const results = [
        {
            controllerId: "controller-a",
            points: 1000,
            reactionTimeMs: 420,
            isCorrect: true,
        },
        {
            controllerId: "controller-b",
            points: 900,
            reactionTimeMs: 580,
            isCorrect: true,
        },
    ];
    let response = await question(app, "scoring", "live-scoring", 0, results);
    assert.equal(response.statusCode, 200);
    let state = response.json();
    assert.equal(state.finalizedQuestionCount, 1);
    assert.equal(state.homeGoals, 1);
    assert.equal(state.awayGoals, 0);
    assert.equal(state.latestFinalizedQuestionIndex, 0);
    assert.equal(state.scoringSafe, true);
    assert.equal(state.questionSummaries[0].creditedScorerName, "Alice Test");

    state = (await question(app, "scoring", "live-scoring", 0, results)).json();
    assert.equal(state.finalizedQuestionCount, 1);
    assert.equal(state.homeGoals, 1);

    state = (await question(app, "scoring", "live-scoring", 0, [
        { controllerId: "controller-a", points: 100 },
        { controllerId: "controller-b", points: 900 },
    ])).json();
    assert.equal(state.finalizedQuestionCount, 1);
    assert.equal(state.homeGoals, 1);
    assert.equal(state.awayGoals, 0);
    assert.equal(state.pendingOrConflictingQuestionCount, 1);
    assert.equal(state.scoringSafe, false);
    assert.equal(state.readyToPublish, false);
});

test("incomplete scoring in one session does not block another concurrent match", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startScoringSession(app, "score-ab", "live-ab");
    await join(app, "score-ab", "ab-a", "Alice");
    await join(app, "score-ab", "ab-b", "Bob");

    await startScoringSession(app, "score-cd", "live-cd");
    await join(app, "score-cd", "cd-c", "Carol");
    await join(app, "score-cd", "cd-d", "Dave");

    let state = (await postEvent(app, {
        type: "QUESTION_RESULTS",
        sessionId: "score-ab",
        liveGameId: "live-ab",
        questionIndex: 0,
        complete: true,
        participantSnapshotControllerIds: ["ab-a", "ab-b"],
        results: [{ controllerId: "ab-a", points: 1000 }],
        occurredAt: START,
    })).json();
    assert.equal(state.finalizedQuestionCount, 0);
    assert.equal(state.pendingOrConflictingQuestionCount, 1);
    assert.equal(state.scoringSafe, false);

    state = (await question(app, "score-cd", "live-cd", 2, [
        { controllerId: "cd-c", points: 700, isCorrect: true },
        { controllerId: "cd-d", points: 1000, isCorrect: true },
    ])).json();
    assert.equal(state.finalizedQuestionCount, 1);
    assert.equal(state.homeGoals, 0);
    assert.equal(state.awayGoals, 1);
    assert.equal(state.scoringSafe, true);

    state = (await question(app, "score-ab", "live-ab", 0, [
        { controllerId: "ab-a", points: 1000 },
        { controllerId: "ab-b", points: 900 },
    ])).json();
    assert.equal(state.finalizedQuestionCount, 1);
    assert.equal(state.pendingOrConflictingQuestionCount, 0);
    assert.equal(state.scoringSafe, true);

    const independent = await app.inject({
        method: "GET",
        url: "/api/kahoot/sessions/score-cd",
        headers: auth(),
    });
    assert.equal(independent.json().awayGoals, 1);
    assert.equal(independent.json().finalizedQuestionCount, 1);
});

test("session completion reports the final score and rejects late scoring", async (t) => {
    const database = createDatabase();
    const app = buildApp({ database, developmentToken: TOKEN });
    t.after(async () => { await app.close(); database.close(); });

    await startScoringSession(app, "complete-score", "live-complete");
    await join(app, "complete-score", "complete-a", "Alice");
    await join(app, "complete-score", "complete-b", "Bob");
    await question(app, "complete-score", "live-complete", 0, [
        { controllerId: "complete-a", points: 1000 },
        { controllerId: "complete-b", points: 900 },
    ]);

    const ended = await postEvent(app, {
        type: "SESSION_ENDED",
        sessionId: "complete-score",
        occurredAt: START,
    });
    assert.equal(ended.statusCode, 200);
    assert.deepEqual(ended.json().finalScore, {
        homeGoals: 1,
        awayGoals: 0,
        finalizedQuestions: 1,
        unresolvedQuestions: 0,
        scoringSafe: true,
    });

    const late = await question(app, "complete-score", "live-complete", 1, [
        { controllerId: "complete-a", points: 1000 },
        { controllerId: "complete-b", points: 900 },
    ]);
    assert.equal(late.statusCode, 404);
});
