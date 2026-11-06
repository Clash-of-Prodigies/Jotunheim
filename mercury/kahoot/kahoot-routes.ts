import type Database from "better-sqlite3";
import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
} from "fastify";
import type { ChallengePlaceWriter } from "../challenge-place/challenge-place-writer.js";
import { isTerminalPublicationStatus } from "../challenge-place/publication-types.js";
import { listEligibleMatches } from "../matches/match-repository.js";
import { normalizeScheduledAt } from "../matches/timestamps.js";
import { resolvePlayer } from "../players/identity.js";
import type { ReplayLogger } from "../replay/replay-logger.js";
import { hashQuestionResults } from "../scoring/session-scoring.js";
import type {
    FinalizedQuestion,
    QuestionProcessOutcome,
    QuestionResultsInput,
} from "../scoring/session-scoring.js";
import type { ActiveKahootSession } from "../sessions/session-manager.js";
import { SessionManager } from "../sessions/session-manager.js";

interface SessionStartedEvent {
    type: "SESSION_STARTED";
    sessionId: string;
    occurredAt: string;
    liveGameId?: string;
}

interface ParticipantJoinedEvent {
    type: "PARTICIPANT_JOINED";
    sessionId: string;
    controllerId: string;
    nickname: string;
    occurredAt: string;
}

interface ParticipantLeftEvent {
    type: "PARTICIPANT_LEFT";
    sessionId: string;
    controllerId: string;
    occurredAt: string;
}

interface SessionEndedEvent {
    type: "SESSION_ENDED";
    sessionId: string;
    occurredAt: string;
}

interface QuestionResultsEvent extends QuestionResultsInput {
    type: "QUESTION_RESULTS";
    sessionId: string;
    occurredAt: string;
}

export type KahootEvent =
    | SessionStartedEvent
    | ParticipantJoinedEvent
    | ParticipantLeftEvent
    | SessionEndedEvent
    | QuestionResultsEvent;

export interface KahootRoutesOptions {
    database: Database.Database;
    sessionManager: SessionManager;
    developmentToken: string;
    challengePlaceWriter?: ChallengePlaceWriter;
    replayLogger?: ReplayLogger;
}

export interface SessionStatusResponse {
    sessionId: string;
    pin: string;
    liveGameId: string | null;
    startedAt: string;
    status: ActiveKahootSession["resolution"]["status"];
    participantCount: number;
    verifiedParticipantCount: number;
    flaggedIdentities: Array<{
        controllerId: string;
        nickname: string;
        reason: "UNMATCHED" | "AMBIGUOUS" | "CONFLICT" | "MISSING_TEAM";
    }>;
    detectedTeamIds: string[];
    candidateFixtureIds: string[];
    confirmedMatchId: string | null;
    publicationSafe: boolean;
    readyToPublish: boolean;
    finalizedQuestionCount: number;
    homeGoals: number;
    awayGoals: number;
    latestFinalizedQuestionIndex: number | null;
    pendingOrConflictingQuestionCount: number;
    scoringSafe: boolean;
    questionSummaries: Array<{
        questionIndex: number;
        homeMean: number;
        awayMean: number;
        differencePercent: number;
        goalAwarded: boolean;
        scoringTeamId: string | null;
        creditedScorerName: string | null;
        scorerAttribution: FinalizedQuestion["scorerAttribution"];
    }>;
    publicationConfirmedGoals: number;
    publicationUnresolvedGoals: number;
    publicationQueuedGoals: number;
    publicationExceptionReportPath: string | null;
}

const timestampSchema = { type: "string", format: "date-time" } as const;
const identifierSchema = { type: "string", minLength: 1, maxLength: 200 } as const;

