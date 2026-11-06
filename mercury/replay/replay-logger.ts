import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Player } from "../players/identity.js";
import type { QuestionProcessOutcome } from "../scoring/session-scoring.js";
import { escapeCsv } from "../challenge-place/exception-reporter.js";

const REPLAY_COLUMNS = [
    "session_id",
    "pin",
    "live_game_id",
    "match_id",
    "home_team_id",
    "away_team_id",
    "question_index",
    "event_hash",
    "occurred_at",
    "outcome",
    "complete",
    "controller_id",
    "original_nickname",
    "registered_player_id",
    "challenge_player_id",
    "team_id",
    "points",
    "reaction_time_ms",
    "is_correct",
    "accumulated_points",
    "original_home_mean",
    "original_away_mean",
    "original_difference_percent",
    "original_goal_awarded",
    "original_scoring_team_id",
    "original_credited_player_id",
] as const;

export interface ReplayObservedResult {
    controllerId: string;
    nickname?: string;
    points: number;
    reactionTimeMs?: number;
    isCorrect?: boolean;
    accumulatedPoints?: number;
}

export interface ReplayQuestionObservation {
    sessionId: string;
    pin: string;
    liveGameId: string;
    matchId: string | null;
    homeTeamId: string | null;
    awayTeamId: string | null;
    questionIndex: number;
    eventHash: string;
    occurredAt: string;
    complete: boolean;
    results: readonly ReplayObservedResult[];
    verifiedPlayers: ReadonlyMap<string, Player>;
    participantNicknames: ReadonlyMap<string, string>;
    outcome: QuestionProcessOutcome;
}

export interface ReplayLoggerOptions {
    enabled: boolean;
    rootDirectory: string;
    onError?: (error: Error) => void;
}

function safeName(value: string): string {
    const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    return safe.length === 0 ? "unknown" : safe;
}

function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function finalizedQuestion(outcome: QuestionProcessOutcome) {
    return outcome.kind === "FINALIZED"
        || outcome.kind === "DUPLICATE"
        || outcome.kind === "CONFLICT"
        ? outcome.question
        : null;
}

export class ReplayLogger {
    readonly enabled: boolean;
    readonly rootDirectory: string;
    private readonly onError: (error: Error) => void;
    private readonly initializedFiles = new Set<string>();

    constructor(options: ReplayLoggerOptions) {
        this.enabled = options.enabled;
        this.rootDirectory = resolve(options.rootDirectory);
        this.onError = options.onError ?? ((error) => {
            console.error("[REPLAY] log write failed", error);
        });
    }

    logQuestion(observation: ReplayQuestionObservation): string | null {
        if (!this.enabled) return null;
        const file = this.filePath(observation);
        const original = finalizedQuestion(observation.outcome);
        const rows = observation.results.map((result) => {
            const player = observation.verifiedPlayers.get(result.controllerId);
            const nickname = result.nickname
                ?? observation.participantNicknames.get(result.controllerId)
                ?? "";
            return [
                observation.sessionId,
                observation.pin,
                observation.liveGameId,
                observation.matchId,
                observation.homeTeamId,
                observation.awayTeamId,
                observation.questionIndex,
                observation.eventHash,
                observation.occurredAt,
                observation.outcome.kind,
                observation.complete,
                result.controllerId,
                nickname,
                player?.id,
                player?.challengePlayerId,
                player?.teamId,
                result.points,
                result.reactionTimeMs,
                result.isCorrect,
                result.accumulatedPoints,
                original?.homeMean,
                original?.awayMean,
                original?.differencePercent,
                original?.goalAwarded,
                original?.scoringTeamId,
                original?.creditedPlayer?.id,
            ].map(escapeCsv).join(",");
        });
        try {
            mkdirSync(this.rootDirectory, { recursive: true });
            if (!this.initializedFiles.has(file)) {
                if (!existsSync(file)) appendFileSync(file, `${REPLAY_COLUMNS.join(",")}\n`, "utf8");
                this.initializedFiles.add(file);
            }
            if (rows.length > 0) appendFileSync(file, `${rows.join("\n")}\n`, "utf8");
            return file;
        } catch (error: unknown) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.onError(normalized);
            throw normalized;
        }
    }

    private filePath(observation: ReplayQuestionObservation): string {
        const identity = `${observation.liveGameId}:${observation.sessionId}`;
        return join(
            this.rootDirectory,
            [
                "kahoot-replay",
                safeName(observation.matchId ?? "unresolved"),
                safeName(observation.sessionId),
                shortHash(identity),
            ].join("-") + ".csv",
        );
    }
}
