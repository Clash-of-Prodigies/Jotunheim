import type { Player, PlayerResolution } from "../players/identity.js";
import { normalizeName } from "../players/identity.js";
import type { MatchFixture } from "../matches/match-repository.js";
import { isFixtureEligible } from "../matches/match-repository.js";
import {
    collectTeamEvidence,
    resolveFixture,
    type FixtureResolution,
    type VerifiedParticipant,
} from "../matches/fixture-resolver.js";
import { normalizeScheduledAt } from "../matches/timestamps.js";
import {
    SessionScoringState,
    type QuestionProcessOutcome,
    type QuestionResultsInput,
} from "../scoring/session-scoring.js";

export interface ActiveKahootSession {
    id: string;
    pin: string;
    liveGameId: string | null;
    startedAt: string;
    participants: Map<string, VerifiedParticipant>;
    controllerToPlayer: Map<string, Player>;
    identityConflicts: Set<string>;
    detectedTeamIds: Set<string>;
    resolution: FixtureResolution;
    boundMatchId: string | null;
    boundFixture: MatchFixture | null;
    candidateFixtureIds: string[];
    publicationBlocked: boolean;
    verifiedPlayers: Map<string, Player>;
    scoring: SessionScoringState;
}

export interface StartSessionInput {
    sessionId?: string;
    pin: string;
    liveGameId?: string;
    startedAt: string;
}

function waitingResolution(): FixtureResolution {
    return {
        status: "WAITING_FOR_TEAMS",
        teamIds: [],
        unresolvedControllerIds: [],
    };
}

function resolutionIdentity(participant: VerifiedParticipant): string {
    const resolution = participant.resolution;
    if (resolution.status === "MATCHED") return `MATCHED:${resolution.player.id}`;
    if (resolution.status === "NOT_FOUND") {
        return `NOT_FOUND:${normalizeName(participant.nickname)}`;
    }
    return `AMBIGUOUS:${resolution.players.map((player) => player.id).sort().join(",")}`;
}

function conflictingResolution(
    existing: VerifiedParticipant,
    incoming: VerifiedParticipant,
): PlayerResolution {
    const players = new Map<string, Player>();
    for (const participant of [existing, incoming]) {
        if (participant.resolution.status === "MATCHED") {
            players.set(participant.resolution.player.id, participant.resolution.player);
        } else if (participant.resolution.status === "AMBIGUOUS") {
            for (const player of participant.resolution.players) players.set(player.id, player);
        }
    }
    return { status: "AMBIGUOUS", players: [...players.values()] };
}

export class SessionManager {
    private readonly sessions = new Map<string, ActiveKahootSession>();
    private readonly sessionIdByPin = new Map<string, string>();
    private readonly sessionIdByLiveGameId = new Map<string, string>();
    private readonly fixtureClaims = new Map<string, string>();
    private nextSessionNumber = 1;

    startSession(input: StartSessionInput): ActiveKahootSession {
        const startedAt = normalizeScheduledAt(input.startedAt);
        if (startedAt === null) {
            throw new Error("Session start time must include a valid timezone.");
        }
        const pin = input.pin.trim();
        if (pin.length === 0) throw new Error("Kahoot session PIN is required.");
        if (this.sessionIdByPin.has(pin)) {
            throw new Error(`An active session already uses PIN ${pin}.`);
        }
        if (
            input.liveGameId !== undefined
            && this.sessionIdByLiveGameId.has(input.liveGameId)
        ) {
            throw new Error(`An active session already uses live game ID ${input.liveGameId}.`);
        }

        const requestedId = input.sessionId?.trim();
        const id = requestedId === undefined || requestedId.length === 0
            ? `session-${this.nextSessionNumber}`
            : requestedId;
        if (this.sessions.has(id)) throw new Error(`Session ${id} is already active.`);
        if (requestedId === undefined || requestedId.length === 0) this.nextSessionNumber += 1;

        const session: ActiveKahootSession = {
            id,
            pin,
            liveGameId: input.liveGameId ?? null,
            startedAt,
            participants: new Map(),
            controllerToPlayer: new Map(),
            identityConflicts: new Set(),
            detectedTeamIds: new Set(),
            resolution: waitingResolution(),
            boundMatchId: null,
            boundFixture: null,
            candidateFixtureIds: [],
            publicationBlocked: false,
            verifiedPlayers: new Map(),
            scoring: new SessionScoringState(),
        };
        this.sessions.set(id, session);
        this.sessionIdByPin.set(pin, id);
        if (session.liveGameId !== null) {
            this.sessionIdByLiveGameId.set(session.liveGameId, id);
        }
        return session;
    }

