import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Everything else is yours.

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});
