import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import type { ChallengePlaceWriter } from "./challenge-place/challenge-place-writer.js";
import { registerKahootRoutes } from "./kahoot/kahoot-routes.js";
import type { ReplayLogger } from "./replay/replay-logger.js";
import { SessionManager } from "./sessions/session-manager.js";

export interface BuildAppOptions {
    database: Database.Database;
    developmentToken: string;
    sessionManager?: SessionManager;
    challengePlaceWriter?: ChallengePlaceWriter;
    replayLogger?: ReplayLogger;
    logger?: boolean;
    closeDatabaseOnClose?: boolean;
}

interface HealthResponse {
    status: "ok";
    service: string;
    database: "ready";
    schemaVersion: number;
    timestamp: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
    const app = Fastify({ logger: options.logger ?? false });
    const sessionManager = options.sessionManager ?? new SessionManager();

    app.get<{ Reply: HealthResponse }>("/health", async () => {
        options.database.prepare("SELECT 1").get();
        return {
            status: "ok",
            service: "mercury",
            database: "ready",
            schemaVersion: Number(options.database.pragma("user_version", { simple: true })),
            timestamp: new Date().toISOString(),
        };
    });

    app.register(registerKahootRoutes, {
        database: options.database,
        sessionManager,
        developmentToken: options.developmentToken,
        ...(options.challengePlaceWriter === undefined
            ? {}
            : { challengePlaceWriter: options.challengePlaceWriter }),
        ...(options.replayLogger === undefined
            ? {}
            : { replayLogger: options.replayLogger }),
    });

    if (options.closeDatabaseOnClose === true) {
        app.addHook("onClose", async () => { options.database.close(); });
    }
    if (options.challengePlaceWriter !== undefined) {
        app.addHook("onClose", async () => { options.challengePlaceWriter?.close(); });
    }
    return app;
}