    getSession(sessionId: string): ActiveKahootSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    findSession(pin: string, liveGameId?: string): ActiveKahootSession | null {
        if (liveGameId !== undefined) {
            const liveSessionId = this.sessionIdByLiveGameId.get(liveGameId);
            if (liveSessionId !== undefined) {
                return this.sessions.get(liveSessionId) ?? null;
            }
        }
        const pinSessionId = this.sessionIdByPin.get(pin);
        return pinSessionId === undefined
            ? null
            : this.sessions.get(pinSessionId) ?? null;
    }

    attachLiveGameId(sessionId: string, liveGameId: string): void {
        const session = this.requireSession(sessionId);
        const existingSessionId = this.sessionIdByLiveGameId.get(liveGameId);
        if (existingSessionId !== undefined && existingSessionId !== sessionId) {
            throw new Error(`Live game ID ${liveGameId} is already in use.`);
        }
        if (session.liveGameId !== null) this.sessionIdByLiveGameId.delete(session.liveGameId);
        session.liveGameId = liveGameId;
        this.sessionIdByLiveGameId.set(liveGameId, sessionId);
    }

    recordParticipant(
        sessionId: string,
        participant: VerifiedParticipant,
        fixtures: readonly MatchFixture[],
    ): ActiveKahootSession {
        const session = this.requireSession(sessionId);
        const existing = session.participants.get(participant.controllerId);
        if (existing !== undefined) {
            if (resolutionIdentity(existing) === resolutionIdentity(participant)) return session;
            session.identityConflicts.add(participant.controllerId);
            session.participants.set(participant.controllerId, {
                controllerId: participant.controllerId,
                nickname: participant.nickname,
                resolution: conflictingResolution(existing, participant),
            });
            session.controllerToPlayer.delete(participant.controllerId);
            session.verifiedPlayers.delete(participant.controllerId);
            session.publicationBlocked = true;
        } else {
            session.participants.set(participant.controllerId, participant);
            if (participant.resolution.status === "MATCHED") {
                session.controllerToPlayer.set(
                    participant.controllerId,
                    participant.resolution.player,
                );
                session.verifiedPlayers.set(
                    participant.controllerId,
                    participant.resolution.player,
                );
            }
        }
        this.refreshTeamIds(session);

        if (session.boundMatchId !== null) {
            const boundFixture = fixtures.find((fixture) => fixture.id === session.boundMatchId);
            if (
                boundFixture !== undefined
                && [...session.detectedTeamIds].some((teamId) =>
                    teamId !== boundFixture.homeTeam && teamId !== boundFixture.awayTeam
                )
            ) {
                const evidence = collectTeamEvidence([...session.participants.values()]);
                session.resolution = {
                    ...evidence,
                    status: "NEEDS_REVIEW",
                    reason: "UNEXPECTED_TEAM_AFTER_BINDING",
                    boundFixtureId: session.boundMatchId,
                };
                session.publicationBlocked = true;
            }
            return session;
        }

        this.reevaluateAll(fixtures);
        return session;
    }

    removeParticipant(
        sessionId: string,
        controllerId: string,
        fixtures: readonly MatchFixture[],
    ): ActiveKahootSession {
        const session = this.requireSession(sessionId);
        if (!session.participants.delete(controllerId)) return session;
        session.controllerToPlayer.delete(controllerId);
        session.identityConflicts.delete(controllerId);
        this.refreshTeamIds(session);
        if (session.boundMatchId === null) this.reevaluateAll(fixtures);
        return session;
    }

    reevaluateAll(fixtures: readonly MatchFixture[]): void {
        let addedClaim: boolean;
        do {
            addedClaim = false;
            for (const session of this.sessions.values()) {
                if (session.boundMatchId !== null) continue;
                const claimsBefore = this.fixtureClaims.size;
                this.evaluateSession(session, fixtures);
                if (this.fixtureClaims.size > claimsBefore) addedClaim = true;
            }
        } while (addedClaim);
    }

