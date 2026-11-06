import { createHash } from "node:crypto";
import type { MatchFixture } from "../matches/match-repository.js";
import type { Player } from "../players/identity.js";
import {
    scoreCompletedQuestion,
    type ScorerAttribution,
    type ScoringParticipant,
} from "./scoring-engine.js";

export interface QuestionParticipantResultInput {
    controllerId: string;
    nickname?: string;
    points: number;
    reactionTimeMs?: number;
    isCorrect?: boolean;
    accumulatedPoints?: number;
}

export interface QuestionResultsInput {
    liveGameId: string;
    questionIndex: number;
    complete: boolean;
    participantSnapshotControllerIds: readonly string[];
    results: readonly QuestionParticipantResultInput[];
}

export type PendingQuestionReason =
    | "INCOMPLETE"
    | "NO_BOUND_FIXTURE"
    | "SESSION_INTEGRITY_UNSAFE"
    | "DUPLICATE_CONTROLLER"
    | "UNKNOWN_CONTROLLER"
    | "MISSING_PLAYER_TEAM"
    | "THIRD_TEAM_PARTICIPANT"
    | "MISSING_HOME_PARTICIPANTS"
    | "MISSING_AWAY_PARTICIPANTS";

export interface QuestionIssue {
    questionIndex: number;
    reason: PendingQuestionReason;
    eventHash: string;
    controllerId?: string;
}

export interface FinalizedParticipantResult {
    controllerId: string;
    player: Player;
    points: number;
    reactionTimeMs?: number;
    isCorrect?: boolean;
}

export interface FinalizedQuestion {
    questionIndex: number;
    eventHash: string;
    participants: FinalizedParticipantResult[];
    homeMean: number;
    awayMean: number;
    differencePercent: number;
    goalAwarded: boolean;
    scoringTeamId: string | null;
    creditedPlayer: Player | null;
    scorerAttribution: ScorerAttribution;
    homeGoalsAfter: number;
    awayGoalsAfter: number;
}

export type QuestionProcessOutcome =
    | { kind: "FINALIZED"; question: FinalizedQuestion }
    | { kind: "DUPLICATE"; question: FinalizedQuestion }
    | { kind: "CONFLICT"; question: FinalizedQuestion }
    | { kind: "PENDING"; issue: QuestionIssue }
    | { kind: "REJECTED_LIVE_GAME"; questionIndex: number };

export interface QuestionProcessingContext {
    liveGameId: string | null;
    fixture: MatchFixture | null;
    verifiedPlayers: ReadonlyMap<string, Player>;
    integritySafe: boolean;
}

function canonicalQuestion(input: QuestionResultsInput): string {
    return JSON.stringify({
        liveGameId: input.liveGameId,
        questionIndex: input.questionIndex,
        complete: input.complete,
        participantSnapshotControllerIds: [...input.participantSnapshotControllerIds].sort(),
        results: input.results.map((result) => ({
            controllerId: result.controllerId,
            points: result.points,
            reactionTimeMs: result.reactionTimeMs ?? null,
            isCorrect: result.isCorrect ?? null,
        })).sort((left, right) =>
            left.controllerId.localeCompare(right.controllerId)
            || left.points - right.points
            || (left.reactionTimeMs ?? -1) - (right.reactionTimeMs ?? -1)
            || String(left.isCorrect).localeCompare(String(right.isCorrect))
        ),
    });
}

export function hashQuestionResults(input: QuestionResultsInput): string {
    return createHash("sha256").update(canonicalQuestion(input)).digest("hex");
}

function unique(values: readonly string[]): boolean {
    return new Set(values).size === values.length;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
}

export class SessionScoringState {
    readonly finalizedQuestions = new Map<number, FinalizedQuestion>();
    readonly questionEventHashes = new Map<number, string>();
    readonly pendingQuestions = new Map<number, QuestionIssue>();
    readonly conflictingQuestions = new Map<number, { originalHash: string; conflictingHash: string }>();
    readonly safetyIssues = new Set<string>();
    homeGoals = 0;
    awayGoals = 0;
    latestFinalizedQuestionIndex: number | null = null;

    get scoringSafe(): boolean {
        return this.pendingQuestions.size === 0
            && this.conflictingQuestions.size === 0
            && this.safetyIssues.size === 0;
    }

    get unresolvedQuestionCount(): number {
        const indexes = new Set([
            ...this.pendingQuestions.keys(),
            ...this.conflictingQuestions.keys(),
        ]);
        return indexes.size + this.safetyIssues.size;
    }