const eventSchema = {
    type: "object",
    additionalProperties: false,
    required: ["type", "sessionId", "occurredAt"],
    properties: {
        type: {
            type: "string",
            enum: [
                "SESSION_STARTED", "PARTICIPANT_JOINED", "PARTICIPANT_LEFT",
                "SESSION_ENDED", "QUESTION_RESULTS",
            ],
        },
        sessionId: identifierSchema,
        occurredAt: timestampSchema,
        liveGameId: identifierSchema,
        controllerId: identifierSchema,
        nickname: { type: "string", minLength: 1, maxLength: 200 },
        questionIndex: { type: "integer", minimum: 0 },
        complete: { type: "boolean" },
        participantSnapshotControllerIds: {
            type: "array",
            maxItems: 500,
            items: identifierSchema,
        },
        results: {
            type: "array",
            maxItems: 500,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["controllerId", "points"],
                properties: {
                    controllerId: identifierSchema,
                    nickname: { type: "string", minLength: 1, maxLength: 200 },
                    points: { type: "number", minimum: 0 },
                    reactionTimeMs: { type: "number", minimum: 0 },
                    isCorrect: { type: "boolean" },
                    accumulatedPoints: { type: "number", minimum: 0 },
                },
            },
        },
    },
    oneOf: [
        {
            properties: { type: { const: "SESSION_STARTED" } },
            not: {
                anyOf: [
                    { required: ["controllerId"] }, { required: ["nickname"] },
                    { required: ["questionIndex"] }, { required: ["complete"] },
                    { required: ["participantSnapshotControllerIds"] },
                    { required: ["results"] },
                ],
            },
        },
        {
            properties: { type: { const: "PARTICIPANT_JOINED" } },
            required: ["controllerId", "nickname"],
            not: {
                anyOf: [
                    { required: ["liveGameId"] }, { required: ["questionIndex"] },
                    { required: ["complete"] },
                    { required: ["participantSnapshotControllerIds"] },
                    { required: ["results"] },
                ],
            },
        },
        {
            properties: { type: { const: "PARTICIPANT_LEFT" } },
            required: ["controllerId"],
            not: {
                anyOf: [
                    { required: ["liveGameId"] }, { required: ["nickname"] },
                    { required: ["questionIndex"] }, { required: ["complete"] },
                    { required: ["participantSnapshotControllerIds"] },
                    { required: ["results"] },
                ],
            },
        },
        {
            properties: { type: { const: "SESSION_ENDED" } },
            not: {
                anyOf: [
                    { required: ["liveGameId"] }, { required: ["controllerId"] },
                    { required: ["nickname"] }, { required: ["questionIndex"] },
                    { required: ["complete"] },
                    { required: ["participantSnapshotControllerIds"] },
                    { required: ["results"] },
                ],
            },
        },
        {
            required: [
                "liveGameId", "questionIndex", "complete",
                "participantSnapshotControllerIds", "results",
            ],
            properties: { type: { const: "QUESTION_RESULTS" } },
            not: {
                anyOf: [
                    { required: ["controllerId"] },
                    { required: ["nickname"] },
                ],
                },
        },
    ],
} as const;

function isReadyToPublish(session: ActiveKahootSession): boolean {
    if (
        session.boundMatchId === null
        || session.resolution.status !== "RESOLVED"
        || session.publicationBlocked
        || !session.scoring.scoringSafe
        || session.participants.size === 0
    ) {
        return false;
    }
    return [...session.participants.values()].every((participant) =>
        participant.resolution.status === "MATCHED"
        && participant.resolution.player.teamId !== null
    );
}

function sessionView(
    session: ActiveKahootSession,
    writer?: ChallengePlaceWriter,
): SessionStatusResponse {
    const flaggedIdentities: SessionStatusResponse["flaggedIdentities"] = [];
    for (const participant of session.participants.values()) {
        let reason: SessionStatusResponse["flaggedIdentities"][number]["reason"] | null = null;
        if (session.identityConflicts.has(participant.controllerId)) reason = "CONFLICT";
        else if (participant.resolution.status === "NOT_FOUND") reason = "UNMATCHED";
        else if (participant.resolution.status === "AMBIGUOUS") reason = "AMBIGUOUS";
        else if (participant.resolution.player.teamId === null) reason = "MISSING_TEAM";
        if (reason !== null) {
            flaggedIdentities.push({
                controllerId: participant.controllerId,
                nickname: participant.nickname,
                reason,
            });
        }
    }
    const questionSummaries = [...session.scoring.finalizedQuestions.values()]
        .sort((left, right) => left.questionIndex - right.questionIndex)
        .map((question) => ({
            questionIndex: question.questionIndex,
            homeMean: question.homeMean,
            awayMean: question.awayMean,
            differencePercent: question.differencePercent,
            goalAwarded: question.goalAwarded,
            scoringTeamId: question.scoringTeamId,
            creditedScorerName: question.creditedPlayer?.name ?? null,
            scorerAttribution: question.scorerAttribution,
        }));
    const publication = writer?.getSessionSummary(session.id);
    return {
        sessionId: session.id,
        pin: session.pin,
        liveGameId: session.liveGameId,
        startedAt: session.startedAt,
        status: session.resolution.status,
        participantCount: session.participants.size,
        verifiedParticipantCount: session.controllerToPlayer.size,
        flaggedIdentities,
        detectedTeamIds: [...session.detectedTeamIds].sort(),
        candidateFixtureIds: [...session.candidateFixtureIds],
        confirmedMatchId: session.boundMatchId,
        publicationSafe: !session.publicationBlocked,
        readyToPublish: isReadyToPublish(session),
        finalizedQuestionCount: session.scoring.finalizedQuestions.size,
        homeGoals: session.scoring.homeGoals,
        awayGoals: session.scoring.awayGoals,
        latestFinalizedQuestionIndex: session.scoring.latestFinalizedQuestionIndex,
        pendingOrConflictingQuestionCount: session.scoring.unresolvedQuestionCount,
        scoringSafe: session.scoring.scoringSafe,
        questionSummaries,
        publicationConfirmedGoals: publication?.confirmedGoals ?? 0,
        publicationUnresolvedGoals: publication?.unresolvedSubmissions ?? 0,
        publicationQueuedGoals: publication?.queuedSubmissions ?? 0,
        publicationExceptionReportPath: publication?.exceptionReportPath ?? null,
    };
}

