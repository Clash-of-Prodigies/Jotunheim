import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Player } from "../players/identity.js";
import type { FinalizedQuestion, QuestionProcessOutcome } from "../scoring/session-scoring.js";
import { replayFile } from "../scripts/replay-kahoot.js";
import { csvObjects } from "./replay-file.js";
import { ReplayLogger, type ReplayQuestionObservation } from "./replay-logger.js";

const homePlayer: Player = {
    id: "player-home",
    name: "Home Player",
    challengePlayerId: "challenge-home",
    teamId: "home-team",
    nickname: "Home",
};

const awayPlayer: Player = {
    id: "player-away",
    name: "Away Player",
    challengePlayerId: "challenge-away",
    teamId: "away-team",
    nickname: "Away",
};

function finalizedQuestion(): FinalizedQuestion {
    return {
        questionIndex: 0,
        eventHash: "hash-finalized",
        participants: [
            { controllerId: "controller-home", player: homePlayer, points: 1_000 },
            { controllerId: "controller-away", player: awayPlayer, points: 0 },
        ],
        homeMean: 1_000,
        awayMean: 0,
        differencePercent: 100,
        goalAwarded: true,
        scoringTeamId: "home-team",
        creditedPlayer: homePlayer,
        scorerAttribution: "RESOLVED",
        homeGoalsAfter: 1,
        awayGoalsAfter: 0,
    };
}

function observation(
    outcome: QuestionProcessOutcome,
    overrides: Partial<ReplayQuestionObservation> = {},
): ReplayQuestionObservation {
    return {
        sessionId: "session-one",
        pin: "1234567",
        liveGameId: "live-one",
        matchId: "match-one",
        homeTeamId: "home-team",
        awayTeamId: "away-team",
        questionIndex: 0,
        eventHash: "hash-finalized",
        occurredAt: "2026-10-31T12:00:00.000Z",
        complete: true,
        results: [
            {
                controllerId: "controller-home",
                nickname: "Ace, \"One\"",
                points: 1_000,
                reactionTimeMs: 500,
                isCorrect: true,
                accumulatedPoints: 1_000,
            },
            {
                controllerId: "controller-away",
                points: 0,
                reactionTimeMs: 1_000,
                isCorrect: false,
                accumulatedPoints: 0,
            },
        ],
        verifiedPlayers: new Map([
            ["controller-home", homePlayer],
            ["controller-away", awayPlayer],
        ]),
        participantNicknames: new Map([["controller-away", "Away Lobby Name"]]),
        outcome,
        ...overrides,
    };
}

test("disabled replay logging performs no filesystem writes", () => {
    const parent = mkdtempSync(join(tmpdir(), "replay-disabled-test-"));
    const rootDirectory = join(parent, "replays");
    try {
        const logger = new ReplayLogger({ enabled: false, rootDirectory });
        const path = logger.logQuestion(observation({
            kind: "FINALIZED",
            question: finalizedQuestion(),
        }));
        assert.equal(path, null);
        assert.equal(existsSync(rootDirectory), false);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test("enabled replay logging preserves raw values and CSV escaping", () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-enabled-test-"));
    try {
        const logger = new ReplayLogger({ enabled: true, rootDirectory: directory });
        const path = logger.logQuestion(observation({
            kind: "FINALIZED",
            question: finalizedQuestion(),
        }));
        assert.ok(path !== null);
        const rows = csvObjects(readFileSync(path, "utf8"));
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.original_nickname, "Ace, \"One\"");
        assert.equal(rows[0]?.accumulated_points, "1000");
        assert.equal(rows[1]?.original_nickname, "Away Lobby Name");
        assert.equal(rows[1]?.points, "0");
        assert.equal(rows[1]?.accumulated_points, "0");
        assert.equal(rows[1]?.is_correct, "false");
        assert.equal(rows[1]?.registered_player_id, "player-away");
        assert.equal(rows[0]?.original_goal_awarded, "true");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("unknown participants remain in replay evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-unknown-test-"));
    try {
        const logger = new ReplayLogger({ enabled: true, rootDirectory: directory });
        const path = logger.logQuestion(observation(
            {
                kind: "PENDING",
                issue: {
                    questionIndex: 1,
                    reason: "UNKNOWN_CONTROLLER",
                    eventHash: "hash-pending",
                    controllerId: "controller-unknown",
                },
            },
            {
                questionIndex: 1,
                eventHash: "hash-pending",
                results: [{
                    controllerId: "controller-unknown",
                    nickname: "Unverified",
                    points: 321,
                    accumulatedPoints: 654,
                }],
                verifiedPlayers: new Map(),
                participantNicknames: new Map(),
            },
        ));
        assert.ok(path !== null);
        const [row] = csvObjects(readFileSync(path, "utf8"));
        assert.equal(row?.outcome, "PENDING");
        assert.equal(row?.original_nickname, "Unverified");
        assert.equal(row?.registered_player_id, "");
        assert.equal(row?.challenge_player_id, "");
        assert.equal(row?.team_id, "");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("offline replay reconstructs and compares finalized scoring without a transport", () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-offline-test-"));
    try {
        const logger = new ReplayLogger({ enabled: true, rootDirectory: directory });
        const path = logger.logQuestion(observation({
            kind: "FINALIZED",
            question: finalizedQuestion(),
        }));
        assert.ok(path !== null);
        assert.deepEqual(replayFile(path), [{
            liveGameId: "live-one",
            questionIndex: 0,
            matchesOriginal: true,
            differences: [],
        }]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
