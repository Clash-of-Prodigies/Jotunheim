import Fastify from "fastify";
import { db, schemaVersion } from "@mercury/db/database.js";

interface HealthResponse { 
    status: "ok"; service: string; database: "ready"; schemaVersion: number; timestamp: string;
}

const app = Fastify({ logger: true });

app.get<{ Reply: HealthResponse }>("/health",
    async () => {
        db.prepare("SELECT 1").get();
        const time = new Date().toISOString();
        return {
            status: "ok", service: "mercury", database: "ready", schemaVersion, timestamp: time,
        };
    }
);

app.addHook("onClose", async () => { db.close(); });

const PORT: number = Number(process.env.PORT ?? 3000);

try {
    await app.listen({ port: PORT, host: "127.0.0.1" });
} catch (error: unknown) {
    app.log.error(error);
    process.exit(1);
}