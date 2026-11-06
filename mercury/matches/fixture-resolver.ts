import type { PlayerResolution } from "../players/identity.js";
import type { MatchFixture } from "./match-repository.js";
import { isFixtureEligible } from "./match-repository.js";
import { normalizeScheduledAt } from "./timestamps.js";

export const FIXTURE_TIME_WINDOW_MS = 2 * 60 * 60 * 1_000;
export const FIXTURE_CLEAR_LEAD_MS = 45 * 60 * 1_000;

export interface VerifiedParticipant {controllerId: string; nickname: string; resolution: PlayerResolution;}

interface ResolutionBase {teamIds: string[]; unresolvedControllerIds: string[];}

export type FixtureResolution =
    | (ResolutionBase & { status: "WAITING_FOR_TEAMS" })
    | (ResolutionBase & {
        status: "NEEDS_REVIEW";
        reason: "TOO_MANY_TEAMS" | "UNEXPECTED_TEAM_AFTER_BINDING";
        boundFixtureId?: string;
    })
    | (ResolutionBase & {
        status: "NEEDS_CONFIRMATION";
        reason: "NO_ELIGIBLE_FIXTURE" | "AMBIGUOUS_FIXTURES";
        candidateFixtureIds: string[];
    })
    | (ResolutionBase & {
        status: "RESOLVED";
        fixtureId: string;
    });

export interface ResolveFixtureInput {
    sessionId: string;
    participants: readonly VerifiedParticipant[];
    startedAt: string;
    fixtures: readonly MatchFixture[];
    confirmedClaims: ReadonlyMap<string, string>;
    timeWindowMs?: number;
    clearLeadMs?: number;
}

export interface TeamEvidence {
    teamIds: string[];
    unresolvedControllerIds: string[];
}

export function collectTeamEvidence(participants: readonly VerifiedParticipant[]): TeamEvidence {
    const teamIds = new Set<string>();
    const unresolvedControllerIds: string[] = [];

    for (const participant of participants) {
        if (participant.resolution.status === "MATCHED"
            && participant.resolution.player.teamId !== null
        ) teamIds.add(participant.resolution.player.teamId);
        else unresolvedControllerIds.push(participant.controllerId);
    }

    return {
        teamIds: [...teamIds].sort(),
        unresolvedControllerIds: [...new Set(unresolvedControllerIds)].sort(),
    };
}

function hasTeamPair(fixture: MatchFixture, firstTeamId: string, secondTeamId: string): boolean {
    return (fixture.homeTeam === firstTeamId && fixture.awayTeam === secondTeamId)
    || (fixture.homeTeam === secondTeamId && fixture.awayTeam === firstTeamId);
}

export function resolveFixture(input: ResolveFixtureInput): FixtureResolution {
    const evidence = collectTeamEvidence(input.participants);
    const base: ResolutionBase = evidence;

    if (evidence.teamIds.length < 2) return { ...base, status: "WAITING_FOR_TEAMS" };
    if (evidence.teamIds.length > 2) return { ...base, status: "NEEDS_REVIEW", reason: "TOO_MANY_TEAMS" };

    const firstTeamId = evidence.teamIds[0];
    const secondTeamId = evidence.teamIds[1];
    if (firstTeamId === undefined || secondTeamId === undefined) {
        throw new Error("Fixture resolution lost its verified team pair.");
    }

    const normalizedStart = normalizeScheduledAt(input.startedAt);
    if (normalizedStart === null) {
        throw new Error("Kahoot session start time must include a valid timezone.");
    }
    const startTime = Date.parse(normalizedStart);
    const timeWindowMs = input.timeWindowMs ?? FIXTURE_TIME_WINDOW_MS;
    const clearLeadMs = input.clearLeadMs ?? FIXTURE_CLEAR_LEAD_MS;

    const candidates = input.fixtures.flatMap((fixture) => {
        if (!isFixtureEligible(fixture.status)) return [];
        if (!hasTeamPair(fixture, firstTeamId, secondTeamId)) return [];
        if (fixture.scheduledAt === null) return [];

        const normalizedSchedule = normalizeScheduledAt(fixture.scheduledAt);
        if (normalizedSchedule === null) return [];
        const differenceMs = Math.abs(Date.parse(normalizedSchedule) - startTime);
        if (differenceMs > timeWindowMs) return [];

        const claimOwner = input.confirmedClaims.get(fixture.id);
        if (claimOwner !== undefined && claimOwner !== input.sessionId) return [];
        return [{ fixture, differenceMs }];
    }).sort((left, right) =>
        left.differenceMs - right.differenceMs
        || left.fixture.id.localeCompare(right.fixture.id)
    );

    if (candidates.length === 0) {
        return {
            ...base,
            status: "NEEDS_CONFIRMATION",
            reason: "NO_ELIGIBLE_FIXTURE",
            candidateFixtureIds: [],
        };
    }

    const nearest = candidates[0];
    if (nearest === undefined) {
        throw new Error("Fixture resolution lost its nearest candidate.");
    }
    if (candidates.length === 1) {
        return { ...base, status: "RESOLVED", fixtureId: nearest.fixture.id };
    }

    const secondNearest = candidates[1];
    if (
        secondNearest !== undefined
        && secondNearest.differenceMs - nearest.differenceMs >= clearLeadMs
    ) {
        return { ...base, status: "RESOLVED", fixtureId: nearest.fixture.id };
    }

    return {
        ...base,
        status: "NEEDS_CONFIRMATION",
        reason: "AMBIGUOUS_FIXTURES",
        candidateFixtureIds: candidates.map((candidate) => candidate.fixture.id),
    };
}
