import assert from "node:assert/strict";
import test from "node:test";
import {
    scoreCompletedQuestion,
    type ScoringParticipant,
} from "./scoring-engine.js";

function participant(
    playerId: string,
    teamId: string,
    points: number,
    reactionTimeMs?: number,
): ScoringParticipant {
    return {
        controllerId: `controller-${playerId}`,
        playerId,
        teamId,
        points,
        ...(reactionTimeMs === undefined ? {} : { reactionTimeMs }),
    };
}

function score(participants: ScoringParticipant[]) {
    return scoreCompletedQuestion({
        homeTeamId: "home",
        awayTeamId: "away",
        participants,
    });
}

test("awards home and away goals to the higher team mean", () => {
    const home = score([
        participant("home-player", "home", 1000),
        participant("away-player", "away", 900),
    ]);
    assert.equal(home.status, "SCORED");
    if (home.status === "SCORED") {
        assert.equal(home.goalAwarded, true);
        assert.equal(home.scoringTeamId, "home");
        assert.equal(home.creditedPlayerId, "home-player");
    }

    const away = score([
        participant("home-player", "home", 800),
        participant("away-player", "away", 1000),
    ]);
    assert.equal(away.status, "SCORED");
    if (away.status === "SCORED") assert.equal(away.scoringTeamId, "away");
});

test("uses a strict greater-than two-percent goal boundary", () => {
    const exact = score([
        participant("home-player", "home", 100),
        participant("away-player", "away", 98),
    ]);
    assert.equal(exact.status, "SCORED");
    if (exact.status === "SCORED") {
        assert.equal(exact.differencePercent, 2);
        assert.equal(exact.goalAwarded, false);
    }

    const greater = score([
        participant("home-player", "home", 100),
        participant("away-player", "away", 97.99),
    ]);
    assert.equal(greater.status, "SCORED");
    if (greater.status === "SCORED") assert.equal(greater.goalAwarded, true);
});

test("equal and all-zero means do not award goals", () => {
    for (const points of [500, 0]) {
        const decision = score([
            participant("home-player", "home", points),
            participant("away-player", "away", points),
        ]);
        assert.equal(decision.status, "SCORED");
        if (decision.status === "SCORED") {
            assert.equal(decision.differencePercent, 0);
            assert.equal(decision.goalAwarded, false);
        }
    }
});

test("permits unequal player counts and zero-point incorrect answers", () => {
    const decision = score([
        participant("home-one", "home", 1000),
        participant("home-two", "home", 0),
        participant("away-one", "away", 400),
    ]);
    assert.equal(decision.status, "SCORED");
    if (decision.status === "SCORED") {
        assert.equal(decision.homeMean, 500);
        assert.equal(decision.awayMean, 400);
        assert.equal(decision.scoringTeamId, "home");
    }
});

test("credits the highest current-question scorer", () => {
    const decision = score([
        participant("home-one", "home", 1000, 400),
        participant("home-two", "home", 900, 300),
        participant("away-one", "away", 800, 200),
    ]);
    assert.equal(decision.status, "SCORED");
    if (decision.status === "SCORED") {
        assert.equal(decision.creditedPlayerId, "home-one");
        assert.equal(decision.scorerAttribution, "RESOLVED");
    }
});

test("leaves scorer attribution unresolved on a winning-team tie", () => {
    const decision = score([
        participant("home-one", "home", 1000),
        participant("home-two", "home", 1000),
        participant("away-one", "away", 800),
    ]);
    assert.equal(decision.status, "SCORED");
    if (decision.status === "SCORED") {
        assert.equal(decision.goalAwarded, true);
        assert.equal(decision.creditedPlayerId, null);
        assert.equal(decision.scorerAttribution, "TIED");
    }
});

test("does not assign a zero mean when a team has no participants", () => {
    assert.deepEqual(
        score([participant("home-one", "home", 1000)]),
        { status: "UNRESOLVED", reason: "MISSING_AWAY_PARTICIPANTS" },
    );
    assert.deepEqual(
        score([participant("away-one", "away", 1000)]),
        { status: "UNRESOLVED", reason: "MISSING_HOME_PARTICIPANTS" },
    );
});
