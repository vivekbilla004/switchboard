import {
  startWebhookWorker,
  stopWebhookWorker,
} from "./workers/webhookWorker.js";
import pigeonWebhookRouter from "./routes/pigeonWebhook.js";
import express from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import { getDb, closeDb } from "./db.js";

const app = express();
app.use(
  "/webhooks/pigeon",
  express.raw({ type: "application/json", limit: "1mb" }),
  pigeonWebhookRouter,
);

app.use(express.json());

// Health check
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// HTTP server
const server = createServer(app);

async function startServer(): Promise<void> {
  try {
    // Connect to MongoDB and initialize indexes/workspaces
    await getDb();
    startWebhookWorker();
    server.listen(config.port, () => {
      console.log(`server on http://localhost:${config.port}`);
      console.log("MongoDB connection ready");
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    await closeDb();
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received. Shutting down...`);

  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown error:", error);
    }

    try {
      await closeDb();
      console.log("MongoDB connection closed");
    } finally {
      process.exit(error ? 1 : 0);
    }
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void startServer();
