import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface ImportRecord {
    fullName: string | null;
    challengePlayerId: string;
    teamName: string | null;
    challengeCompetitorId: string | null;
}

interface ExistingPlayer {
    id: string;
    name: string;
    challenge_player_id: string;
    team_id: string | null;
}

interface ClassifiedRecord {
    index: number;
    record: ImportRecord;
    reason?: string;
    existingPlayer?: ExistingPlayer;
}

interface Assessment {
    input: number;
    updates: ClassifiedRecord[];
    unchanged: ClassifiedRecord[];
    unresolved: ClassifiedRecord[];
    invalid: ClassifiedRecord[];
    conflicting: ClassifiedRecord[];
    nameDifferences: ClassifiedRecord[];
}

interface Options {
    apply: boolean;
    datasetPath: string;
    databasePath: string;
    reportPath: string;
}

const CHALLENGE_ID_PATTERN = /^[a-f0-9]{24}$/;
const defaultDatasetPath = resolve(
    process.cwd(),
    ".local/challenge-place/players-67e6c447b56df17628866dc3.json",
);
const defaultDatabasePath = resolve(import.meta.dirname, "../db/mercury.sqlite");
const defaultReportPath = resolve(
    process.cwd(),
    ".local/challenge-place/import-report.json",
);

function parseOptions(argv: string[]): Options {
    let apply = false;
    let datasetPath = defaultDatasetPath;
    let databasePath = defaultDatabasePath;
    let reportPath = defaultReportPath;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--apply") {
            apply = true;
            continue;
        }
        if (argument === "--dry-run") {
            apply = false;
            continue;
        }

        const nextValue = argv[index + 1];
        if (argument === "--dataset" && nextValue !== undefined) {
            datasetPath = resolve(nextValue);
            index += 1;
            continue;
        }
        if (argument === "--database" && nextValue !== undefined) {
            databasePath = resolve(nextValue);
            index += 1;
            continue;
        }
        if (argument === "--report" && nextValue !== undefined) {
            reportPath = resolve(nextValue);
            index += 1;
            continue;
        }
        throw new Error(`Unknown or incomplete argument: ${argument}`);
    }

    return { apply, datasetPath, databasePath, reportPath };
}

function parseRecord(value: unknown, index: number): ClassifiedRecord {
    const fallback: ImportRecord = {
        fullName: null,
        challengePlayerId: "",
        teamName: null,
        challengeCompetitorId: null,
    };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { index, record: fallback, reason: "Record must be an object." };
    }

    const candidate = value as Record<string, unknown>;
    const record: ImportRecord = {
        fullName: typeof candidate.fullName === "string"
            ? candidate.fullName.trim()
            : null,
        challengePlayerId: typeof candidate.challengePlayerId === "string"
            ? candidate.challengePlayerId.trim().toLowerCase()
            : "",
        teamName: typeof candidate.teamName === "string"
            ? candidate.teamName.trim()
            : null,
        challengeCompetitorId: typeof candidate.challengeCompetitorId === "string"
            ? candidate.challengeCompetitorId.trim().toLowerCase()
            : null,
    };

    if (!CHALLENGE_ID_PATTERN.test(record.challengePlayerId)) {
        return {
            index,
            record,
            reason: "challengePlayerId must be 24 lowercase hexadecimal characters.",
        };
    }
    if (
        record.challengeCompetitorId !== null
        && !CHALLENGE_ID_PATTERN.test(record.challengeCompetitorId)
    ) {
        return {
            index,
            record,
            reason: "challengeCompetitorId must be null or 24 lowercase hexadecimal characters.",
        };
    }
    if (
        candidate.fullName !== undefined
        && candidate.fullName !== null
        && typeof candidate.fullName !== "string"
    ) {
        return { index, record, reason: "fullName must be a string or null." };
    }
    if (
        candidate.teamName !== undefined
        && candidate.teamName !== null
        && typeof candidate.teamName !== "string"
    ) {
        return { index, record, reason: "teamName must be a string or null." };
    }

    return { index, record };
}

function recordsAgree(left: ImportRecord, right: ImportRecord): boolean {
    return left.challengeCompetitorId === right.challengeCompetitorId;
}

function assessRecords(database: Database.Database, rawRecords: unknown[]): Assessment {
    const parsed = rawRecords.map(parseRecord);
    const invalid = parsed.filter((item) => item.reason !== undefined);
    const valid = parsed.filter((item) => item.reason === undefined);
    const byPlayerId = new Map<string, ClassifiedRecord[]>();

    for (const item of valid) {
        const group = byPlayerId.get(item.record.challengePlayerId) ?? [];
        group.push(item);
        byPlayerId.set(item.record.challengePlayerId, group);
    }

    const candidates: ClassifiedRecord[] = [];
    const conflicting: ClassifiedRecord[] = [];
    for (const group of byPlayerId.values()) {
        const first = group[0];
        if (first === undefined) continue;

        if (group.some((item) => !recordsAgree(first.record, item.record))) {
            conflicting.push(...group.map((item) => ({
                ...item,
                reason: "The dataset assigns multiple team IDs to this Challenge Place player ID.",
            })));
            continue;
        }
        candidates.push(first);
        for (const duplicate of group.slice(1)) {
            invalid.push({ ...duplicate, reason: "Duplicate record in the import dataset." });
        }
    }

    const selectPlayer = database.prepare(`
        SELECT id, name, challenge_player_id, team_id
        FROM players
        WHERE challenge_player_id = ?
    `);
    const updates: ClassifiedRecord[] = [];
    const unchanged: ClassifiedRecord[] = [];
    const unresolved: ClassifiedRecord[] = [];
    const nameDifferences: ClassifiedRecord[] = [];

    for (const item of candidates) {
        const existingPlayer = selectPlayer.get(
            item.record.challengePlayerId,
        ) as ExistingPlayer | undefined;

        if (existingPlayer === undefined) {
            unresolved.push({
                ...item,
                reason: "No local player has this Challenge Place player ID.",
            });
            continue;
        }
        if (item.record.challengeCompetitorId === null) {
            unresolved.push({
                ...item,
                existingPlayer,
                reason: "The source did not provide a verified competitor/team ID.",
            });
            continue;
        }
        if (
            item.record.fullName !== null
            && item.record.fullName !== existingPlayer.name
        ) {
            nameDifferences.push({ ...item, existingPlayer });
        }

        const classified = { ...item, existingPlayer };
        if (existingPlayer.team_id === item.record.challengeCompetitorId) {
            unchanged.push(classified);
        } else {
            updates.push(classified);
        }
    }

    return {
        input: rawRecords.length,
        updates,
        unchanged,
        unresolved,
        invalid,
        conflicting,
        nameDifferences,
    };
}

