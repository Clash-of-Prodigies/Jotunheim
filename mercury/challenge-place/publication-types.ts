export type PublicationStatus =
    | "QUEUED"
    | "SENDING"
    | "CONFIRMED"
    | "UNCERTAIN"
    | "REJECTED"
    | "NOT_SENT";

export interface GoalPublicationInput {
    sessionId: string;
    liveGameId: string;
    matchId: string;
    questionIndex: number;
    scoringCompetitorId: string;
    opponentCompetitorId: string;
    creditedChallengePlayerId: string | null;
    homeMean: number;
    awayMean: number;
    expectedHomeScore: number;
    expectedAwayScore: number;
    eventTimeMs: number;
}

export interface GoalPublicationRecord extends GoalPublicationInput {
    key: string;
    status: PublicationStatus;
    attemptTimestamp: string | null;
    detail: string | null;
    confirmationEventId: string | null;
}

export interface PublicationSessionSummary {
    sessionId: string;
    calculatedGoals: number;
    confirmedGoals: number;
    unresolvedSubmissions: number;
    queuedSubmissions: number;
    exceptionReportPath: string | null;
}

export function publicationKey(input: Pick<GoalPublicationInput, "liveGameId" | "questionIndex">): string {
    return `${input.liveGameId}:${input.questionIndex}`;
}

export function isTerminalPublicationStatus(status: PublicationStatus): boolean {
    return ["CONFIRMED", "UNCERTAIN", "REJECTED", "NOT_SENT"].includes(status);
}
