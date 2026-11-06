import type Database from "better-sqlite3";
import {
    MATCH_STATUSES,
    type MatchFixture,
    type MatchStatus,
} from "./match-repository.js";
import { normalizeScheduledAt } from "./timestamps.js";

const CHALLENGE_ID_PATTERN = /^[a-f0-9]{24}$/;

export interface FixtureImportRecord {
    id: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    stage: string | null;
    status: MatchStatus;
}

export interface PlannedFixture {
    index: number;
    fixture: FixtureImportRecord;
    existing?: MatchFixture;
    reason?: string;
}

export interface FixtureImportPlan {
    input: number;
    inserted: PlannedFixture[];
    updated: PlannedFixture[];
    unchanged: PlannedFixture[];
    invalid: PlannedFixture[];
    unresolved: PlannedFixture[];
    unscheduled: PlannedFixture[];
}

interface MatchRow {
    id: string;
    home_team: string;
    away_team: string;
    scheduled_at: string | null;
    stage: string | null;
    status: MatchStatus;
    updated_at: string;
}

function emptyFixture(): FixtureImportRecord {
    return {
        id: "",
        homeTeam: "",
        awayTeam: "",
        scheduledAt: null,
        stage: null,
        status: "SCHEDULED",
    };
}

function parseFixture(value: unknown, index: number): PlannedFixture {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { index, fixture: emptyFixture(), reason: "Fixture must be an object." };
    }
    const candidate = value as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim().toLowerCase() : "";
    const homeTeam = typeof candidate.homeTeam === "string"
        ? candidate.homeTeam.trim().toLowerCase()
        : "";
    const awayTeam = typeof candidate.awayTeam === "string"
        ? candidate.awayTeam.trim().toLowerCase()
        : "";
    const stage = candidate.stage === null || candidate.stage === undefined
        ? null
        : typeof candidate.stage === "string"
            ? candidate.stage.trim() || null
            : null;
    const rawStatus = candidate.status ?? "SCHEDULED";
    const status = typeof rawStatus === "string"
        && (MATCH_STATUSES as readonly string[]).includes(rawStatus)
        ? rawStatus as MatchStatus
        : "SCHEDULED";

    let scheduledAt: string | null = null;
    if (candidate.scheduledAt !== null && candidate.scheduledAt !== undefined) {
        if (typeof candidate.scheduledAt !== "string") {
            return {
                index,
                fixture: { id, homeTeam, awayTeam, scheduledAt, stage, status },
                reason: "scheduledAt must be a timezone-qualified string or null.",
            };
        }
        scheduledAt = normalizeScheduledAt(candidate.scheduledAt.trim());
        if (scheduledAt === null) {
            return {
                index,
                fixture: { id, homeTeam, awayTeam, scheduledAt, stage, status },
                reason: "scheduledAt is invalid or does not include a timezone.",
            };
        }
    }

    const fixture = { id, homeTeam, awayTeam, scheduledAt, stage, status };
    if (!CHALLENGE_ID_PATTERN.test(id)) {
        return { index, fixture, reason: "id must be a 24-character Challenge Place ID." };
    }
    if (!CHALLENGE_ID_PATTERN.test(homeTeam) || !CHALLENGE_ID_PATTERN.test(awayTeam)) {
        return {
            index,
            fixture,
            reason: "homeTeam and awayTeam must be 24-character competitor IDs.",
        };
    }
    if (homeTeam === awayTeam) {
        return { index, fixture, reason: "A fixture cannot contain the same team twice." };
    }
    if (typeof rawStatus !== "string" || !(MATCH_STATUSES as readonly string[]).includes(rawStatus)) {
        return { index, fixture, reason: "status is not a supported match status." };
    }
    if (
        candidate.stage !== undefined
        && candidate.stage !== null
        && typeof candidate.stage !== "string"
    ) {
        return { index, fixture, reason: "stage must be a string or null." };
    }
    return { index, fixture };
}

function fixturesEqual(left: FixtureImportRecord, right: FixtureImportRecord): boolean {
    return left.id === right.id
        && left.homeTeam === right.homeTeam
        && left.awayTeam === right.awayTeam
        && left.scheduledAt === right.scheduledAt
        && left.stage === right.stage
        && left.status === right.status;
}

