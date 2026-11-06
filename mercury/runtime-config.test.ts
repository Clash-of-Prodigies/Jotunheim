import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadChallengeLinkCode, loadRuntimeConfig } from "./runtime-config.js";

function validConfig(): Record<string, unknown> {
    return {
        publish_enabled: false,
        replay_logging: true,
        rate_limit_ms: 1_000,
        confirmation_timeout_ms: 10_000,
        session_finish_grace_ms: 10_000,
        challenge_place_base_url: "https://api.challengeplace.com",
        challenge_place_language: "en-us",
        log_directory: ".local/test",
    };
}

test("loads and maps every config.json setting", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-config-test-"));
    try {
        const path = join(directory, "config.json");
        writeFileSync(path, JSON.stringify(validConfig()), "utf8");
        assert.deepEqual(loadRuntimeConfig(path), {
            publishEnabled: false,
            replayLogging: true,
            rateLimitMs: 1_000,
            confirmationTimeoutMs: 10_000,
            sessionFinishGraceMs: 10_000,
            challengePlaceBaseUrl: "https://api.challengeplace.com/",
            challengePlaceLanguage: "en-us",
            logDirectory: ".local/test",
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("rejects unknown, missing, and invalid config settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-config-test-"));
    try {
        const path = join(directory, "config.json");
        writeFileSync(path, JSON.stringify({ ...validConfig(), surprise: true }), "utf8");
        assert.throws(() => loadRuntimeConfig(path), /unknown settings: surprise/);

        const missing = validConfig();
        delete missing.replay_logging;
        writeFileSync(path, JSON.stringify(missing), "utf8");
        assert.throws(() => loadRuntimeConfig(path), /missing settings: replay_logging/);

        writeFileSync(path, JSON.stringify({
            ...validConfig(), confirmation_timeout_ms: 0,
        }), "utf8");
        assert.throws(() => loadRuntimeConfig(path), /confirmation_timeout_ms must be a positive/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("loads the challenge link code only from the requested env file", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-env-test-"));
    try {
        const path = join(directory, ".env");
        writeFileSync(path, [
            "IGNORED=value",
            "CLASH_CP_CHALLENGE_LINK_CODE='authorized-link-code'",
            "",
        ].join("\n"), "utf8");
        assert.equal(loadChallengeLinkCode(path), "authorized-link-code");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("rejects missing, blank, or duplicate challenge link codes", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-env-test-"));
    try {
        const path = join(directory, ".env");
        assert.throws(() => loadChallengeLinkCode(path), /Unable to read \.env/);

        writeFileSync(path, "CLASH_CP_CHALLENGE_LINK_CODE=\n", "utf8");
        assert.throws(() => loadChallengeLinkCode(path), /Set CLASH_CP_CHALLENGE_LINK_CODE/);

        writeFileSync(path, [
            "CLASH_CP_CHALLENGE_LINK_CODE=one",
            "CLASH_CP_CHALLENGE_LINK_CODE=two",
        ].join("\n"), "utf8");
        assert.throws(() => loadChallengeLinkCode(path), /more than once/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
