import assert from "node:assert/strict";
import test from "node:test";
import type { Player } from "../players/identity.js";
import type { MatchFixture } from "../matches/match-repository.js";
import type { VerifiedParticipant } from "../matches/fixture-resolver.js";
import { SessionManager } from "./session-manager.js";

const START = "2026-11-01T17:00:00.000Z";

function fixture(
    id: string,
    homeTeam: string,
    awayTeam: string,
    scheduledAt = START,
): MatchFixture {
    return {
        id,
        homeTeam,
        awayTeam,
        scheduledAt,
        stage: null,
        status: "SCHEDULED",
        updatedAt: START,
    };
}

function matched(controllerId: string, teamId: string): VerifiedParticipant {
    const player: Player = {
        id: `player-${controllerId}`,
        name: controllerId,
        challengePlayerId: `cp-${controllerId}`,
        teamId,
        nickname: null,
    };
    return {
        controllerId,
        nickname: controllerId,
        resolution: { status: "MATCHED", player },
    };
}

function addTeamPair(
    manager: SessionManager,
    sessionId: string,
    firstTeam: string,
    secondTeam: string,
    fixtures: readonly MatchFixture[],
): void {
    manager.recordParticipant(sessionId, matched(`${sessionId}-one`, firstTeam), fixtures);
    manager.recordParticipant(sessionId, matched(`${sessionId}-two`, secondTeam), fixtures);
}

test("two sessions cannot claim the same fixture", () => {
    const manager = new SessionManager();
    const fixtures = [fixture("match-1", "team-a", "team-b")];
    const first = manager.startSession({ pin: "111111", startedAt: START });
    const second = manager.startSession({ pin: "222222", startedAt: START });

    addTeamPair(manager, first.id, "team-a", "team-b", fixtures);
    addTeamPair(manager, second.id, "team-a", "team-b", fixtures);

    assert.equal(first.boundMatchId, "match-1");
    assert.equal(second.boundMatchId, null);
    assert.equal(second.resolution.status, "NEEDS_CONFIRMATION");
    assert.equal(manager.getConfirmedClaims().get("match-1"), first.id);
});

test("independent sessions claim different fixtures", () => {
    const manager = new SessionManager();
    const fixtures = [
        fixture("match-ab", "team-a", "team-b"),
        fixture("match-cd", "team-c", "team-d"),
    ];
    const first = manager.startSession({ pin: "111111", startedAt: START });
    const second = manager.startSession({ pin: "222222", startedAt: START });
    addTeamPair(manager, first.id, "team-a", "team-b", fixtures);
    addTeamPair(manager, second.id, "team-c", "team-d", fixtures);
    assert.equal(first.boundMatchId, "match-ab");
    assert.equal(second.boundMatchId, "match-cd");
});

test("a confirmed claim can resolve another session's ambiguity", () => {
    const manager = new SessionManager();
    const fixtures = [
        fixture("first", "team-a", "team-b", "2026-11-01T17:10:00.000Z"),
        fixture("second", "team-a", "team-b", "2026-11-01T17:20:00.000Z"),
    ];
    const ambiguous = manager.startSession({ pin: "111111", startedAt: START });
    addTeamPair(manager, ambiguous.id, "team-a", "team-b", fixtures);
    assert.equal(ambiguous.resolution.status, "NEEDS_CONFIRMATION");

    const manual = manager.startSession({ pin: "222222", startedAt: START });
    manager.recordParticipant(manual.id, matched("manual-one", "team-a"), fixtures);
    manager.confirmFixture(manual.id, "first", fixtures);

    assert.equal(manual.boundMatchId, "first");
    assert.equal(ambiguous.boundMatchId, "second");
});

test("confirmed binding remains fixed and blocks publication after a third team joins", () => {
    const manager = new SessionManager();
    const fixtures = [fixture("match-1", "team-a", "team-b")];
    const session = manager.startSession({ pin: "111111", startedAt: START });
    addTeamPair(manager, session.id, "team-a", "team-b", fixtures);
    assert.equal(session.boundMatchId, "match-1");

    manager.recordParticipant(session.id, matched("third", "team-c"), fixtures);
    assert.equal(session.boundMatchId, "match-1");
    assert.equal(session.publicationBlocked, true);
    assert.equal(session.resolution.status, "NEEDS_REVIEW");
    if (session.resolution.status === "NEEDS_REVIEW") {
        assert.equal(session.resolution.reason, "UNEXPECTED_TEAM_AFTER_BINDING");
    }
});

test("manual confirmation validates eligibility and releases claims on reset", () => {
    const manager = new SessionManager();
    const eligible = fixture("eligible", "team-a", "team-b");
    const completed = { ...fixture("completed", "team-a", "team-b"), status: "COMPLETED" as const };
    const fixtures = [eligible, completed];
    const session = manager.startSession({ pin: "111111", startedAt: START });
    manager.recordParticipant(session.id, matched("one", "team-a"), fixtures);
    assert.throws(
        () => manager.confirmFixture(session.id, "completed", fixtures),
        /not eligible/,
    );
    manager.confirmFixture(session.id, "eligible", fixtures);
    assert.equal(manager.getConfirmedClaims().get("eligible"), session.id);
    manager.resetBinding(session.id, []);
    assert.equal(manager.getConfirmedClaims().has("eligible"), false);
});

test("live game ID lookup takes precedence over a reusable PIN", () => {
    const manager = new SessionManager();
    const session = manager.startSession({ pin: "111111", startedAt: START });
    manager.attachLiveGameId(session.id, "live-game-1");
    assert.equal(manager.findSession("wrong-pin", "live-game-1")?.id, session.id);
    assert.equal(manager.findSession("111111")?.id, session.id);
});
