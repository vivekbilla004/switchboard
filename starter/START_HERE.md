# Start here

One build round, two hours, in your own repository. Read in this order.

| # | File | Why | Minutes |
| --- | --- | --- | --- |
| 1 | `START_HERE.md` | This page: set-up and the order of work. | 2 |
| 2 | `BRIEF.md` | What to build, how it is checked and scored. | 5 |
| 3 | `PIGEON.md` | The messaging provider and the ways it misbehaves. Read before writing the webhook. | 3 |
| 4 | `SUBMISSION.md` | The last ten minutes, step by step. Open it at 1:50, not before. | – |
| – | `REFERENCE.pdf` | Look things up: every endpoint, test user and rule of the simulators. Do not read it front to back. | – |
| – | `PAYBOX.md`, `BONUS_BILLING.md` | Only if you reach the bonus. | – |

## Set up (once)

```
git init && git add -A && git commit -m "starter"     # this folder becomes your repository
npm run up                 # MongoDB, Redis and the simulators, in Docker
npm run doctor             # checks every port and says what to fix
npm run scaffold:install   # only if you use the scaffold
```

Create an empty repository on GitHub under your own account and push to it.
Keep it **private while you work**; you make it public at the end
(`SUBMISSION.md`).

No Docker? `npm run mocks` starts the simulators with plain Node. Point
`MONGO_URL` and `REDIS_URL` at a MongoDB and Redis you have.

## While you work

```
npm run scaffold:server    # your server on http://localhost:4000
npm run scaffold:web       # your React app on http://localhost:5173
npm run inbound            # make a customer write to you now
npm run quiet              # stop the automatic trickle of customer messages
npm run report             # what Pigeon saw of you
npm run check              # level 1 of the real check (stop your server first)
npm run check:full         # levels 1, 2, 3 and 5 (about 4 minutes); writes CHECK_REPORT.json
npm run check -- --levels 5   # one level on its own
npm run drizzle            # the check stops the trickle of customer messages; this restarts it
```

Things people get wrong:

- **"Agent" means a human support agent** who works at the business, not an AI
  agent. Nothing in this task asks you to build a bot.
- **`npm run check` deletes your application data** and starts your server
  itself. Stop your dev server before running it.
- **The check starts your server on a port it chooses** (`PORT`). A server
  that only works on 4000 scores nothing.
- **Order of work.** Get one webhook stored and one reply sent, run
  `npm run check`, then build outwards. Do not leave the check to the end.

## Test users (mock IdP)

There are no passwords: the IdP's login page lists the users and you click one.

| User | `sub` | Workspaces |
| --- | --- | --- |
| Asha Rao, `asha@acme.test` | `u_asha` | ws_acme (admin) |
| Ben Ortiz, `ben@acme.test` | `u_ben` | ws_acme (agent) |
| Chloe Martin, `chloe@globex.test` | `u_chloe` | ws_globex (admin) |
| Dev Patel, `dev@globex.test` | `u_dev` | ws_globex (agent) |
| Eli Novak, `eli@contractor.test` | `u_eli` | ws_acme (agent), ws_globex (agent) |
