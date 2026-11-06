import { join, resolve } from "node:path";
import { ChallengePlaceWriter } from "./challenge-place/challenge-place-writer.js";
import { SocketIoChallengePlaceTransport } from "./challenge-place/challenge-place-transport.js";
import { ExceptionReporter } from "./challenge-place/exception-reporter.js";
import { ReplayLogger } from "./replay/replay-logger.js";
import { buildApp } from "./app.js";
import { db } from "./db/database.js";
import { loadChallengeLinkCode, loadRuntimeConfig } from "./runtime-config.js";
import { promptForChallengePlaceTokenId } from "./secure-prompt.js";

const developmentToken = process.env.KAHOOT_DEV_TOKEN;
if (developmentToken === undefined || developmentToken.length === 0) {
    db.close();
    throw new Error("KAHOOT_DEV_TOKEN must be set before starting Clash Relay.");
}

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeConfig = loadRuntimeConfig(join(projectRoot, "config.json"));
const logRoot = resolve(projectRoot, runtimeConfig.logDirectory);
const exceptionReporter = new ExceptionReporter({ rootDirectory: logRoot });
const recoveredIntents = exceptionReporter.recoverSubmissionIntents();
for (const recovered of recoveredIntents) {
    console.error(
        `[CP] RECOVERED ${recovered.status} submission intent for match ${recovered.matchId}, question ${recovered.questionIndex + 1}. Administrative review required.`,
    );
}

let transport: SocketIoChallengePlaceTransport | null = null;
if (runtimeConfig.publishEnabled) {
    const challengeLinkCode = loadChallengeLinkCode(join(projectRoot, ".env"));
    const tokenId = await promptForChallengePlaceTokenId();
    transport = new SocketIoChallengePlaceTransport({
        baseUrl: runtimeConfig.challengePlaceBaseUrl,
        tokenId,
        challengeLinkCode,
        language: runtimeConfig.challengePlaceLanguage,
    });
}
const challengePlaceWriter = new ChallengePlaceWriter({
    enabled: runtimeConfig.publishEnabled,
    transport,
    exceptionReporter,
    rateLimitMs: runtimeConfig.rateLimitMs,
    confirmationTimeoutMs: runtimeConfig.confirmationTimeoutMs,
    sessionFinishGraceMs: runtimeConfig.sessionFinishGraceMs,
});
const replayLogger = new ReplayLogger({
    enabled: runtimeConfig.replayLogging,
    rootDirectory: join(logRoot, "replays"),
});

const app = buildApp({
    database: db,
    developmentToken,
    logger: true,
    closeDatabaseOnClose: true,
    challengePlaceWriter,
    replayLogger,
});
const port = Number(process.env.PORT ?? 3000);

try {
    await app.ready();
    challengePlaceWriter.start();
    await app.listen({ port, host: "127.0.0.1" });
} catch (error: unknown) {
    app.log.error(error);
    await app.close();
    process.exitCode = 1;
}