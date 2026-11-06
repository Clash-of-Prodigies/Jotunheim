import assert from "node:assert/strict";
import test from "node:test";
import type { Player, PlayerResolution } from "../players/identity.js";
import type { MatchFixture, MatchStatus } from "./match-repository.js";
import {
    resolveFixture,
    type VerifiedParticipant,
} from "./fixture-resolver.js";

const START = "2026-11-01T17:00:00.000Z";

function player(id: string, teamId: string | null): Player {
    return { id, name: id, challengePlayerId: `cp-${id}`, teamId, nickname: null };
}

function participant(
    controllerId: string,
    resolution: PlayerResolution,
): VerifiedParticipant {
    return { controllerId, nickname: controllerId, resolution };
}

function matched(controllerId: string, teamId: string): VerifiedParticipant {
    return participant(controllerId, { status: "MATCHED", player: player(controllerId, teamId) });
}

function fixture(
    id: string,
    homeTeam: string,
    awayTeam: string,
    scheduledAt: string | null,
    status: MatchStatus = "SCHEDULED",
): MatchFixture {
    return { id, homeTeam, awayTeam, scheduledAt, stage: null, status, updatedAt: START };
}

function resolve(
    participants: VerifiedParticipant[],
    fixtures: MatchFixture[],
    confirmedClaims: ReadonlyMap<string, string> = new Map(),
) {
    return resolveFixture({
        sessionId: "session-a",
        participants,
        startedAt: START,
        fixtures,
        confirmedClaims,
    });
}

test("resolves one fixture for two verified teams", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [fixture("match-1", "team-a", "team-b", START)],
    );
    assert.deepEqual(result.status, "RESOLVED");
    if (result.status === "RESOLVED") assert.equal(result.fixtureId, "match-1");
});

test("matches home and away teams irrespective of ordering", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [fixture("match-1", "team-b", "team-a", START)],
    );
    assert.equal(result.status, "RESOLVED");
});

test("selects the nearest of repeated fixtures when its lead is clear", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [
            fixture("nearest", "team-a", "team-b", "2026-11-01T17:10:00.000Z"),
            fixture("later", "team-a", "team-b", "2026-11-01T18:10:00.000Z"),
        ],
    );
    assert.equal(result.status, "RESOLVED");
    if (result.status === "RESOLVED") assert.equal(result.fixtureId, "nearest");
});

test("returns ambiguity when repeated fixtures lack 45 minutes of separation", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [
            fixture("first", "team-a", "team-b", "2026-11-01T17:10:00.000Z"),
            fixture("second", "team-a", "team-b", "2026-11-01T17:30:00.000Z"),
        ],
    );
    assert.equal(result.status, "NEEDS_CONFIRMATION");
    if (result.status === "NEEDS_CONFIRMATION") {
        assert.equal(result.reason, "AMBIGUOUS_FIXTURES");
        assert.deepEqual(result.candidateFixtureIds, ["first", "second"]);
    }
});

test("returns no eligible fixture outside the two-hour window", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [fixture("far", "team-a", "team-b", "2026-11-01T20:00:00.000Z")],
    );
    assert.equal(result.status, "NEEDS_CONFIRMATION");
    if (result.status === "NEEDS_CONFIRMATION") {
        assert.equal(result.reason, "NO_ELIGIBLE_FIXTURE");
    }
});

test("waits for a second represented team", () => {
    const result = resolve(
        [matched("one", "team-a")],
        [fixture("match-1", "team-a", "team-b", START)],
    );
    assert.equal(result.status, "WAITING_FOR_TEAMS");
});

test("flags more than two represented teams for review", () => {
    const result = resolve(
        [
            matched("one", "team-a"),
            matched("two", "team-b"),
            matched("three", "team-c"),
        ],
        [fixture("match-1", "team-a", "team-b", START)],
    );
    assert.equal(result.status, "NEEDS_REVIEW");
    if (result.status === "NEEDS_REVIEW") assert.equal(result.reason, "TOO_MANY_TEAMS");
});

test("unmatched and ambiguous identities never contribute team evidence", () => {
    const result = resolve(
        [
            participant("unknown", { status: "NOT_FOUND" }),
            participant("ambiguous", {
                status: "AMBIGUOUS",
                players: [player("a", "team-a"), player("b", "team-b")],
            }),
        ],
        [fixture("match-1", "team-a", "team-b", START)],
    );
    assert.equal(result.status, "WAITING_FOR_TEAMS");
    assert.deepEqual(result.unresolvedControllerIds, ["ambiguous", "unknown"]);
});

test("confirmed claims eliminate candidates without using tentative claims", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [
            fixture("claimed", "team-a", "team-b", "2026-11-01T17:10:00.000Z"),
            fixture("available", "team-a", "team-b", "2026-11-01T17:20:00.000Z"),
        ],
        new Map([["claimed", "other-session"]]),
    );
    assert.equal(result.status, "RESOLVED");
    if (result.status === "RESOLVED") assert.equal(result.fixtureId, "available");
});

test("excludes ineligible statuses and missing or invalid schedules", () => {
    const result = resolve(
        [matched("one", "team-a"), matched("two", "team-b")],
        [
            fixture("completed", "team-a", "team-b", START, "COMPLETED"),
            fixture("postponed", "team-a", "team-b", START, "POSTPONED"),
            fixture("cancelled", "team-a", "team-b", START, "CANCELLED"),
            fixture("missing", "team-a", "team-b", null),
            fixture("invalid", "team-a", "team-b", "not-a-date"),
        ],
    );
    assert.equal(result.status, "NEEDS_CONFIRMATION");
    if (result.status === "NEEDS_CONFIRMATION") {
        assert.equal(result.reason, "NO_ELIGIBLE_FIXTURE");
    }
});
