# Optional scaffold

An empty shell so you do not spend your first ten minutes on wiring. It has no
product code and no opinions about your design. Delete it if you prefer your
own stack.

```
npm run scaffold:install     # from the starter root, once
npm run scaffold:server      # Express + TypeScript on http://localhost:4000
npm run scaffold:web         # Vite + React on http://localhost:5173
```

- `server/src/config.ts` reads every setting from the environment, with the
  harness defaults, so it runs without a `.env` file.
- `server/src/db.ts` and `server/src/redis.ts` connect on first use.
- `web/vite.config.ts` proxies `/api`, `/auth`, `/healthz` and `/ws` to the
  server, so the browser talks to one origin.

Everything else is yours: routes, models, sockets, auth, structure, tests.