function rowToFixture(row: MatchRow): MatchFixture {
    return {
        id: row.id,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        scheduledAt: row.scheduled_at,
        stage: row.stage,
        status: row.status,
        updatedAt: row.updated_at,
    };
}

export function planFixtureImport(
    database: Database.Database,
    rawFixtures: readonly unknown[],
): FixtureImportPlan {
    const parsed = rawFixtures.map(parseFixture);
    const invalid = parsed.filter((item) => item.reason !== undefined);
    const valid = parsed.filter((item) => item.reason === undefined);
    const grouped = new Map<string, PlannedFixture[]>();
    for (const item of valid) {
        const group = grouped.get(item.fixture.id) ?? [];
        group.push(item);
        grouped.set(item.fixture.id, group);
    }

    const candidates: PlannedFixture[] = [];
    for (const group of grouped.values()) {
        const first = group[0];
        if (first === undefined) continue;
        if (group.some((item) => !fixturesEqual(first.fixture, item.fixture))) {
            invalid.push(...group.map((item) => ({
                ...item,
                reason: "The import contains conflicting records for this match ID.",
            })));
            continue;
        }
        candidates.push(first);
        for (const duplicate of group.slice(1)) {
            invalid.push({ ...duplicate, reason: "Duplicate fixture in the import file." });
        }
    }

    const knownTeamRows = database.prepare(`
        SELECT DISTINCT team_id
        FROM players
        WHERE team_id IS NOT NULL
    `).all() as Array<{ team_id: string }>;
    const knownTeamIds = new Set(knownTeamRows.map((row) => row.team_id));
    const selectExisting = database.prepare(`
        SELECT id, home_team, away_team, scheduled_at, stage, status, updated_at
        FROM matches WHERE id = ?
    `);
    const inserted: PlannedFixture[] = [];
    const updated: PlannedFixture[] = [];
    const unchanged: PlannedFixture[] = [];
    const unresolved: PlannedFixture[] = [];
    const unscheduled: PlannedFixture[] = [];

    for (const item of candidates) {
        if (
            !knownTeamIds.has(item.fixture.homeTeam)
            || !knownTeamIds.has(item.fixture.awayTeam)
        ) {
            unresolved.push({
                ...item,
                reason: "A competitor ID is not present in the local player registry.",
            });
            continue;
        }
        if (item.fixture.scheduledAt === null) {
            unscheduled.push({
                ...item,
                reason: "This fixture has no scheduled time and cannot be auto-selected.",
            });
        }

        const row = selectExisting.get(item.fixture.id) as MatchRow | undefined;
        if (row === undefined) {
            inserted.push(item);
            continue;
        }
        const existing = rowToFixture(row);
        const planned = { ...item, existing };
        if (fixturesEqual(item.fixture, existing)) unchanged.push(planned);
        else updated.push(planned);
    }

    return {
        input: rawFixtures.length,
        inserted,
        updated,
        unchanged,
        invalid,
        unresolved,
        unscheduled,
    };
}

export function applyFixtureImport(
    database: Database.Database,
    plan: FixtureImportPlan,
): { inserted: number; updated: number } {
    const insert = database.prepare(`
        INSERT INTO matches (
            id, home_team, away_team, scheduled_at, stage, status
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const update = database.prepare(`
        UPDATE matches
        SET home_team = ?,
            away_team = ?,
            scheduled_at = ?,
            stage = ?,
            status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    let inserted = 0;
    let updated = 0;

    database.transaction(() => {
        for (const item of plan.inserted) {
            const fixture = item.fixture;
            inserted += insert.run(
                fixture.id,
                fixture.homeTeam,
                fixture.awayTeam,
                fixture.scheduledAt,
                fixture.stage,
                fixture.status,
            ).changes;
        }
        for (const item of plan.updated) {
            const fixture = item.fixture;
            updated += update.run(
                fixture.homeTeam,
                fixture.awayTeam,
                fixture.scheduledAt,
                fixture.stage,
                fixture.status,
                fixture.id,
            ).changes;
        }
    })();

    return { inserted, updated };
}

export function summarizeFixturePlan(plan: FixtureImportPlan) {
    return {
        input: plan.input,
        inserted: plan.inserted.length,
        updated: plan.updated.length,
        unchanged: plan.unchanged.length,
        invalid: plan.invalid.length,
        unresolved: plan.unresolved.length + plan.unscheduled.length,
    };
}
