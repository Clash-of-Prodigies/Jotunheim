import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    applyFixtureImport,
    planFixtureImport,
    summarizeFixturePlan,
} from "../matches/fixture-import.js";

interface Options {
    apply: boolean;
    filePath: string;
    databasePath: string;
    reportPath: string;
}

function parseOptions(argv: string[]): Options {
    let apply = false;
    let filePath = resolve(
        process.cwd(),
        ".local/challenge-place/fixtures-67e6c447b56df17628866dc3.json",
    );
    let databasePath = resolve(import.meta.dirname, "../db/mercury.sqlite");
    let reportPath = resolve(
        process.cwd(),
        ".local/challenge-place/fixture-import-report.json",
    );

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
        const value = argv[index + 1];
        if ((argument === "--file" || argument === "--dataset") && value !== undefined) {
            filePath = resolve(value);
            index += 1;
            continue;
        }
        if (argument === "--database" && value !== undefined) {
            databasePath = resolve(value);
            index += 1;
            continue;
        }
        if (argument === "--report" && value !== undefined) {
            reportPath = resolve(value);
            index += 1;
            continue;
        }
        throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    return { apply, filePath, databasePath, reportPath };
}

function timestampForFile(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

const options = parseOptions(process.argv.slice(2));
const rawData = JSON.parse(readFileSync(options.filePath, "utf8")) as unknown;
if (!Array.isArray(rawData)) throw new Error("Fixture import file must be a JSON array.");

const database = new Database(options.databasePath, {
    fileMustExist: true,
    timeout: 5_000,
});
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
const schemaVersion = Number(database.pragma("user_version", { simple: true }));
if (schemaVersion !== 3) {
    throw new Error(`Expected schema version 3, found ${schemaVersion}.`);
}

let plan = planFixtureImport(database, rawData);
const dryRun = summarizeFixturePlan(plan);
let backupPath: string | null = null;
let applied = { inserted: 0, updated: 0 };

if (options.apply) {
    const backupDirectory = resolve(process.cwd(), ".local/backups");
    mkdirSync(backupDirectory, { recursive: true });
    backupPath = resolve(
        backupDirectory,
        `mercury-before-fixture-import-${timestampForFile()}.sqlite`,
    );
    await database.backup(backupPath);
    plan = planFixtureImport(database, rawData);
    applied = applyFixtureImport(database, plan);
}

const verification = {
    totalFixtures: (
        database.prepare("SELECT COUNT(*) AS count FROM matches").get() as { count: number }
    ).count,
    integrityCheck: database.pragma("integrity_check"),
    foreignKeyViolations: database.pragma("foreign_key_check") as unknown[],
};
const report = {
    mode: options.apply ? "apply" : "dry-run",
    filePath: options.filePath,
    databasePath: options.databasePath,
    backupPath,
    dryRun,
    applied,
    review: {
        invalid: plan.invalid,
        unresolved: plan.unresolved,
        unscheduled: plan.unscheduled,
    },
    verification,
};

mkdirSync(dirname(options.reportPath), { recursive: true });
writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
database.close();

if (
    plan.invalid.length > 0
    || plan.unresolved.length > 0
    || verification.foreignKeyViolations.length > 0
) {
    process.exitCode = 2;
}
