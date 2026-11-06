export interface ScoringParticipant {
    controllerId: string;
    playerId: string;
    teamId: string;
    points: number;
    reactionTimeMs?: number;
    isCorrect?: boolean;
}

export interface CompletedQuestionForScoring {
    homeTeamId: string;
    awayTeamId: string;
    participants: readonly ScoringParticipant[];
}

export type ScorerAttribution = "NONE" | "RESOLVED" | "TIED";

export type ScoringDecision =
    | {
        status: "UNRESOLVED";
        reason: "MISSING_HOME_PARTICIPANTS" | "MISSING_AWAY_PARTICIPANTS";
    }
    | {
        status: "SCORED";
        homeMean: number;
        awayMean: number;
        differencePercent: number;
        goalAwarded: boolean;
        scoringTeamId: string | null;
        creditedPlayerId: string | null;
        scorerAttribution: ScorerAttribution;
    };

function mean(participants: readonly ScoringParticipant[]): number {
    return participants.reduce((total, participant) => total + participant.points, 0)
        / participants.length;
}

export function scoreCompletedQuestion(
    question: CompletedQuestionForScoring,
): ScoringDecision {
    const homeParticipants = question.participants.filter(
        (participant) => participant.teamId === question.homeTeamId,
    );
    const awayParticipants = question.participants.filter(
        (participant) => participant.teamId === question.awayTeamId,
    );
    if (homeParticipants.length === 0) {
        return { status: "UNRESOLVED", reason: "MISSING_HOME_PARTICIPANTS" };
    }
    if (awayParticipants.length === 0) {
        return { status: "UNRESOLVED", reason: "MISSING_AWAY_PARTICIPANTS" };
    }

    const homeMean = mean(homeParticipants);
    const awayMean = mean(awayParticipants);
    const higher = Math.max(homeMean, awayMean);
    const lower = Math.min(homeMean, awayMean);
    const differencePercent = higher === 0 ? 0 : ((higher - lower) / higher) * 100;
    const goalAwarded = differencePercent > 2;
    if (!goalAwarded) {
        return {
            status: "SCORED",
            homeMean,
            awayMean,
            differencePercent,
            goalAwarded: false,
            scoringTeamId: null,
            creditedPlayerId: null,
            scorerAttribution: "NONE",
        };
    }

    const scoringTeamId = homeMean > awayMean
        ? question.homeTeamId
        : question.awayTeamId;
    const winningParticipants = scoringTeamId === question.homeTeamId
        ? homeParticipants
        : awayParticipants;
    const highestPoints = Math.max(...winningParticipants.map(
        (participant) => participant.points,
    ));
    const highestScorers = winningParticipants.filter(
        (participant) => participant.points === highestPoints,
    );
    const creditedPlayerId = highestScorers.length === 1
        ? highestScorers[0]?.playerId ?? null
        : null;

    return {
        status: "SCORED",
        homeMean,
        awayMean,
        differencePercent,
        goalAwarded: true,
        scoringTeamId,
        creditedPlayerId,
        scorerAttribution: creditedPlayerId === null ? "TIED" : "RESOLVED",
    };
}
