import { io, type Socket } from "socket.io-client";

export interface ChallengePlaceGoalCommand {
    matchId: string;
    scoringCompetitorId: string;
    opponentCompetitorId: string;
    creditedChallengePlayerId: string;
    eventTimeMs: number;
}

export interface ChallengePlaceGoalEvidence {
    matchId: string;
    eventId: string;
    scoringCompetitorId: string;
    opponentCompetitorId: string | null;
    challengePlayerIds: string[];
    inputValue: number;
    eventTimeMs: number;
}

export type GoalDispatchResult =
    | { kind: "DISPATCHED" }
    | { kind: "NOT_CONNECTED" }
    | { kind: "REJECTED"; detail: string };

export interface ChallengePlaceTransport {
    readonly connected: boolean;
    connect(): void;
    close(): void;
    submitGoal(command: ChallengePlaceGoalCommand): Promise<GoalDispatchResult>;
    onConnected(listener: () => void): () => void;
    onDisconnected(listener: (detail: string) => void): () => void;
    onGoalEvidence(listener: (evidence: ChallengePlaceGoalEvidence) => void): () => void;
}

export interface SocketIoChallengePlaceConfig {
    baseUrl: string;
    tokenId: string;
    challengeLinkCode: string;
    language?: string;
}

interface ChallengePlaceEvent {
    id?: unknown;
    time?: unknown;
    eventSettingsId?: unknown;
    inputValue?: unknown;
    children?: unknown;
    playerIds?: unknown;
    competitorId?: unknown;
    parentId?: unknown;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
}

export class SocketIoChallengePlaceTransport implements ChallengePlaceTransport {
    private readonly socket: Socket;
    private readonly connectedListeners = new Set<() => void>();
    private readonly disconnectedListeners = new Set<(detail: string) => void>();
    private readonly evidenceListeners = new Set<(evidence: ChallengePlaceGoalEvidence) => void>();

    constructor(config: SocketIoChallengePlaceConfig) {
        const namespaceUrl = new URL("/challenge", config.baseUrl).toString();
        this.socket = io(namespaceUrl, {
            autoConnect: false,
            reconnection: true,
            path: "/socket.io",
            transports: ["websocket"],
            auth: {
                tokenId: config.tokenId,
                linkCode: config.challengeLinkCode,
                lang: config.language ?? "en-us",
                challengeLinkCode: config.challengeLinkCode,
            },
        });
        this.socket.on("connect", () => {
            for (const listener of this.connectedListeners) listener();
        });
        this.socket.on("disconnect", (reason) => {
            for (const listener of this.disconnectedListeners) listener(reason);
        });
        this.socket.on("connect_error", (error) => {
            for (const listener of this.disconnectedListeners) {
                listener(`connect_error: ${error.message}`);
            }
        });
        this.socket.onAny((eventName: string, payload: unknown) => {
            this.inspectEventAdded(eventName, payload);
        });
    }

    get connected(): boolean {
        return this.socket.connected;
    }

    connect(): void {
        this.socket.connect();
    }

    close(): void {
        this.socket.disconnect();
    }

    async submitGoal(command: ChallengePlaceGoalCommand): Promise<GoalDispatchResult> {
        if (!this.socket.connected) return { kind: "NOT_CONNECTED" };
        const payload = {
            matchId: command.matchId,
            eventSettingsId: "goal",
            competitorId: command.scoringCompetitorId,
            players: [command.creditedChallengePlayerId],
            inputValue: 1,
            time: command.eventTimeMs,
            comment: null,
            children: [
                {
                    eventSettingsId: "goalConceded",
                    competitorId: command.opponentCompetitorId,
                    players: null,
                    inputValue: 1,
                },
            ],
        };
        // Volatile emission prevents Socket.IO from buffering an unconfirmed goal
        // across a disconnect. The capture showed no add-event acknowledgment.
        this.socket.volatile.emit("add-event", payload, null);
        return { kind: "DISPATCHED" };
    }

    onConnected(listener: () => void): () => void {
        this.connectedListeners.add(listener);
        return () => { this.connectedListeners.delete(listener); };
    }

    onDisconnected(listener: (detail: string) => void): () => void {
        this.disconnectedListeners.add(listener);
        return () => { this.disconnectedListeners.delete(listener); };
    }

    onGoalEvidence(listener: (evidence: ChallengePlaceGoalEvidence) => void): () => void {
        this.evidenceListeners.add(listener);
        return () => { this.evidenceListeners.delete(listener); };
    }

    private inspectEventAdded(eventName: string, payload: unknown): void {
        const suffix = "-room-challenge-match-details-event-added";
        if (!eventName.endsWith(suffix) || payload === null || typeof payload !== "object") return;
        const matchId = eventName.slice(0, -suffix.length);
        const eventsValue = (payload as { events?: unknown }).events;
        if (eventsValue === null || typeof eventsValue !== "object") return;
        const events = eventsValue as Record<string, ChallengePlaceEvent>;
        for (const [eventId, event] of Object.entries(events)) {
            if (
                event.eventSettingsId !== "goal"
                || event.inputValue !== 1
                || typeof event.competitorId !== "string"
                || typeof event.time !== "number"
            ) continue;
            let opponentCompetitorId: string | null = null;
            for (const childId of stringArray(event.children)) {
                const child = events[childId];
                if (
                    child?.eventSettingsId === "goalConceded"
                    && typeof child.competitorId === "string"
                ) opponentCompetitorId = child.competitorId;
            }
            const evidence: ChallengePlaceGoalEvidence = {
                matchId,
                eventId: typeof event.id === "string" ? event.id : eventId,
                scoringCompetitorId: event.competitorId,
                opponentCompetitorId,
                challengePlayerIds: stringArray(event.playerIds),
                inputValue: event.inputValue,
                eventTimeMs: event.time,
            };
            for (const listener of this.evidenceListeners) listener(evidence);
        }
    }
}
