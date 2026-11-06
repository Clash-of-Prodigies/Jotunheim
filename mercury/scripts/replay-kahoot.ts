import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { csvObjects } from "../replay/replay-file.js";
import { scoreCompletedQuestion } from "../scoring/scoring-engine.js";

export interface ReplayComparison {
    liveGameId: string;
    questionIndex: number;
    matchesOriginal: boolean;
    differences: string[];
}

function numberValue(value: string): number | null {
    if (value.length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: string): boolean | undefined {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
}

function closeEnough(left: number, right: number): boolean {
    return Math.abs(left - right) < 1e-9;
}

export function replayFile(path: string): ReplayComparison[] {
    const rows = csvObjects(readFileSync(path, "utf8"));
    const groups = new Map<string, Array<Record<string, string>>>();
    for (const row of rows) {
        if (row.outcome !== "FINALIZED") continue;
        const key = `${row.live_game_id}:${row.question_index}:${row.event_hash}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }

    const comparisons: ReplayComparison[] = [];
    for (const group of groups.values()) {
        const first = group[0];
        if (first === undefined) continue;
        const differences: string[] = [];
        const homeTeamId = first.home_team_id ?? "";
        const awayTeamId = first.away_team_id ?? "";
        const participants = group.flatMap((row) => {
            const points = numberValue(row.points ?? "");
            if (
                points === null
                || (row.registered_player_id ?? "").length === 0
                || (row.team_id ?? "").length === 0
            ) return [];
            const reactionTimeMs = numberValue(row.reaction_time_ms ?? "");
            const isCorrect = booleanValue(row.is_correct ?? "");
            return [{
                controllerId: row.controller_id ?? "",
                playerId: row.registered_player_id ?? "",
                teamId: row.team_id ?? "",
                points,
                ...(reactionTimeMs === null ? {} : { reactionTimeMs }),
                ...(isCorrect === undefined ? {} : { isCorrect }),
            }];
        });
        const decision = scoreCompletedQuestion({ homeTeamId, awayTeamId, participants });
        if (decision.status === "UNRESOLVED") {
            differences.push(`Replay unresolved: ${decision.reason}`);
        } else {
            const originalHomeMean = numberValue(first.original_home_mean ?? "");
            const originalAwayMean = numberValue(first.original_away_mean ?? "");
            const originalDifference = numberValue(first.original_difference_percent ?? "");
            if (originalHomeMean === null || !closeEnough(decision.homeMean, originalHomeMean)) {
                differences.push("home mean differs");
            }
            if (originalAwayMean === null || !closeEnough(decision.awayMean, originalAwayMean)) {
                differences.push("away mean differs");
            }
            if (originalDifference === null || !closeEnough(decision.differencePercent, originalDifference)) {
                differences.push("difference percent differs");
            }
            if (String(decision.goalAwarded) !== (first.original_goal_awarded ?? "")) {
                differences.push("goal decision differs");
            }
            if ((decision.scoringTeamId ?? "") !== (first.original_scoring_team_id ?? "")) {
                differences.push("scoring team differs");
            }
            if ((decision.creditedPlayerId ?? "") !== (first.original_credited_player_id ?? "")) {
                differences.push("credited player differs");
            }
        }
        comparisons.push({
            liveGameId: first.live_game_id ?? "",
            questionIndex: Number(first.question_index ?? 0),
            matchesOriginal: differences.length === 0,
            differences,
        });
    }
    return comparisons.sort((left, right) => left.questionIndex - right.questionIndex);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
    const input = process.argv[2];
    if (input === undefined) throw new Error("Usage: npm run replay:kahoot -- <replay.csv>");
    const comparisons = replayFile(resolve(input));
    console.log(JSON.stringify(comparisons, null, 2));
    if (comparisons.some((comparison) => !comparison.matchesOriginal)) process.exitCode = 1;
}