    process(
        input: QuestionResultsInput,
        context: QuestionProcessingContext,
    ): QuestionProcessOutcome {
        if (context.liveGameId === null || input.liveGameId !== context.liveGameId) {
            this.safetyIssues.add(`LIVE_GAME_MISMATCH:${input.liveGameId}:${input.questionIndex}`);
            return { kind: "REJECTED_LIVE_GAME", questionIndex: input.questionIndex };
        }

        const eventHash = hashQuestionResults(input);
        const finalized = this.finalizedQuestions.get(input.questionIndex);
        if (finalized !== undefined) {
            if (finalized.eventHash === eventHash) return { kind: "DUPLICATE", question: finalized };
            this.conflictingQuestions.set(input.questionIndex, {
                originalHash: finalized.eventHash,
                conflictingHash: eventHash,
            });
            return { kind: "CONFLICT", question: finalized };
        }

        if (!input.complete) return this.pending(input.questionIndex, "INCOMPLETE", eventHash);
        if (context.fixture === null) {
            return this.pending(input.questionIndex, "NO_BOUND_FIXTURE", eventHash);
        }
        if (!context.integritySafe) {
            return this.pending(input.questionIndex, "SESSION_INTEGRITY_UNSAFE", eventHash);
        }

        const snapshotIds = [...input.participantSnapshotControllerIds];
        const resultIds = input.results.map((result) => result.controllerId);
        if (!unique(snapshotIds) || !unique(resultIds)) {
            return this.pending(input.questionIndex, "DUPLICATE_CONTROLLER", eventHash);
        }
        if (!sameMembers(snapshotIds, resultIds)) {
            return this.pending(input.questionIndex, "INCOMPLETE", eventHash);
        }

        const participants: FinalizedParticipantResult[] = [];
        const scoringParticipants: ScoringParticipant[] = [];
        for (const result of input.results) {
            const player = context.verifiedPlayers.get(result.controllerId);
            if (player === undefined) {
                return this.pending(
                    input.questionIndex,
                    "UNKNOWN_CONTROLLER",
                    eventHash,
                    result.controllerId,
                );
            }
            if (player.teamId === null) {
                return this.pending(
                    input.questionIndex,
                    "MISSING_PLAYER_TEAM",
                    eventHash,
                    result.controllerId,
                );
            }
            if (
                player.teamId !== context.fixture.homeTeam
                && player.teamId !== context.fixture.awayTeam
            ) {
                return this.pending(
                    input.questionIndex,
                    "THIRD_TEAM_PARTICIPANT",
                    eventHash,
                    result.controllerId,
                );
            }
            const optional = {
                ...(result.reactionTimeMs === undefined
                    ? {}
                    : { reactionTimeMs: result.reactionTimeMs }),
                ...(result.isCorrect === undefined ? {} : { isCorrect: result.isCorrect }),
            };
            participants.push({
                controllerId: result.controllerId,
                player,
                points: result.points,
                ...optional,
            });
            scoringParticipants.push({
                controllerId: result.controllerId,
                playerId: player.id,
                teamId: player.teamId,
                points: result.points,
                ...optional,
            });
        }

        const decision = scoreCompletedQuestion({
            homeTeamId: context.fixture.homeTeam,
            awayTeamId: context.fixture.awayTeam,
            participants: scoringParticipants,
        });
        if (decision.status === "UNRESOLVED") {
            return this.pending(input.questionIndex, decision.reason, eventHash);
        }

        if (decision.goalAwarded) {
            if (decision.scoringTeamId === context.fixture.homeTeam) this.homeGoals += 1;
            else if (decision.scoringTeamId === context.fixture.awayTeam) this.awayGoals += 1;
        }
        const creditedPlayer = decision.creditedPlayerId === null
            ? null
            : participants.find(
                (participant) => participant.player.id === decision.creditedPlayerId,
            )?.player ?? null;
        const question: FinalizedQuestion = {
            questionIndex: input.questionIndex,
            eventHash,
            participants,
            homeMean: decision.homeMean,
            awayMean: decision.awayMean,
            differencePercent: decision.differencePercent,
            goalAwarded: decision.goalAwarded,
            scoringTeamId: decision.scoringTeamId,
            creditedPlayer,
            scorerAttribution: decision.scorerAttribution,
            homeGoalsAfter: this.homeGoals,
            awayGoalsAfter: this.awayGoals,
        };
        this.finalizedQuestions.set(input.questionIndex, question);
        this.questionEventHashes.set(input.questionIndex, eventHash);
        this.pendingQuestions.delete(input.questionIndex);
        this.latestFinalizedQuestionIndex = input.questionIndex;
        return { kind: "FINALIZED", question };
    }

    private pending(
        questionIndex: number,
        reason: PendingQuestionReason,
        eventHash: string,
        controllerId?: string,
    ): QuestionProcessOutcome {
        const issue: QuestionIssue = {
            questionIndex,
            reason,
            eventHash,
            ...(controllerId === undefined ? {} : { controllerId }),
        };
        this.pendingQuestions.set(questionIndex, issue);
        return { kind: "PENDING", issue };
    }
}
