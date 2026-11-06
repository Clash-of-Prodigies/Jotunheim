import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    type ChallengePlaceGoalCommand,
    type ChallengePlaceGoalEvidence,
    type ChallengePlaceTransport,
    type GoalDispatchResult,
} from "./challenge-place-transport.js";
import { ChallengePlaceWriter } from "./challenge-place-writer.js";
import { ExceptionReporter } from "./exception-reporter.js";
import type { GoalPublicationInput, GoalPublicationRecord } from "./publication-types.js";

type Behavior =
    | { kind: "CONFIRM" }
    | { kind: "SILENT" }
    | { kind: "DISCONNECT" }
    | { kind: "REJECT"; detail: string };

class MockTransport implements ChallengePlaceTransport {
    connected = false;
    connectAvailable = true;
    readonly sent: Array<{ command: ChallengePlaceGoalCommand; at: number }> = [];
    readonly behaviors: Behavior[] = [];
    private nextEvent = 1;
    private readonly connectedListeners = new Set<() => void>();
    private readonly disconnectedListeners = new Set<(detail: string) => void>();
    private readonly evidenceListeners = new Set<(evidence: ChallengePlaceGoalEvidence) => void>();

    connect(): void {
        if (!this.connectAvailable) return;
        this.connected = true;
        for (const listener of this.connectedListeners) listener();
    }

    close(): void {
        this.connected = false;
    }

