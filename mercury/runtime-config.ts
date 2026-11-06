import { readFileSync } from "node:fs";

interface RuntimeConfigFile {
    publish_enabled: boolean;
    replay_logging: boolean;
    rate_limit_ms: number;
    confirmation_timeout_ms: number;
    session_finish_grace_ms: number;
    challenge_place_base_url: string;
    challenge_place_language: string;
    log_directory: string;
}

export interface RuntimeConfig {
    publishEnabled: boolean;
    replayLogging: boolean;
    rateLimitMs: number;
    confirmationTimeoutMs: number;
    sessionFinishGraceMs: number;
    challengePlaceBaseUrl: string;
    challengePlaceLanguage: string;
    logDirectory: string;
}

const CONFIG_KEYS = [
    "publish_enabled",
    "replay_logging",
    "rate_limit_ms",
    "confirmation_timeout_ms",
    "session_finish_grace_ms",
    "challenge_place_base_url",
    "challenge_place_language",
    "log_directory",
] as const;

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must contain a JSON object.`);
    }
    return value as Record<string, unknown>;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
    const value = record[key];
    if (typeof value !== "boolean") throw new Error(`config.json ${key} must be boolean.`);
    return value;
}

function requireMilliseconds(
    record: Record<string, unknown>,
    key: string,
    allowZero: boolean,
): number {
    const value = record[key];
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < (allowZero ? 0 : 1)
    ) {
        const range = allowZero ? "a non-negative integer" : "a positive integer";
        throw new Error(`config.json ${key} must be ${range}.`);
    }
    return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`config.json ${key} must be a non-empty string.`);
    }
    return value.trim();
}

export function loadRuntimeConfig(path: string): RuntimeConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read config.json: ${detail}`);
    }
    const record = requireObject(parsed, "config.json");
    const unknownKeys = Object.keys(record).filter(
        (key) => !(CONFIG_KEYS as readonly string[]).includes(key),
    );
    const missingKeys = CONFIG_KEYS.filter((key) => !(key in record));
    if (unknownKeys.length > 0) {
        throw new Error(`config.json contains unknown settings: ${unknownKeys.join(", ")}.`);
    }
    if (missingKeys.length > 0) {
        throw new Error(`config.json is missing settings: ${missingKeys.join(", ")}.`);
    }

    const file: RuntimeConfigFile = {
        publish_enabled: requireBoolean(record, "publish_enabled"),
        replay_logging: requireBoolean(record, "replay_logging"),
        rate_limit_ms: requireMilliseconds(record, "rate_limit_ms", true),
        confirmation_timeout_ms: requireMilliseconds(
            record,
            "confirmation_timeout_ms",
            false,
        ),
        session_finish_grace_ms: requireMilliseconds(
            record,
            "session_finish_grace_ms",
            true,
        ),
        challenge_place_base_url: requireString(record, "challenge_place_base_url"),
        challenge_place_language: requireString(record, "challenge_place_language"),
        log_directory: requireString(record, "log_directory"),
    };
    const baseUrl = new URL(file.challenge_place_base_url);
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
        throw new Error("config.json challenge_place_base_url must use HTTP or HTTPS.");
    }
    return {
        publishEnabled: file.publish_enabled,
        replayLogging: file.replay_logging,
        rateLimitMs: file.rate_limit_ms,
        confirmationTimeoutMs: file.confirmation_timeout_ms,
        sessionFinishGraceMs: file.session_finish_grace_ms,
        challengePlaceBaseUrl: baseUrl.toString(),
        challengePlaceLanguage: file.challenge_place_language,
        logDirectory: file.log_directory,
    };
}

function unquote(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value.replace(/\s+#.*$/, "").trim();
}

export function loadChallengeLinkCode(path: string): string {
    let content: string;
    try {
        content = readFileSync(path, "utf8");
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read .env: ${detail}`);
    }
    const values = content.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^\s*(?:export\s+)?CLASH_CP_CHALLENGE_LINK_CODE\s*=\s*(.*)$/);
        return match?.[1] === undefined ? [] : [unquote(match[1]).trim()];
    });
    if (values.length > 1) {
        throw new Error(".env contains CLASH_CP_CHALLENGE_LINK_CODE more than once.");
    }
    const value = values[0];
    if (value === undefined || value.length === 0) {
        throw new Error("Set CLASH_CP_CHALLENGE_LINK_CODE in .env before enabling publishing.");
    }
    return value;
}
