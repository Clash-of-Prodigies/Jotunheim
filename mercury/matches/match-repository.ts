import type Database from "better-sqlite3";
import { normalizeScheduledAt } from "./timestamps.js";

export const MATCH_STATUSES = ["SCHEDULED", "ACTIVE", "COMPLETED", "POSTPONED", "CANCELLED"] as const;

export type MatchStatus = typeof MATCH_STATUSES[number];

export interface MatchFixture {
    id: string;
    homeTeam: string; awayTeam: string;
    scheduledAt: string | null; updatedAt: string;
    stage: string | null; status: MatchStatus;
}

interface MatchRow {
    id: string;
    home_team: string; away_team: string;
    scheduled_at: string | null; updated_at: string;
    stage: string | null; status: MatchStatus;
}

const ELIGIBLE_STATUSES: readonly MatchStatus[] = ["SCHEDULED", "ACTIVE"];

function toMatchFixture(row: MatchRow): MatchFixture {
    return {
        id: row.id,
        homeTeam: row.home_team, awayTeam: row.away_team,
        scheduledAt: row.scheduled_at, updatedAt: row.updated_at,
        stage: row.stage, status: row.status,
    };
}

export function isFixtureEligible(status: MatchStatus): boolean {
    return ELIGIBLE_STATUSES.includes(status);
}

export function getMatchById(database: Database.Database, matchId: string): MatchFixture | null {
    const row = database.prepare(`
        SELECT id, home_team, away_team, scheduled_at, stage, status, updated_at FROM matches
        WHERE id = ?
    `).get(matchId) as MatchRow | undefined;
    return row === undefined ? null : toMatchFixture(row);
}

export function listEligibleMatches(database: Database.Database): MatchFixture[] {
    const rows = database.prepare(`
        SELECT id, home_team, away_team, scheduled_at, stage, status, updated_at FROM matches
        WHERE status IN ('SCHEDULED', 'ACTIVE')
        ORDER BY scheduled_at, id
    `).all() as MatchRow[];
    return rows.map(toMatchFixture);
}

export function getEligibleMatchesForTeams(database: Database.Database, firstTeamId: string, secondTeamId: string): MatchFixture[] {
    const rows = database.prepare(`
        SELECT id, home_team, away_team, scheduled_at, stage, status, updated_at FROM matches
        WHERE status IN ('SCHEDULED', 'ACTIVE')
        AND ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?))
        ORDER BY scheduled_at, id
    `).all(firstTeamId, secondTeamId, secondTeamId, firstTeamId) as MatchRow[];
    return rows.map(toMatchFixture);
}

export function getScheduledMatchesWithinWindow(database: Database.Database, windowStart: string, windowEnd: string): MatchFixture[] {
    const normalizedStart = normalizeScheduledAt(windowStart);
    const normalizedEnd = normalizeScheduledAt(windowEnd);
    if (normalizedStart === null || normalizedEnd === null) {
        throw new Error("Fixture window timestamps must include a valid timezone.");
    }
    if (normalizedStart > normalizedEnd) {
        throw new Error("Fixture window start must not be after its end.");
    }

    const rows = database.prepare(`
        SELECT id, home_team, away_team, scheduled_at, stage, status, updated_at FROM matches
        WHERE status IN ('SCHEDULED', 'ACTIVE')
        AND scheduled_at IS NOT NULL AND scheduled_at BETWEEN ? AND ?
        ORDER BY scheduled_at, id
    `).all(normalizedStart, normalizedEnd) as MatchRow[];
    return rows.map(toMatchFixture);
}