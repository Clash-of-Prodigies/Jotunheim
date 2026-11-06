import assert from "node:assert/strict";
import test from "node:test";
import type { MatchFixture } from "../matches/match-repository.js";
import type { Player } from "../players/identity.js";
import {
    SessionScoringState,
    type QuestionResultsInput,
} from "./session-scoring.js";

const fixture: MatchFixture = {
    id: "match-ab",
    homeTeam: "team-a",
    awayTeam: "team-b",
    scheduledAt: "2026-11-01T18:00:00.000Z",
    stage: "Synthetic",
    status: "SCHEDULED",
    updatedAt: "2026-11-01T18:00:00.000Z",
};
const players = new Map<string, Player>([
    ["a1", {
        id: "player-a1", name: "Alice", challengePlayerId: "cp-a1",
        teamId: "team-a", nickname: null,
    }],
    ["a2", {
        id: "player-a2", name: "Ada", challengePlayerId: "cp-a2",
        teamId: "team-a", nickname: null,
    }],
    ["b1", {
        id: "player-b1", name: "Bob", challengePlayerId: "cp-b1",
        teamId: "team-b", nickname: null,
    }],
    ["c1", {
        id: "player-c1", name: "Carol", challengePlayerId: "cp-c1",
        teamId: "team-c", nickname: null,
    }],
]);

function question(
    questionIndex: number,
    points: Record<string, number>,
    overrides: Partial<QuestionResultsInput> = {},
): QuestionResultsInput {
    const controllerIds = Object.keys(points);
    return {
        liveGameId: "live-game",
        questionIndex,
        complete: true,
        participantSnapshotControllerIds: controllerIds,
        results: controllerIds.map((controllerId) => ({
            controllerId,
            points: points[controllerId] ?? 0,
            reactionTimeMs: 500 + questionIndex,
            isCorrect: (points[controllerId] ?? 0) > 0,
        })),
        ...overrides,
    };
}

function context(overrides: Record<string, unknown> = {}) {
    return {
        liveGameId: "live-game",
        fixture,
        verifiedPlayers: players,
        integritySafe: true,
        ...overrides,
    };
}

test("finalizes once and preserves reaction time", () => {
    const state = new SessionScoringState();
    const input = question(0, { a1: 1000, b1: 900 });
    const first = state.process(input, context());
    assert.equal(first.kind, "FINALIZED");
    if (first.kind === "FINALIZED") {
        assert.equal(first.question.participants[0]?.reactionTimeMs, 500);
        assert.equal(first.question.goalAwarded, true);
    }
    const duplicate = state.process(input, context());
    assert.equal(duplicate.kind, "DUPLICATE");
    assert.equal(state.homeGoals, 1);
    assert.equal(state.finalizedQuestions.size, 1);
});

test("preserves the original score and becomes unsafe on a conflicting duplicate", () => {
    const state = new SessionScoringState();
    state.process(question(0, { a1: 1000, b1: 900 }), context());
    const conflict = state.process(question(0, { a1: 100, b1: 900 }), context());
    assert.equal(conflict.kind, "CONFLICT");
    assert.equal(state.homeGoals, 1);
    assert.equal(state.awayGoals, 0);
    assert.equal(state.scoringSafe, false);
    assert.equal(state.conflictingQuestions.size, 1);
});

test("holds incomplete results and finalizes a later complete replay", () => {
    const state = new SessionScoringState();
    const partial = question(0, { a1: 1000 }, {
        complete: false,
        participantSnapshotControllerIds: ["a1", "b1"],
    });
    assert.equal(state.process(partial, context()).kind, "PENDING");
    assert.equal(state.homeGoals, 0);
    assert.equal(state.scoringSafe, false);

    const complete = state.process(question(0, { a1: 1000, b1: 900 }), context());
    assert.equal(complete.kind, "FINALIZED");
    assert.equal(state.pendingQuestions.size, 0);
    assert.equal(state.scoringSafe, true);
});

test("processes out-of-order questions without duplicating goals", () => {
    const state = new SessionScoringState();
    state.process(question(2, { a1: 1000, b1: 900 }), context());
    state.process(question(0, { a1: 700, b1: 1000 }), context());
    assert.equal(state.finalizedQuestions.size, 2);
    assert.equal(state.homeGoals, 1);
    assert.equal(state.awayGoals, 1);
    assert.equal(state.latestFinalizedQuestionIndex, 0);
});

test("holds unknown, third-team, and incomplete controller sets", () => {
    const unknown = new SessionScoringState();
    let outcome = unknown.process(question(0, { a1: 1000, missing: 900 }), context());
    assert.equal(outcome.kind, "PENDING");
    if (outcome.kind === "PENDING") assert.equal(outcome.issue.reason, "UNKNOWN_CONTROLLER");

    const third = new SessionScoringState();
    outcome = third.process(question(0, { a1: 1000, c1: 900 }), context());
    assert.equal(outcome.kind, "PENDING");
    if (outcome.kind === "PENDING") {
        assert.equal(outcome.issue.reason, "THIRD_TEAM_PARTICIPANT");
    }

    const incomplete = new SessionScoringState();
    outcome = incomplete.process(question(0, { a1: 1000 }, {
        participantSnapshotControllerIds: ["a1", "b1"],
    }), context());
    assert.equal(outcome.kind, "PENDING");
    if (outcome.kind === "PENDING") assert.equal(outcome.issue.reason, "INCOMPLETE");
});

test("rejects another live game without inheriting score state", () => {
    const state = new SessionScoringState();
    const outcome = state.process(
        question(0, { a1: 1000, b1: 900 }, { liveGameId: "old-game" }),
        context(),
    );
    assert.equal(outcome.kind, "REJECTED_LIVE_GAME");
    assert.equal(state.finalizedQuestions.size, 0);
    assert.equal(state.scoringSafe, false);
});

test("does not score without a bound fixture or both teams", () => {
    const unbound = new SessionScoringState();
    let outcome = unbound.process(
        question(0, { a1: 1000, b1: 900 }),
        context({ fixture: null }),
    );
    assert.equal(outcome.kind, "PENDING");
    if (outcome.kind === "PENDING") assert.equal(outcome.issue.reason, "NO_BOUND_FIXTURE");

    const missingAway = new SessionScoringState();
    outcome = missingAway.process(question(0, { a1: 1000 }), context());
    assert.equal(outcome.kind, "PENDING");
    if (outcome.kind === "PENDING") {
        assert.equal(outcome.issue.reason, "MISSING_AWAY_PARTICIPANTS");
    }
});

test("marks tied scorer attribution without suppressing the team goal", () => {
    const state = new SessionScoringState();
    const outcome = state.process(question(0, { a1: 1000, a2: 1000, b1: 800 }), context());
    assert.equal(outcome.kind, "FINALIZED");
    if (outcome.kind === "FINALIZED") {
        assert.equal(outcome.question.goalAwarded, true);
        assert.equal(outcome.question.creditedPlayer, null);
        assert.equal(outcome.question.scorerAttribution, "TIED");
    }
});