function summarize(assessment: Assessment) {
    return {
        input: assessment.input,
        updates: assessment.updates.length,
        unchanged: assessment.unchanged.length,
        unresolved: assessment.unresolved.length,
        invalid: assessment.invalid.length,
        conflicting: assessment.conflicting.length,
        nameDifferences: assessment.nameDifferences.length,
    };
}

function assertExpectedSchema(database: Database.Database): void {
    const version = Number(database.pragma("user_version", { simple: true }));
    if (version !== 2) {
        throw new Error(`Expected schema version 2, found ${version}.`);
    }

    const columns = database.pragma("table_info(players)") as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    for (const column of [
        "id",
        "name",
        "challenge_player_id",
        "team_id",
        "nickname",
        "created_at",
    ]) {
        if (!columnNames.has(column)) {
            throw new Error(`Unsupported players schema: missing ${column}.`);
        }
    }

    const aliasTable = database.prepare(`
        SELECT 1 FROM sqlite_schema
        WHERE type = 'table' AND name = 'player_aliases'
    `).get();
    if (aliasTable !== undefined) {
        throw new Error("Schema version 2 must not contain player_aliases.");
    }
}

function timestampForFile(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

const options = parseOptions(process.argv.slice(2));
const parsedDataset = JSON.parse(readFileSync(options.datasetPath, "utf8")) as unknown;
if (!Array.isArray(parsedDataset)) {
    throw new Error("The import dataset must be a JSON array.");
}

const database = new Database(options.databasePath, {
    fileMustExist: true,
    timeout: 5_000,
});
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
assertExpectedSchema(database);

let assessment = assessRecords(database, parsedDataset);
const dryRun = summarize(assessment);
let backupPath: string | null = null;
let appliedUpdates = 0;

if (options.apply) {
    const backupDirectory = resolve(process.cwd(), ".local/backups");
    mkdirSync(backupDirectory, { recursive: true });
    backupPath = resolve(
        backupDirectory,
        `mercury-before-team-import-${timestampForFile()}.sqlite`,
    );
    await database.backup(backupPath);

    assessment = assessRecords(database, parsedDataset);
    const updateTeam = database.prepare(`
        UPDATE players
        SET team_id = ?
        WHERE challenge_player_id = ?
    `);
    database.transaction(() => {
        for (const item of assessment.updates) {
            const teamId = item.record.challengeCompetitorId;
            if (teamId === null) {
                throw new Error("A planned team update lost its competitor ID.");
            }
            const result = updateTeam.run(teamId, item.record.challengePlayerId);
            if (result.changes !== 1) {
                throw new Error(
                    `Expected one player update for ${item.record.challengePlayerId}, got ${result.changes}.`,
                );
            }
            appliedUpdates += 1;
        }
    })();
}

const verification = {
    totalPlayers: (
        database.prepare("SELECT COUNT(*) AS count FROM players").get() as { count: number }
    ).count,
    assignedPlayers: (
        database.prepare(
            "SELECT COUNT(*) AS count FROM players WHERE team_id IS NOT NULL",
        ).get() as { count: number }
    ).count,
    unresolvedPlayers: database.prepare(`
        SELECT id, name, challenge_player_id
        FROM players
        WHERE team_id IS NULL
        ORDER BY created_at, id
    `).all(),
    duplicateChallengePlayerIds: database.prepare(`
        SELECT challenge_player_id, COUNT(*) AS count
        FROM players
        GROUP BY challenge_player_id
        HAVING COUNT(*) > 1
    `).all(),
    integrityCheck: database.pragma("integrity_check"),
    foreignKeyViolations: database.pragma("foreign_key_check") as unknown[],
};

const report = {
    mode: options.apply ? "apply" : "dry-run",
    datasetPath: options.datasetPath,
    databasePath: options.databasePath,
    backupPath,
    dryRun,
    applied: { updatedTeamAssignments: appliedUpdates },
    review: {
        invalid: assessment.invalid,
        conflicting: assessment.conflicting,
        unresolved: assessment.unresolved,
        nameDifferences: assessment.nameDifferences,
    },
    verification,
};

mkdirSync(dirname(options.reportPath), { recursive: true });
writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
database.close();

if (
    assessment.invalid.length > 0
    || assessment.conflicting.length > 0
    || assessment.unresolved.length > 0
    || verification.duplicateChallengePlayerIds.length > 0
    || verification.foreignKeyViolations.length > 0
) {
    process.exitCode = 2;
}