    async submitGoal(command: ChallengePlaceGoalCommand): Promise<GoalDispatchResult> {
        if (!this.connected) return { kind: "NOT_CONNECTED" };
        this.sent.push({ command, at: performance.now() });
        const behavior = this.behaviors.shift() ?? { kind: "SILENT" };
        if (behavior.kind === "REJECT") {
            return { kind: "REJECTED", detail: behavior.detail };
        }
        if (behavior.kind === "CONFIRM") {
            queueMicrotask(() => this.confirm(command));
        } else if (behavior.kind === "DISCONNECT") {
            queueMicrotask(() => this.disconnect("test disconnect"));
        }
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

    disconnect(detail: string): void {
        this.connected = false;
        for (const listener of this.disconnectedListeners) listener(detail);
    }

    reconnect(): void {
        this.connected = true;
        for (const listener of this.connectedListeners) listener();
    }

    confirm(command: ChallengePlaceGoalCommand): void {
        const evidence: ChallengePlaceGoalEvidence = {
            matchId: command.matchId,
            eventId: `event-${this.nextEvent}`,
            scoringCompetitorId: command.scoringCompetitorId,
            opponentCompetitorId: command.opponentCompetitorId,
            challengePlayerIds: [command.creditedChallengePlayerId],
            inputValue: 1,
            eventTimeMs: command.eventTimeMs,
        };
        this.nextEvent += 1;
        for (const listener of this.evidenceListeners) listener(evidence);
    }
}

function goal(overrides: Partial<GoalPublicationInput> = {}): GoalPublicationInput {
    return {
        sessionId: "session-one",
        liveGameId: "live-one",
        matchId: "match-one",
        questionIndex: 0,
        scoringCompetitorId: "home-team",
        opponentCompetitorId: "away-team",
        creditedChallengePlayerId: "challenge-player",
        homeMean: 900,
        awayMean: 800,
        expectedHomeScore: 1,
        expectedAwayScore: 0,
        eventTimeMs: 12_345,
        ...overrides,
    };
}

function fixture(options: {
    enabled?: boolean;
    transport?: MockTransport;
    confirmationTimeoutMs?: number;
    rateLimitMs?: number;
    sessionFinishGraceMs?: number;
} = {}) {
    const directory = mkdtempSync(join(tmpdir(), "cp-writer-test-"));
    const transport = options.transport ?? new MockTransport();
    const reporter = new ExceptionReporter({ rootDirectory: directory });
    const writer = new ChallengePlaceWriter({
        enabled: options.enabled ?? true,
        transport,
        exceptionReporter: reporter,
        confirmationTimeoutMs: options.confirmationTimeoutMs ?? 20,
        rateLimitMs: options.rateLimitMs ?? 0,
        sessionFinishGraceMs: options.sessionFinishGraceMs ?? 20,
    });
    writer.setSessionPublishable("session-one", true);
    writer.start();
    return { directory, transport, reporter, writer };
}

async function waitForStatus(
    writer: ChallengePlaceWriter,
    key: string,
    status: GoalPublicationRecord["status"],
    timeoutMs = 1_000,
): Promise<GoalPublicationRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const record = writer.get(key);
        if (record?.status === status) return record;
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Timed out waiting for ${key} to become ${status}.`);
}

function cleanup(directory: string, writer: ChallengePlaceWriter): void {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
}

test("confirms a goal only from correlated event-added evidence", async () => {
    const context = fixture();
    try {
        context.transport.behaviors.push({ kind: "CONFIRM" });
        const record = context.writer.enqueue(goal());
        const confirmed = await waitForStatus(context.writer, record.key, "CONFIRMED");
        assert.equal(confirmed.confirmationEventId, "event-1");
        assert.equal(context.transport.sent.length, 1);
        assert.deepEqual(context.transport.sent[0]?.command, {
            matchId: "match-one",
            scoringCompetitorId: "home-team",
            opponentCompetitorId: "away-team",
            creditedChallengePlayerId: "challenge-player",
            eventTimeMs: 12_345,
        });
        assert.equal(context.writer.getSessionSummary("session-one").confirmedGoals, 1);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("marks missing confirmation uncertain and continues to a later goal", async () => {
    const context = fixture({ confirmationTimeoutMs: 10 });
    try {
        context.transport.behaviors.push({ kind: "SILENT" }, { kind: "CONFIRM" });
        const first = context.writer.enqueue(goal());
        const second = context.writer.enqueue(goal({ questionIndex: 1, eventTimeMs: 20_000 }));
        await waitForStatus(context.writer, first.key, "UNCERTAIN");
        await waitForStatus(context.writer, second.key, "CONFIRMED");
        assert.equal(context.transport.sent.length, 2);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("records explicit rejection without blocking later work", async () => {
    const context = fixture();
    try {
        context.transport.behaviors.push(
            { kind: "REJECT", detail: "denied, \"role\"\nreview" },
            { kind: "CONFIRM" },
        );
        const rejected = context.writer.enqueue(goal());
        const later = context.writer.enqueue(goal({ questionIndex: 1, eventTimeMs: 20_000 }));
        await waitForStatus(context.writer, rejected.key, "REJECTED");
        await waitForStatus(context.writer, later.key, "CONFIRMED");
        const reportPath = context.writer.getSessionSummary("session-one").exceptionReportPath;
        assert.ok(reportPath !== null);
        const csv = readFileSync(reportPath, "utf8");
        assert.match(csv, /"denied, ""role""\nreview"/);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("keeps a disconnected goal queued until session completion", async () => {
    const transport = new MockTransport();
    transport.connectAvailable = false;
    const context = fixture({ transport, sessionFinishGraceMs: 5 });
    try {
        const queued = context.writer.enqueue(goal());
        assert.equal(context.writer.get(queued.key)?.status, "QUEUED");
        assert.equal(transport.sent.length, 0);
        const summary = await context.writer.finishSession("session-one");
        assert.equal(context.writer.get(queued.key)?.status, "NOT_SENT");
        assert.equal(summary.unresolvedSubmissions, 1);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("classifies a disconnect during transmission as uncertain", async () => {
    const context = fixture();
    try {
        context.transport.behaviors.push({ kind: "DISCONNECT" });
        const record = context.writer.enqueue(goal());
        const uncertain = await waitForStatus(context.writer, record.key, "UNCERTAIN");
        assert.match(uncertain.detail ?? "", /disconnected during transmission/i);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("accepts late confirmation for an uncertain goal without resubmission", async () => {
    const context = fixture({ confirmationTimeoutMs: 8 });
    try {
        context.transport.behaviors.push({ kind: "SILENT" });
        const record = context.writer.enqueue(goal());
        await waitForStatus(context.writer, record.key, "UNCERTAIN");
        const sent = context.transport.sent[0];
        assert.ok(sent !== undefined);
        context.transport.confirm(sent.command);
        await waitForStatus(context.writer, record.key, "CONFIRMED");
        assert.equal(context.transport.sent.length, 1);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("deduplicates by live game and question while allowing reused PINs", async () => {
    const context = fixture();
    try {
        context.transport.behaviors.push({ kind: "CONFIRM" }, { kind: "CONFIRM" });
        const original = context.writer.enqueue(goal());
        const duplicate = context.writer.enqueue(goal({ expectedHomeScore: 99 }));
        const reusedPin = context.writer.enqueue(goal({
            liveGameId: "live-two",
            questionIndex: 0,
            eventTimeMs: 50_000,
        }));
        assert.equal(original, duplicate);
        await waitForStatus(context.writer, original.key, "CONFIRMED");
        await waitForStatus(context.writer, reusedPin.key, "CONFIRMED");
        assert.equal(context.transport.sent.length, 2);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("round-robins matches and applies the global attempt rate", async () => {
    const context = fixture({ rateLimitMs: 12 });
    try {
        context.writer.setSessionPublishable("session-two", true);
        context.transport.behaviors.push(
            { kind: "CONFIRM" }, { kind: "CONFIRM" },
            { kind: "CONFIRM" }, { kind: "CONFIRM" },
        );
        const records = [
            context.writer.enqueue(goal({ questionIndex: 0, matchId: "match-a", eventTimeMs: 1 })),
            context.writer.enqueue(goal({ questionIndex: 1, matchId: "match-a", eventTimeMs: 2 })),
            context.writer.enqueue(goal({
                sessionId: "session-two", liveGameId: "live-two", questionIndex: 0,
                matchId: "match-b", eventTimeMs: 3,
            })),
            context.writer.enqueue(goal({
                sessionId: "session-two", liveGameId: "live-two", questionIndex: 1,
                matchId: "match-b", eventTimeMs: 4,
            })),
        ];
        await Promise.all(records.map((record) =>
            waitForStatus(context.writer, record.key, "CONFIRMED")
        ));
        assert.deepEqual(
            context.transport.sent.map(({ command }) => command.matchId),
            ["match-a", "match-b", "match-a", "match-b"],
        );
        for (let index = 1; index < context.transport.sent.length; index += 1) {
            const current = context.transport.sent[index];
            const previous = context.transport.sent[index - 1];
            assert.ok(current !== undefined && previous !== undefined);
            assert.ok(current.at - previous.at >= 9);
        }
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("requires an explicit safe-session signal before transmission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cp-writer-test-"));
    const transport = new MockTransport();
    const writer = new ChallengePlaceWriter({
        enabled: true,
        transport,
        exceptionReporter: new ExceptionReporter({ rootDirectory: directory }),
        confirmationTimeoutMs: 20,
        rateLimitMs: 0,
    });
    writer.start();
    try {
        transport.behaviors.push({ kind: "CONFIRM" });
        const record = writer.enqueue(goal());
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(record.status, "QUEUED");
        assert.equal(transport.sent.length, 0);

        writer.setSessionPublishable("session-one", true);
        await waitForStatus(writer, record.key, "CONFIRMED");
        assert.equal(transport.sent.length, 1);
    } finally {
        cleanup(directory, writer);
    }
});

test("does not transmit a queued goal after session completion during rate limiting", async () => {
    const context = fixture({ rateLimitMs: 100, sessionFinishGraceMs: 5 });
    try {
        context.transport.behaviors.push({ kind: "CONFIRM" });
        const first = context.writer.enqueue(goal());
        await waitForStatus(context.writer, first.key, "CONFIRMED");

        const second = context.writer.enqueue(goal({
            questionIndex: 1,
            eventTimeMs: 20_000,
        }));
        const summary = await context.writer.finishSession("session-one");
        assert.equal(context.writer.get(second.key)?.status, "NOT_SENT");
        assert.equal(summary.unresolvedSubmissions, 1);

        await new Promise((resolve) => setTimeout(resolve, 110));
        assert.equal(context.transport.sent.length, 1);
        assert.equal(context.writer.get(second.key)?.status, "NOT_SENT");
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("disabled publishing records NOT_SENT without contacting transport", () => {
    const context = fixture({ enabled: false });
    try {
        const record = context.writer.enqueue(goal());
        assert.equal(record.status, "NOT_SENT");
        assert.equal(context.transport.sent.length, 0);
        assert.ok(context.writer.getSessionSummary("session-one").exceptionReportPath !== null);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("unresolved scorer attribution is never transmitted", () => {
    const context = fixture();
    try {
        const record = context.writer.enqueue(goal({ creditedChallengePlayerId: null }));
        assert.equal(record.status, "NOT_SENT");
        assert.match(record.detail ?? "", /scorer attribution/i);
        assert.equal(context.transport.sent.length, 0);
    } finally {
        cleanup(context.directory, context.writer);
    }
});

test("recovers an in-flight durable intent as uncertain without retrying", () => {
    const directory = mkdtempSync(join(tmpdir(), "cp-recovery-test-"));
    try {
        const firstReporter = new ExceptionReporter({ rootDirectory: directory });
        const record: GoalPublicationRecord = {
            ...goal(),
            key: "live-one:0",
            status: "SENDING",
            attemptTimestamp: "2026-10-31T00:00:00.000Z",
            detail: null,
            confirmationEventId: null,
        };
        firstReporter.writeSubmissionIntent(record);
        const recovered = new ExceptionReporter({ rootDirectory: directory })
            .recoverSubmissionIntents();
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0]?.status, "UNCERTAIN");
        assert.match(recovered[0]?.detail ?? "", /process interruption/i);
        assert.equal(readdirSync(join(directory, "intents")).length, 1);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