    confirmFixture(
        sessionId: string,
        fixtureId: string,
        fixtures: readonly MatchFixture[],
    ): ActiveKahootSession {
        const session = this.requireSession(sessionId);
        if (session.boundMatchId !== null) {
            if (session.boundMatchId === fixtureId) return session;
            throw new Error("Reset the existing fixture binding before confirming another fixture.");
        }
        const fixture = fixtures.find((candidate) => candidate.id === fixtureId);
        if (fixture === undefined) throw new Error(`Unknown fixture ${fixtureId}.`);
        if (!isFixtureEligible(fixture.status)) {
            throw new Error(`Fixture ${fixtureId} is not eligible for play.`);
        }
        const claimOwner = this.fixtureClaims.get(fixtureId);
        if (claimOwner !== undefined && claimOwner !== sessionId) {
            throw new Error(`Fixture ${fixtureId} is already claimed.`);
        }
        if ([...session.detectedTeamIds].some((teamId) =>
            teamId !== fixture.homeTeam && teamId !== fixture.awayTeam
        )) {
            throw new Error("Verified participant teams do not fit the selected fixture.");
        }
        this.bindFixture(session, fixture);
        this.reevaluateAll(fixtures);
        return session;
    }

    resetBinding(sessionId: string, fixtures: readonly MatchFixture[]): void {
        const session = this.requireSession(sessionId);
        this.releaseClaim(session);
        session.resolution = waitingResolution();
        session.candidateFixtureIds = [];
        session.publicationBlocked = false;
        this.reevaluateAll(fixtures);
    }

    completeSession(sessionId: string, fixtures: readonly MatchFixture[]): void {
        const session = this.requireSession(sessionId);
        this.releaseClaim(session);
        this.sessions.delete(sessionId);
        this.sessionIdByPin.delete(session.pin);
        if (session.liveGameId !== null) {
            this.sessionIdByLiveGameId.delete(session.liveGameId);
        }
        this.reevaluateAll(fixtures);
    }

    getConfirmedClaims(): ReadonlyMap<string, string> {
        return new Map(this.fixtureClaims);
    }

    processQuestionResults(
        sessionId: string,
        input: QuestionResultsInput,
    ): QuestionProcessOutcome {
        const session = this.requireSession(sessionId);
        return session.scoring.process(input, {
            liveGameId: session.liveGameId,
            fixture: session.boundFixture,
            verifiedPlayers: session.verifiedPlayers,
            integritySafe: !session.publicationBlocked
                && session.identityConflicts.size === 0
                && session.resolution.status === "RESOLVED",
        });
    }

    private evaluateSession(
        session: ActiveKahootSession,
        fixtures: readonly MatchFixture[],
    ): void {
        const resolution = resolveFixture({
            sessionId: session.id,
            participants: [...session.participants.values()],
            startedAt: session.startedAt,
            fixtures,
            confirmedClaims: this.fixtureClaims,
        });
        session.resolution = resolution;
        session.candidateFixtureIds = resolution.status === "NEEDS_CONFIRMATION"
            ? [...resolution.candidateFixtureIds]
            : [];
        if (resolution.status === "RESOLVED") {
            const claimOwner = this.fixtureClaims.get(resolution.fixtureId);
            if (claimOwner === undefined || claimOwner === session.id) {
                const fixture = fixtures.find(
                    (candidate) => candidate.id === resolution.fixtureId,
                );
                if (fixture === undefined) {
                    throw new Error(`Resolved fixture ${resolution.fixtureId} is unavailable.`);
                }
                this.bindFixture(session, fixture);
            }
        }
    }

    private bindFixture(session: ActiveKahootSession, fixture: MatchFixture): void {
        this.fixtureClaims.set(fixture.id, session.id);
        session.boundMatchId = fixture.id;
        session.boundFixture = fixture;
        session.candidateFixtureIds = [];
        session.publicationBlocked = session.identityConflicts.size > 0;
        const evidence = collectTeamEvidence([...session.participants.values()]);
        session.resolution = { ...evidence, status: "RESOLVED", fixtureId: fixture.id };
    }

    private releaseClaim(session: ActiveKahootSession): void {
        if (session.boundMatchId !== null) {
            const claimOwner = this.fixtureClaims.get(session.boundMatchId);
            if (claimOwner === session.id) this.fixtureClaims.delete(session.boundMatchId);
        }
        session.boundMatchId = null;
        session.boundFixture = null;
    }

    private refreshTeamIds(session: ActiveKahootSession): void {
        const evidence = collectTeamEvidence([...session.participants.values()]);
        session.detectedTeamIds = new Set(evidence.teamIds);
    }

    private requireSession(sessionId: string): ActiveKahootSession {
        const session = this.sessions.get(sessionId);
        if (session === undefined) throw new Error(`Unknown session ${sessionId}.`);
        return session;
    }
}
