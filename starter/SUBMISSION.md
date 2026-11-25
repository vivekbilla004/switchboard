# Submitting (1:50 to 2:00)

Everything we assess is in your repository. Nothing is uploaded or emailed.

## At 1:50, stop building

1. **Run the full check** and keep its report (about 4 minutes; stop your dev
   server first):

   ```
   npm run check:full
   ```

   It writes `CHECK_REPORT.json`. Commit it whatever the score is. If you are
   out of time, run `npm run check` instead and say so in `DECISIONS.md`.

2. **Export your AI transcripts** into `ai-logs/`, one file per session, as
   your tool exports them (Markdown, text or JSON). Do not edit them.

3. **Check the list.** The repository root has: `README.md`, `DECISIONS.md`,
   `switchboard.json`, `CHECK_REPORT.json`, `ai-logs/`, and `PROTOCOL.md` if
   you built encrypted notes. No `.env`, no `node_modules`.

4. **Commit and push.**

   ```
   git add -A && git commit -m "final" && git push
   git rev-parse HEAD        # copy this 40-character id
   ```

5. **Make the repository public.** On GitHub: Settings, General, Danger Zone,
   Change visibility, Public. Open the repository URL in a private browser
   window to confirm it loads without logging in.

6. **Send the form** (link in the session email) before 2:00:
   - your full name and the email you applied with
   - the repository URL, like `https://github.com/you/switchboard`
   - the commit id from step 4
   - the AI tools you used
   - (optional) anything that went wrong on your machine

## Rules

- We grade **the commit id in your form**, and we copy every repository the
  minute the form closes. A commit pushed after that is not seen.
- One form per person. If you send it twice, the last one before 2:00 counts.
- Keep the repository public and unchanged for 14 days. You may delete it
  after you hear from us.
- We start your server from a clean clone with the `install` and `start`
  commands in `switchboard.json`, on Node 22, with the services in
  `docker-compose.yml`. If it needs anything else, it will not start.
- The work must be yours. Repositories are compared with each other.