function requireTimestamp(timestamp: string): string {
    const normalized = normalizeScheduledAt(timestamp);
    if (normalized === null) throw new Error("occurredAt must be a valid timezone-qualified timestamp.");
    return normalized;
}

function formatPlayerLine(question: FinalizedQuestion, teamId: string): string[] {
    return question.participants
        .filter((participant) => participant.player.teamId === teamId)
        .map((participant) => {
            const reaction = participant.reactionTimeMs === undefined
                ? ""
                : `   ${participant.reactionTimeMs} ms`;
            return `  ${participant.player.name.padEnd(18)} ${String(participant.points).padStart(6)} points${reaction}`;
        });
}

function formatQuestionSummary(session: ActiveKahootSession, question: FinalizedQuestion): string {
    const fixture = session.boundFixture;
    if (fixture === null) return `[CLASH RELAY] Session ${session.id} lost its fixture.`;
    const homeLines = formatPlayerLine(question, fixture.homeTeam);
    const awayLines = formatPlayerLine(question, fixture.awayTeam);
    const goal = !question.goalAwarded
        ? "GOAL: None"
        : `GOAL: ${question.scoringTeamId}`;
    const scorer = question.scorerAttribution === "TIED"
        ? "Scorer: Unresolved (tie)"
        : question.creditedPlayer === null
            ? "Scorer: None"
            : `Scorer: ${question.creditedPlayer.name}`;
    return [
        `[CLASH RELAY] Session ${session.id} | Question ${question.questionIndex + 1}`,
        `Match: ${fixture.homeTeam} vs ${fixture.awayTeam} (${fixture.id})`,
        "",
        `HOME — ${fixture.homeTeam}`,
        ...homeLines,
        `  Average: ${question.homeMean.toFixed(2)}`,
        "",
        `AWAY — ${fixture.awayTeam}`,
        ...awayLines,
        `  Average: ${question.awayMean.toFixed(2)}`,
        "",
        `Difference: ${question.differencePercent.toFixed(2)}%`,
        goal,
        scorer,
        "",
        `SCORE: ${fixture.homeTeam} ${question.homeGoalsAfter} - ${question.awayGoalsAfter} ${fixture.awayTeam}`,
    ].join("\n");
}

function reportQuestionOutcome(
    request: FastifyRequest,
    session: ActiveKahootSession,
    outcome: QuestionProcessOutcome,
): void {
    if (outcome.kind === "FINALIZED") {
        request.log.info(
            { sessionId: session.id, questionIndex: outcome.question.questionIndex },
            formatQuestionSummary(session, outcome.question),
        );
        if (outcome.question.scorerAttribution === "TIED") {
            request.log.warn(
                { sessionId: session.id, questionIndex: outcome.question.questionIndex },
                "Unresolved scorer attribution: winning-team players tied.",
            );
        }
    } else if (outcome.kind === "DUPLICATE") {
        request.log.info(
            { sessionId: session.id, questionIndex: outcome.question.questionIndex },
            "Duplicate question ignored.",
        );
    } else if (outcome.kind === "CONFLICT") {
        request.log.error(
            { sessionId: session.id, questionIndex: outcome.question.questionIndex },
            "Conflicting question payload; original decision preserved.",
        );
    } else if (outcome.kind === "PENDING") {
        request.log.warn(
            {
                sessionId: session.id,
                questionIndex: outcome.issue.questionIndex,
                reason: outcome.issue.reason,
                controllerId: outcome.issue.controllerId,
            },
            `Question held without scoring: ${outcome.issue.reason}.`,
        );
    } else {
        request.log.error(
            { sessionId: session.id, questionIndex: outcome.questionIndex },
            "Question belongs to another or unavailable live game.",
        );
    }
}

