import type Database from "better-sqlite3";

export interface Player {
    id: string;
    name: string;
    challengePlayerId: string;
    teamId: string | null;
    nickname: string | null;
}

interface PlayerRow {
    id: string;
    name: string;
    challenge_player_id: string;
    team_id: string | null;
    nickname: string | null;
}

export type PlayerResolution =
    | { status: "MATCHED"; player: Player }
    | { status: "NOT_FOUND" }
    | { status: "AMBIGUOUS"; players: Player[] };

export function normalizeName(name: string): string {
    return name
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function toPlayer(row: PlayerRow): Player {
    return {
        id: row.id,
        name: row.name,
        challengePlayerId: row.challenge_player_id,
        teamId: row.team_id,
        nickname: row.nickname,
    };
}

export function listPlayers(database: Database.Database, teamIds?: readonly string[]): Player[] {
    let rows: PlayerRow[];

    if (teamIds === undefined) {
        rows = database.prepare(`
            SELECT id, name, challenge_player_id, team_id, nickname FROM players
            ORDER BY created_at, id
        `).all() as PlayerRow[];
    } else {
        const uniqueTeamIds = [...new Set(teamIds)];
        if (uniqueTeamIds.length === 0) return [];
        
        const placeholders = uniqueTeamIds.map(() => "?").join(", ");
        rows = database.prepare(`
            SELECT id, name, challenge_player_id, team_id, nickname FROM players
            WHERE team_id IN (${placeholders}) ORDER BY created_at, id
        `).all(...uniqueTeamIds) as PlayerRow[];
    }

    return rows.map(toPlayer);
}

export function getPlayerByChallengePlayerId(database: Database.Database, challengePlayerId: string): Player | null {
    const row = database.prepare(`
        SELECT id, name, challenge_player_id, team_id, nickname FROM players
        WHERE challenge_player_id = ?
    `).get(challengePlayerId) as PlayerRow | undefined;

    return row === undefined ? null : toPlayer(row);
}

export function resolvePlayer(database: Database.Database, incomingNickname: string, teamIds?: readonly string[]): PlayerResolution {
    const normalizedIncoming = normalizeName(incomingNickname);
    if (normalizedIncoming.length === 0) return { status: "NOT_FOUND" };
    
    const matches = listPlayers(database, teamIds).filter((player) =>
        normalizeName(player.name) === normalizedIncoming
        || (player.nickname !== null && normalizeName(player.nickname) === normalizedIncoming)
    );

    if (matches.length === 0) return { status: "NOT_FOUND" };
    if (matches.length > 1) return { status: "AMBIGUOUS", players: matches };

    const player = matches[0];
    if (player === undefined) throw new Error("Player resolution lost its sole match.");
    
    return { status: "MATCHED", player };
}