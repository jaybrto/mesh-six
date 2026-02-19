import { createApp } from "./app.js";

const AGENT_ID = process.env.AGENT_ID || "context-service";
const APP_PORT = process.env.APP_PORT || "3000";

const app = createApp(AGENT_ID);

Bun.serve({ port: Number(APP_PORT), fetch: app.fetch });
console.log(`[${AGENT_ID}] Listening on port ${APP_PORT}`);