export async function registerKahootRoutes(
    fastify: FastifyInstance,
    options: KahootRoutesOptions,
): Promise<void> {
    if (options.developmentToken.length === 0) {
        throw new Error("KAHOOT_DEV_TOKEN is required to enable Kahoot event routes.");
    }

    const writer = options.challengePlaceWriter;
    const unsubscribePublication = writer?.onStatus((record) => {
        if (!isTerminalPublicationStatus(record.status)) return;
        const message = `[CP] ${record.matchId} | Q${record.questionIndex + 1} | ${record.scoringCompetitorId} goal | ${record.status}`;
        const fields = {
            sessionId: record.sessionId,
            liveGameId: record.liveGameId,
            matchId: record.matchId,
            questionIndex: record.questionIndex,
            publicationStatus: record.status,
        };
        if (record.status === "CONFIRMED") fastify.log.info(fields, message);
        else fastify.log.warn(fields, message);
    });
    if (unsubscribePublication !== undefined) {
        fastify.addHook("onClose", async () => { unsubscribePublication(); });
    }
    const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        if (request.headers.authorization !== `Bearer ${options.developmentToken}`) {
            await reply.code(401).send({ error: "Unauthorized" });
        }
    };

    fastify.post<{ Body: KahootEvent }>("/api/kahoot/events", {
        schema: { body: eventSchema },
        preHandler: authenticate,
    }, async (request, reply) => {
        const event = request.body;
        try {
            requireTimestamp(event.occurredAt);

            if (event.type === "SESSION_STARTED") {
                const normalizedStart = requireTimestamp(event.occurredAt);
                const existing = options.sessionManager.getSession(event.sessionId);
                if (existing !== null) {
                    if (existing.startedAt !== normalizedStart) {
                        return reply.code(409).send({ error: "Session already started with another timestamp." });
                    }
                    if (event.liveGameId !== undefined) {
                        if (
                            existing.liveGameId !== null
                            && existing.liveGameId !== event.liveGameId
                        ) {
                            return reply.code(409).send({ error: "Session already has another live game ID." });
                        }
                        options.sessionManager.attachLiveGameId(existing.id, event.liveGameId);
                    }
                    return sessionView(existing, writer);
                }
                const startInput = event.liveGameId === undefined
                    ? {
                        sessionId: event.sessionId,
                        pin: event.sessionId,
                        startedAt: normalizedStart,
                    }
                    : {
                        sessionId: event.sessionId,
                        pin: event.sessionId,
                        startedAt: normalizedStart,
                        liveGameId: event.liveGameId,
                    };
                return sessionView(options.sessionManager.startSession(startInput), writer);
            }

            const session = options.sessionManager.getSession(event.sessionId);
            if (session === null) {
                return reply.code(404).send({ error: `Unknown session ${event.sessionId}.` });
            }

            if (event.type === "QUESTION_RESULTS") {
                const scoringInput: QuestionResultsInput = {
                    liveGameId: event.liveGameId,
                    questionIndex: event.questionIndex,
                    complete: event.complete,
                    participantSnapshotControllerIds: event.participantSnapshotControllerIds,
                    results: event.results,
                };
                const outcome = options.sessionManager.processQuestionResults(
                    session.id,
                    scoringInput,
                );
                reportQuestionOutcome(request, session, outcome);
                options.replayLogger?.logQuestion({
                    sessionId: session.id,
                    pin: session.pin,
                    liveGameId: event.liveGameId,
                    matchId: session.boundMatchId,
                    homeTeamId: session.boundFixture?.homeTeam ?? null,
                    awayTeamId: session.boundFixture?.awayTeam ?? null,
                    questionIndex: event.questionIndex,
                    eventHash: hashQuestionResults(scoringInput),
                    occurredAt: event.occurredAt,
                    complete: event.complete,
                    results: event.results,
                    verifiedPlayers: session.verifiedPlayers,
                    participantNicknames: new Map(
                        [...session.participants].map(([controllerId, participant]) => [
                            controllerId,
                            participant.nickname,
                        ]),
                    ),
                    outcome,
                });
                const publishable = session.resolution.status === "RESOLVED"
                    && !session.publicationBlocked
                    && session.scoring.scoringSafe;
                writer?.setSessionPublishable(session.id, publishable);
                if (
                    outcome.kind === "FINALIZED"
                    && outcome.question.goalAwarded
                    && publishable
                    && session.boundFixture !== null
                ) {
                    const scoringCompetitorId = outcome.question.scoringTeamId;
                    if (scoringCompetitorId !== null) writer?.enqueue({
                        sessionId: session.id,
                        liveGameId: event.liveGameId,
                        matchId: session.boundFixture.id,
                        questionIndex: outcome.question.questionIndex,
                        scoringCompetitorId,
                        opponentCompetitorId: scoringCompetitorId === session.boundFixture.homeTeam
                            ? session.boundFixture.awayTeam
                            : session.boundFixture.homeTeam,
                        creditedChallengePlayerId: outcome.question.creditedPlayer?.challengePlayerId ?? null,
                        homeMean: outcome.question.homeMean,
                        awayMean: outcome.question.awayMean,
                        expectedHomeScore: outcome.question.homeGoalsAfter,
                        expectedAwayScore: outcome.question.awayGoalsAfter,
                        eventTimeMs: Math.max(
                            0,
                            Date.parse(event.occurredAt) - Date.parse(session.startedAt),
                        ),
                    });
                }
                return sessionView(session, writer);
            }

            const fixtures = listEligibleMatches(options.database);

            if (event.type === "PARTICIPANT_JOINED") {
                const resolution = resolvePlayer(options.database, event.nickname);
                return sessionView(options.sessionManager.recordParticipant(
                    session.id,
                    {
                        controllerId: event.controllerId,
                        nickname: event.nickname,
                        resolution,
                    },
                    fixtures,
                ), writer);
            }

            if (event.type === "PARTICIPANT_LEFT") {
                return sessionView(options.sessionManager.removeParticipant(
                    session.id,
                    event.controllerId,
                    fixtures,
                ), writer);
            }

            const finalScore = {
                homeGoals: session.scoring.homeGoals,
                awayGoals: session.scoring.awayGoals,
                finalizedQuestions: session.scoring.finalizedQuestions.size,
                unresolvedQuestions: session.scoring.unresolvedQuestionCount,
                scoringSafe: session.scoring.scoringSafe,
            };
            request.log.info(
                { sessionId: session.id, ...finalScore },
                `[CLASH RELAY] Session ${session.id} complete | SCORE ${finalScore.homeGoals}-${finalScore.awayGoals} | ${finalScore.finalizedQuestions} questions | ${finalScore.unresolvedQuestions} unresolved.`,
            );
            const publication = writer === undefined
                ? null
                : await writer.finishSession(session.id);
            if (publication !== null) {
                request.log.info(
                    {
                        ...publication,
                        matchId: session.boundMatchId,
                    },
                    [
                        `[CP] ${session.boundMatchId ?? "unresolved match"}`,
                        `Calculated: ${finalScore.homeGoals}-${finalScore.awayGoals}`,
                        `Confirmed submissions: ${publication.confirmedGoals}`,
                        `Unconfirmed submissions: ${publication.unresolvedSubmissions}`,
                        `Exception report: ${publication.exceptionReportPath ?? "none"}`,
                    ].join("\n"),
                );
            }
            options.sessionManager.completeSession(session.id, fixtures);
            return { ended: true, sessionId: event.sessionId, finalScore, publication };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Unable to process event.";
            const statusCode = /already|in use|claimed/i.test(message) ? 409 : 400;
            return reply.code(statusCode).send({ error: message });
        }
    });

    fastify.get<{ Params: { sessionId: string } }>("/api/kahoot/sessions/:sessionId", {
        schema: {
            params: {
                type: "object",
                additionalProperties: false,
                required: ["sessionId"],
                properties: { sessionId: identifierSchema },
            },
        },
        preHandler: authenticate,
    }, async (request, reply) => {
        const session = options.sessionManager.getSession(request.params.sessionId);
        if (session === null) return reply.code(404).send({ error: "Session not found." });
        return sessionView(session, writer);
    });
}
