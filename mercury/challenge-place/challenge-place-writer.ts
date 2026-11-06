import { performance } from "node:perf_hooks";
import type {
    ChallengePlaceGoalCommand,
    ChallengePlaceGoalEvidence,
    ChallengePlaceTransport,
} from "./challenge-place-transport.js";
import { ExceptionReporter } from "./exception-reporter.js";
import {
    isTerminalPublicationStatus,
    publicationKey,
    type GoalPublicationInput,
    type GoalPublicationRecord,
    type PublicationSessionSummary,
    type PublicationStatus,
} from "./publication-types.js";

export interface ChallengePlaceWriterOptions {
    enabled: boolean;
    transport: ChallengePlaceTransport | null;
    exceptionReporter: ExceptionReporter;
    rateLimitMs?: number;
    confirmationTimeoutMs?: number;
    sessionFinishGraceMs?: number;
    now?: () => number;
    monotonicNow?: () => number;
}

type PublicationListener = (record: GoalPublicationRecord) => void;

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ChallengePlaceWriter {
    private readonly enabled: boolean;
    private readonly transport: ChallengePlaceTransport | null;
    private readonly reporter: ExceptionReporter;
    private readonly rateLimitMs: number;
    private readonly confirmationTimeoutMs: number;
    private readonly sessionFinishGraceMs: number;
    private readonly now: () => number;
    private readonly monotonicNow: () => number;
    private readonly records = new Map<string, GoalPublicationRecord>();
    private readonly matchQueues = new Map<string, string[]>();
    private readonly matchOrder: string[] = [];
    private readonly sessionPublishable = new Map<string, boolean>();
    private readonly listeners = new Set<PublicationListener>();
    private workerRunning = false;
    private matchCursor = 0;
    private lastAttemptAt = Number.NEGATIVE_INFINITY;
    private activeKey: string | null = null;
    private activeWaitResolve: (() => void) | null = null;
    private readonly unsubscribe: Array<() => void> = [];

    constructor(options: ChallengePlaceWriterOptions) {
        this.enabled = options.enabled;
        this.transport = options.transport;
        this.reporter = options.exceptionReporter;
        this.rateLimitMs = Math.max(0, options.rateLimitMs ?? 1_000);
        this.confirmationTimeoutMs = Math.max(1, options.confirmationTimeoutMs ?? 5_000);
        this.sessionFinishGraceMs = Math.max(0, options.sessionFinishGraceMs ?? 5_000);
        this.now = options.now ?? Date.now;
        this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
        if (this.transport !== null) {
            this.unsubscribe.push(
                this.transport.onConnected(() => this.kick()),
                this.transport.onDisconnected((detail) => this.handleDisconnect(detail)),
                this.transport.onGoalEvidence((evidence) => this.handleGoalEvidence(evidence)),
            );
        }
    }

    start(): void {
        if (this.enabled) this.transport?.connect();
    }

    close(): void {
        for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
        this.transport?.close();
    }

    onStatus(listener: PublicationListener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    setSessionPublishable(sessionId: string, publishable: boolean): void {
        this.sessionPublishable.set(sessionId, publishable);
        if (publishable) this.kick();
    }

    enqueue(input: GoalPublicationInput): GoalPublicationRecord {
        const key = publicationKey(input);
        const existing = this.records.get(key);
        if (existing !== undefined) return existing;
        const record: GoalPublicationRecord = {
            ...input,
            key,
            status: "QUEUED",
            attemptTimestamp: null,
            detail: null,
            confirmationEventId: null,
        };
        this.records.set(key, record);
        this.reporter.recordOutstanding(record);

        if (record.creditedChallengePlayerId === null) {
            this.settle(record, "NOT_SENT", "Scorer attribution is unresolved.");
            return record;
        }
        if (!this.enabled || this.transport === null) {
            this.settle(record, "NOT_SENT", "Challenge Place publishing is disabled.");
            return record;
        }

        let queue = this.matchQueues.get(record.matchId);
        if (queue === undefined) {
            queue = [];
            this.matchQueues.set(record.matchId, queue);
            this.matchOrder.push(record.matchId);
        }
        queue.push(key);
        this.notify(record);
        this.kick();
        return record;
    }

    get(key: string): GoalPublicationRecord | null {
        return this.records.get(key) ?? null;
    }

    getSessionRecords(sessionId: string): GoalPublicationRecord[] {
        return [...this.records.values()]
            .filter((record) => record.sessionId === sessionId)
            .sort((left, right) => left.questionIndex - right.questionIndex);
    }

    getSessionSummary(sessionId: string): PublicationSessionSummary {
        const records = this.getSessionRecords(sessionId);
        return {
            sessionId,
            calculatedGoals: records.length,
            confirmedGoals: records.filter((record) => record.status === "CONFIRMED").length,
            unresolvedSubmissions: records.filter(
                (record) => record.status !== "CONFIRMED",
            ).length,
            queuedSubmissions: records.filter(
                (record) => record.status === "QUEUED" || record.status === "SENDING",
            ).length,
            exceptionReportPath: this.reporter.getSessionReportPath(sessionId),
        };
    }

    async finishSession(sessionId: string): Promise<PublicationSessionSummary> {
        const deadline = this.now() + this.sessionFinishGraceMs;
        this.kick();
        while (this.hasActiveSessionWork(sessionId) && this.now() < deadline) {
            await delay(Math.min(10, Math.max(1, deadline - this.now())));
        }
        for (const record of this.getSessionRecords(sessionId)) {
            if (record.status === "QUEUED") {
                this.settle(record, "NOT_SENT", "Session ended before transmission could begin.");
            } else if (record.status === "SENDING") {
                this.settle(record, "UNCERTAIN", "Session ended before confirmation was available.");
            }
        }
        this.reporter.flushSession(sessionId);
        return this.getSessionSummary(sessionId);
    }

    private hasActiveSessionWork(sessionId: string): boolean {
        return this.getSessionRecords(sessionId).some(
            (record) => record.status === "QUEUED" || record.status === "SENDING",
        );
    }

    private kick(): void {
        if (this.workerRunning || !this.enabled || this.transport === null) return;
        this.workerRunning = true;
        queueMicrotask(() => void this.runWorker());
    }

    private async runWorker(): Promise<void> {
        try {
            while (this.transport?.connected === true) {
                const record = this.pickNext();
                if (record === null) break;
                const wait = this.rateLimitMs - (this.monotonicNow() - this.lastAttemptAt);
                if (wait > 0) await delay(wait);
                if (record.status !== "QUEUED") continue;
                if (this.sessionPublishable.get(record.sessionId) !== true) {
                    this.requeueFront(record);
                    break;
                }
                if (this.transport.connected !== true) {
                    this.requeueFront(record);
                    break;
                }
                const shouldContinue = await this.attempt(record);
                if (!shouldContinue) break;
            }
        } finally {
            this.workerRunning = false;
            if (this.transport?.connected === true && this.hasAnyEligibleQueued()) this.kick();
        }
    }

    private pickNext(): GoalPublicationRecord | null {
        if (this.matchOrder.length === 0) return null;
        for (let checked = 0; checked < this.matchOrder.length; checked += 1) {
            const index = (this.matchCursor + checked) % this.matchOrder.length;
            const matchId = this.matchOrder[index];
            if (matchId === undefined) continue;
            const queue = this.matchQueues.get(matchId);
            if (queue === undefined) continue;
            while (queue.length > 0) {
                const key = queue[0];
                const record = key === undefined ? undefined : this.records.get(key);
                if (record === undefined || record.status !== "QUEUED") {
                    queue.shift();
                    continue;
                }
                if (this.sessionPublishable.get(record.sessionId) !== true) break;
                queue.shift();
                this.matchCursor = (index + 1) % this.matchOrder.length;
                return record;
            }
        }
        return null;
    }

    private hasAnyEligibleQueued(): boolean {
        return [...this.records.values()].some((record) =>
            record.status === "QUEUED"
            && this.sessionPublishable.get(record.sessionId) === true
        );
    }

    private async attempt(record: GoalPublicationRecord): Promise<boolean> {
        if (record.creditedChallengePlayerId === null || this.transport === null) return true;
        record.status = "SENDING";
        record.attemptTimestamp = new Date(this.now()).toISOString();
        record.detail = null;
        this.activeKey = record.key;
        this.lastAttemptAt = this.monotonicNow();
        this.reporter.writeSubmissionIntent(record);
        this.reporter.recordOutstanding(record);
        this.notify(record);

        const command: ChallengePlaceGoalCommand = {
            matchId: record.matchId,
            scoringCompetitorId: record.scoringCompetitorId,
            opponentCompetitorId: record.opponentCompetitorId,
            creditedChallengePlayerId: record.creditedChallengePlayerId,
            eventTimeMs: record.eventTimeMs,
        };
        const dispatch = await this.transport.submitGoal(command);
        if (dispatch.kind === "NOT_CONNECTED") {
            record.status = "QUEUED";
            record.detail = "Connection became unavailable before transmission.";
            this.reporter.writeSubmissionIntent(record);
            this.reporter.recordOutstanding(record);
            this.notify(record);
            this.activeKey = null;
            this.requeueFront(record);
            return false;
        }
        if (dispatch.kind === "REJECTED") {
            this.settle(record, "REJECTED", dispatch.detail);
            this.activeKey = null;
            return true;
        }
        if (this.records.get(record.key)?.status === "CONFIRMED") {
            this.activeKey = null;
            return true;
        }

        await new Promise<void>((resolve) => {
            let completed = false;
            const finish = () => {
                if (completed) return;
                completed = true;
                this.activeWaitResolve = null;
                resolve();
            };
            this.activeWaitResolve = finish;
            setTimeout(() => {
                if (record.status === "SENDING") {
                    this.settle(record, "UNCERTAIN", "No correlatable event-added confirmation arrived before timeout.");
                }
                finish();
            }, this.confirmationTimeoutMs);
        });
        this.activeKey = null;
        return true;
    }

    private requeueFront(record: GoalPublicationRecord): void {
        const queue = this.matchQueues.get(record.matchId);
        if (queue === undefined) this.matchQueues.set(record.matchId, [record.key]);
        else queue.unshift(record.key);
    }

    private handleDisconnect(detail: string): void {
        if (this.activeKey === null) return;
        const record = this.records.get(this.activeKey);
        if (record?.status !== "SENDING") return;
        this.settle(record, "UNCERTAIN", `Socket disconnected during transmission: ${detail}`);
        this.activeWaitResolve?.();
    }

    private handleGoalEvidence(evidence: ChallengePlaceGoalEvidence): void {
        const candidates = [...this.records.values()].filter(
            (record) => record.status === "SENDING" || record.status === "UNCERTAIN",
        );
        for (const record of candidates) {
            if (!this.matchesEvidence(record, evidence)) continue;
            record.confirmationEventId = evidence.eventId;
            this.settle(record, "CONFIRMED", `Confirmed by event-added ${evidence.eventId}.`);
            if (record.key === this.activeKey) this.activeWaitResolve?.();
            return;
        }
    }

    private matchesEvidence(
        record: GoalPublicationRecord,
        evidence: ChallengePlaceGoalEvidence,
    ): boolean {
        return record.matchId === evidence.matchId
            && record.scoringCompetitorId === evidence.scoringCompetitorId
            && record.opponentCompetitorId === evidence.opponentCompetitorId
            && record.creditedChallengePlayerId !== null
            && evidence.challengePlayerIds.includes(record.creditedChallengePlayerId)
            && evidence.inputValue === 1
            && record.eventTimeMs === evidence.eventTimeMs;
    }

    private settle(
        record: GoalPublicationRecord,
        status: Extract<PublicationStatus, "CONFIRMED" | "UNCERTAIN" | "REJECTED" | "NOT_SENT">,
        detail: string,
    ): void {
        if (record.status === "CONFIRMED") return;
        record.status = status;
        record.detail = detail;
        if (status === "CONFIRMED") this.reporter.resolveConfirmed(record);
        else {
            if (record.attemptTimestamp !== null) this.reporter.writeSubmissionIntent(record);
            this.reporter.recordOutstanding(record);
        }
        this.notify(record);
    }

    private notify(record: GoalPublicationRecord): void {
        for (const listener of this.listeners) listener({ ...record });
    }
}
