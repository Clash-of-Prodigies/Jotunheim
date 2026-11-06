import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { GoalPublicationRecord } from "./publication-types.js";

const CSV_COLUMNS = [
    "session_id",
    "live_game_id",
    "match_id",
    "question_index",
    "scoring_competitor_id",
    "credited_challenge_player_id",
    "home_mean",
    "away_mean",
    "expected_home_score",
    "expected_away_score",
    "publication_status",
    "attempt_timestamp",
    "detail",
] as const;

function safeName(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    return normalized.length === 0 ? "unknown" : normalized;
}

function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function escapeCsv(value: unknown): string {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportIdentity(record: GoalPublicationRecord): string {
    return `${record.sessionId}\u0000${record.liveGameId}\u0000${record.matchId}`;
}

function toCsvRow(record: GoalPublicationRecord): string {
    return [
        record.sessionId,
        record.liveGameId,
        record.matchId,
        record.questionIndex,
        record.scoringCompetitorId,
        record.creditedChallengePlayerId,
        record.homeMean,
        record.awayMean,
        record.expectedHomeScore,
        record.expectedAwayScore,
        record.status,
        record.attemptTimestamp,
        record.detail,
    ].map(escapeCsv).join(",");
}

function isPublicationRecord(value: unknown): value is GoalPublicationRecord {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Partial<GoalPublicationRecord>;
    return typeof candidate.key === "string"
        && typeof candidate.sessionId === "string"
        && typeof candidate.liveGameId === "string"
        && typeof candidate.matchId === "string"
        && typeof candidate.questionIndex === "number"
        && typeof candidate.status === "string";
}

export interface ExceptionReporterOptions {
    rootDirectory: string;
    onError?: (error: Error) => void;
}

export class ExceptionReporter {
    readonly rootDirectory: string;
    private readonly reportsDirectory: string;
    private readonly intentsDirectory: string;
    private readonly recordsByReport = new Map<string, Map<string, GoalPublicationRecord>>();
    private readonly reportPaths = new Map<string, string>();
    private readonly onError: (error: Error) => void;

    constructor(options: ExceptionReporterOptions) {
        this.rootDirectory = resolve(options.rootDirectory);
        this.reportsDirectory = join(this.rootDirectory, "exceptions");
        this.intentsDirectory = join(this.rootDirectory, "intents");
        this.onError = options.onError ?? ((error) => {
            console.error("[CP] CRITICAL: exception-log write failed", error);
        });
    }

    recordOutstanding(record: GoalPublicationRecord): string {
        const identity = reportIdentity(record);
        let records = this.recordsByReport.get(identity);
        if (records === undefined) {
            records = new Map();
            this.recordsByReport.set(identity, records);
        }
        records.set(record.key, { ...record });
        return this.writeReport(identity, record);
    }

    writeSubmissionIntent(record: GoalPublicationRecord): string {
        const path = this.intentPath(record.key);
        this.atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
        return path;
    }

    resolveConfirmed(record: GoalPublicationRecord): void {
        const identity = reportIdentity(record);
        const records = this.recordsByReport.get(identity);
        records?.delete(record.key);
        const intentPath = this.intentPath(record.key);
        try {
            if (existsSync(intentPath)) rmSync(intentPath);
            if (records !== undefined && records.size === 0) {
                const reportPath = this.reportPaths.get(identity);
                if (reportPath !== undefined && existsSync(reportPath)) rmSync(reportPath);
                this.reportPaths.delete(identity);
            } else if (records !== undefined) {
                this.writeReport(identity, record);
            }
        } catch (error: unknown) {
            this.reportFailure(error);
        }
    }

    flushSession(sessionId: string): void {
        for (const [identity, records] of this.recordsByReport) {
            const first = records.values().next().value as GoalPublicationRecord | undefined;
            if (first?.sessionId === sessionId) this.writeReport(identity, first);
        }
    }

    getReportPath(record: GoalPublicationRecord): string | null {
        return this.reportPaths.get(reportIdentity(record)) ?? null;
    }

    getSessionReportPath(sessionId: string): string | null {
        for (const [identity, records] of this.recordsByReport) {
            const first = records.values().next().value as GoalPublicationRecord | undefined;
            if (first?.sessionId === sessionId) return this.reportPaths.get(identity) ?? null;
        }
        return null;
    }

    recoverSubmissionIntents(): GoalPublicationRecord[] {
        if (!existsSync(this.intentsDirectory)) return [];
        const recovered: GoalPublicationRecord[] = [];
        for (const file of readdirSync(this.intentsDirectory)) {
            if (!file.endsWith(".json")) continue;
            try {
                const path = join(this.intentsDirectory, basename(file));
                const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
                if (!isPublicationRecord(parsed)) continue;
                const record: GoalPublicationRecord = {
                    ...parsed,
                    status: parsed.status === "SENDING" ? "UNCERTAIN" : parsed.status,
                    detail: parsed.status === "SENDING"
                        ? "Recovered a submission intent left in SENDING after process interruption."
                        : parsed.detail,
                };
                this.recordOutstanding(record);
                this.writeSubmissionIntent(record);
                recovered.push(record);
            } catch (error: unknown) {
                this.reportFailure(error);
            }
        }
        return recovered;
    }

    private reportPath(record: GoalPublicationRecord): string {
        const identity = reportIdentity(record);
        const existing = this.reportPaths.get(identity);
        if (existing !== undefined) return existing;
        const filename = [
            "cp-exceptions",
            safeName(record.matchId),
            safeName(record.sessionId),
            shortHash(`${record.liveGameId}:${record.sessionId}`),
        ].join("-") + ".csv";
        const path = join(this.reportsDirectory, filename);
        this.reportPaths.set(identity, path);
        return path;
    }

    private writeReport(identity: string, fallback: GoalPublicationRecord): string {
        const records = this.recordsByReport.get(identity) ?? new Map();
        const first = records.values().next().value as GoalPublicationRecord | undefined;
        const path = this.reportPath(first ?? fallback);
        const rows = [...records.values()]
            .sort((left, right) => left.questionIndex - right.questionIndex)
            .map(toCsvRow);
        this.atomicWrite(path, `${CSV_COLUMNS.join(",")}\n${rows.length === 0 ? "" : `${rows.join("\n")}\n`}`);
        return path;
    }

    private intentPath(key: string): string {
        return join(this.intentsDirectory, `intent-${shortHash(key)}.json`);
    }

    private atomicWrite(path: string, content: string): void {
        try {
            mkdirSync(resolve(path, ".."), { recursive: true });
            const temporary = `${path}.${process.pid}.tmp`;
            writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
            renameSync(temporary, path);
        } catch (error: unknown) {
            this.reportFailure(error);
            throw error;
        }
    }

    private reportFailure(error: unknown): void {
        this.onError(error instanceof Error ? error : new Error(String(error)));
    }
}
