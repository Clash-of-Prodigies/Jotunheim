import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
    KahootEvent,
    SessionStatusResponse,
} from "../kahoot/kahoot-routes.js";

interface MockParticipant {
    controllerId: string;
    nickname: string;
    occurredAt?: string;
}

interface MockQuestionResult {
    controllerId: string;
    nickname?: string;
    points: number;
    reactionTimeMs?: number;
    isCorrect?: boolean;
    accumulatedPoints?: number;
}

interface MockQuestion {
    questionIndex: number;
    complete?: boolean;
    results: MockQuestionResult[];
}

interface MockInput {
    sessionId: string;
    startedAt: string;
    liveGameId?: string;
    participants: MockParticipant[];
    questions?: MockQuestion[];
    departureControllerId?: string;
}

interface Options {
    baseUrl: string;
    token: string;
    inputPath: string;
}

function parseOptions(argv: string[]): Options {
    let baseUrl = process.env.CLASH_RELAY_URL ?? "http://127.0.0.1:3000";
    let token = process.env.KAHOOT_DEV_TOKEN ?? "";
    let inputPath = process.env.MOCK_KAHOOT_INPUT ?? "";
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = argv[index + 1];
        if (argument === "--base-url" && value !== undefined) baseUrl = value;
        else if (argument === "--token" && value !== undefined) token = value;
        else if (argument === "--input" && value !== undefined) inputPath = value;
        else throw new Error(`Unknown or incomplete argument: ${argument}`);
        index += 1;
    }
    if (token.length === 0) throw new Error("Set KAHOOT_DEV_TOKEN or pass --token.");
    if (inputPath.length === 0) {
        throw new Error("Set MOCK_KAHOOT_INPUT or pass --input with a JSON scenario file.");
    }
    return { baseUrl: baseUrl.replace(/\/$/, ""), token, inputPath: resolve(inputPath) };
}

function parseInput(path: string): MockInput {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MockInput>;
    if (
        typeof value.sessionId !== "string"
        || typeof value.startedAt !== "string"
        || !Array.isArray(value.participants)
        || value.participants.length === 0
    ) {
        throw new Error("Mock input requires sessionId, startedAt, and at least one participant.");
    }
    for (const participant of value.participants) {
        if (
            typeof participant !== "object"
            || participant === null
            || typeof participant.controllerId !== "string"
            || typeof participant.nickname !== "string"
        ) {
            throw new Error("Every mock participant requires controllerId and nickname.");
        }
    }
    if (value.questions !== undefined) {
        if (!Array.isArray(value.questions) || value.liveGameId === undefined) {
            throw new Error("Mock questions require an array and a liveGameId.");
        }
        for (const question of value.questions) {
            if (
                typeof question.questionIndex !== "number"
                || !Number.isInteger(question.questionIndex)
                || question.questionIndex < 0
                || !Array.isArray(question.results)
            ) {
                throw new Error("Every mock question requires a non-negative index and results.");
            }
        }
    }
    return value as MockInput;
}

const options = parseOptions(process.argv.slice(2));
const input = parseInput(options.inputPath);
const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
};

async function sendEvent(event: KahootEvent): Promise<unknown> {
    const response = await fetch(`${options.baseUrl}/api/kahoot/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error(`Event request failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
}

async function getSession(): Promise<SessionStatusResponse> {
    const response = await fetch(
        `${options.baseUrl}/api/kahoot/sessions/${encodeURIComponent(input.sessionId)}`,
        { headers: { authorization: `Bearer ${options.token}` } },
    );
    const body = await response.json() as SessionStatusResponse;
    if (!response.ok) throw new Error(`Session request failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
}

function printState(label: string, state: SessionStatusResponse): void {
    console.log(JSON.stringify({
        event: label,
        status: state.status,
        participants: state.participantCount,
        verified: state.verifiedParticipantCount,
        flagged: state.flaggedIdentities,
        teams: state.detectedTeamIds,
        candidates: state.candidateFixtureIds,
        resolvedFixture: state.confirmedMatchId,
        publicationSafe: state.publicationSafe,
        readyToPublish: state.readyToPublish,
        scoringSafe: state.scoringSafe,
        finalizedQuestions: state.finalizedQuestionCount,
        score: {
            home: state.homeGoals,
            away: state.awayGoals,
        },
    }));
}

const startedEvent: KahootEvent = input.liveGameId === undefined
    ? { type: "SESSION_STARTED", sessionId: input.sessionId, occurredAt: input.startedAt }
    : {
        type: "SESSION_STARTED",
        sessionId: input.sessionId,
        occurredAt: input.startedAt,
        liveGameId: input.liveGameId,
    };
await sendEvent(startedEvent);
printState("SESSION_STARTED", await getSession());

for (const participant of input.participants) {
    await sendEvent({
        type: "PARTICIPANT_JOINED",
        sessionId: input.sessionId,
        controllerId: participant.controllerId,
        nickname: participant.nickname,
        occurredAt: participant.occurredAt ?? input.startedAt,
    });
    printState(`PARTICIPANT_JOINED:${participant.controllerId}`, await getSession());
}

const firstParticipant = input.participants[0];
if (firstParticipant === undefined) throw new Error("Mock scenario lost its first participant.");
const beforeDuplicate = await getSession();
await sendEvent({
    type: "PARTICIPANT_JOINED",
    sessionId: input.sessionId,
    controllerId: firstParticipant.controllerId,
    nickname: firstParticipant.nickname,
    occurredAt: firstParticipant.occurredAt ?? input.startedAt,
});
const afterDuplicate = await getSession();
if (afterDuplicate.participantCount !== beforeDuplicate.participantCount) {
    throw new Error("Duplicate join changed the participant count.");
}
printState("DUPLICATE_JOIN_IDEMPOTENT", afterDuplicate);

for (const question of input.questions ?? []) {
    if (input.liveGameId === undefined) throw new Error("Question scoring lost the live game ID.");
    await sendEvent({
        type: "QUESTION_RESULTS",
        sessionId: input.sessionId,
        liveGameId: input.liveGameId,
        questionIndex: question.questionIndex,
        complete: question.complete ?? true,
        participantSnapshotControllerIds: question.results.map(
            (result) => result.controllerId,
        ),
        results: question.results,
        occurredAt: new Date().toISOString(),
    });
    printState(`QUESTION_RESULTS:${question.questionIndex}`, await getSession());
}

const departureControllerId = input.departureControllerId
    ?? input.participants[input.participants.length - 1]?.controllerId;
if (departureControllerId === undefined) throw new Error("No participant is available to depart.");
await sendEvent({
    type: "PARTICIPANT_LEFT",
    sessionId: input.sessionId,
    controllerId: departureControllerId,
    occurredAt: new Date().toISOString(),
});
printState(`PARTICIPANT_LEFT:${departureControllerId}`, await getSession());

await sendEvent({
    type: "SESSION_ENDED",
    sessionId: input.sessionId,
    occurredAt: new Date().toISOString(),
});
console.log(JSON.stringify({ event: "SESSION_ENDED", sessionId: input.sessionId }));
