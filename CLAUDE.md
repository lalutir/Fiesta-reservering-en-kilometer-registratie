# Fiesta reservering en kilometer registratie

## /implement run log

<!-- implement:run:shared-car-reservation-app:start -->
### Shared car reservation app: PWA for Android/iOS + web admin dashboard on a low-cost VPS (shared-car-reservation-app)

Date 2026-11-16. Branch `implement/shared-car-reservation-app`. Base branch `main`, base commit `26247fb05d92da965130dc834073d2796a925d4a`.

### Request

> I want to create an application for the shared car we have at home. The problem is that we currently don't know who is using the car when, so I want to build a reservation app. It should be able to to view back reservation for 6 months back (and who actually drove the vehicle between specific times) and look forward 6 months, everything older should be deleted from the database. I want the application to be both Android and IOS since we use both devices in the house, I want a web admin dashboard. The application does not need to be in the Appstore or Playstore. There needs to be a login for each user, the user can only create there own reservations or suggestions for reservations for others (which the other needs to approve). I want the application and database running on a DigitalOcean Droplet (or something else if that would be better, I want to minimize costs as much as possible).

### What was built

A private reservation system for one shared car: a Node 22 TypeScript server with no runtime dependencies, an installable vanilla-JS PWA for members, an admin page at `/admin/`, and a Docker Compose + Caddy deployment with a step-by-step guide. Members book for themselves (confirmed at once, no overlaps) or suggest a slot to someone else, who approves or declines. A separate drive log records who actually drove. Data is limited to 6 months back and forward, and a daily job deletes older rows. Nothing is committed: git shows 1 modified file (`README.md`, +104/-1) and 70 untracked files (69 project files plus this `CLAUDE.md`).

### Why this approach

- Chosen: minimal monolith (`node:http`, `node:sqlite`, vanilla-JS PWA, Docker Compose, Caddy). It has the lowest install, upgrade and 512 MB-droplet risk (mean score 7.7).
- Rejected: Fastify + better-sqlite3 + Vite/React PWA. A native addon, a frontend build and many dependencies for a 2-10 user app.
- Rejected: invariants enforced by DB triggers/constraints. It duplicates rules between SQL and code; one service-layer check inside `BEGIN IMMEDIATE` is simpler for a single process.
- PWA instead of native apps: iOS sideloading needs a paid Apple account or weekly re-signing, which conflicts with minimal cost and no store.

### How it works

Start with `README.md` (layout, scripts), then `src/app.ts`, then `docs/DEPLOYMENT.md`.

- Flow: browser (PWA or `/admin/`) -> Caddy (automatic HTTPS) -> `src/app.ts` (security headers, CSRF check, session auth, router) -> `users.ts`, `reservations.ts`, `usage.ts`, `retention.ts` -> `src/db.ts` (the only `node:sqlite` user) -> SQLite file in WAL mode on a volume.
- Overlap checks run inside `BEGIN IMMEDIATE` in a single app process. Pending suggestions do not block a slot; approving re-checks overlap.
- Times are stored in UTC; `shared/time.js` does time zone, DST and calendar-month maths for server and browser (default `Europe/Amsterdam`).
- `src/maintenance.ts` purges at start-up and daily, writes a daily backup (`VACUUM INTO`) with rotation, and re-checks every 30 minutes. `src/cli.ts` offers `create-admin`, `reset-password`, `backup`, `restore`, `purge`.
- Client strings are centralised in `public/strings.js`; `public/sw.js` is the service worker.

### Files

| Path | Change | Purpose |
| --- | --- | --- |
| `README.md` | modified | Overview, design decisions, dev quick start, scripts, layout, known limits |
| `package.json`, `package-lock.json`, `tsconfig*.json` (3), `eslint.config.mjs` | added | Scripts, strict TS for server and browser (`checkJs`), lint |
| `src/*.ts` (14 files) | added | Server: app, auth, users, reservations, usage, retention, maintenance, db, http, static, validate, config, cli, server |
| `shared/time.js` | added | Time zone and calendar-month helpers used by server and browser |
| `public/` (21 files) | added | PWA (index, app, api, dom, strings, style, manifest, sw), `views/` (7), `admin/` (2), `icons/` (4) |
| `test/` (18 files) | added | 17 test files plus `helpers.ts` |
| `scripts/make-icons.mjs`, `scripts/smoke.mjs` | added | Icon generator; built-output smoke test |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.dockerignore`, `.env.example`, `.gitignore` | added | Container and config setup |
| `docs/DEPLOYMENT.md` | added | Droplet setup, DNS, first admin, backups, updates, cost estimate, Hetzner alternative |
| `CLAUDE.md` | added | This run log |

### How to run and test

All commands were run on Windows with Node 22.23.1 and exited 0 (last test stage; the build stage also ran `npm ci` first).

- `npm run typecheck`: server and client (`checkJs`) clean.
- `npm run lint`: no findings.
- `npm test`: 192 tests, 192 pass, 0 fail, 0 skipped.
- `npm run build`: passes.
- `npm run smoke`: built server on a free port, 8 of 8 HTTP checks pass.
- `npm run check` runs all of the above. `npm run dev` starts the dev server (needs `.env`, see README).

### Specialist passes

| Concern | Skill used | Built-in rubric instead | Effect |
| --- | --- | --- | --- |
| UI and UX | frontend-design, a11y-audit | No | Fixed admin generated password never shown; contrast failures; aria wiring; focus handling; Decline confirm. Headless Chromium 28/28 at 390 and 320 px |
| Backend | engineering-skills:senior-backend | No | Fixed login rate limit bypass by parallel requests; added `X-Request-Id`, audit log lines. Tests 134 -> 140 |
| Data | engineering-advanced-skills:database-designer | No | Fixed migration race and file-handle leak; timestamp CHECKs, AUTOINCREMENT; `test/db.test.ts`. Tests 150 |
| DevOps | docker-development | No | Pinned Node 22.23 and Caddy 2.11, log rotation, emptied placeholder `ADMIN_PASSWORD`, deployment guide updates |
| Security | engineering-skills:senior-security | Yes | Login throttle per IPv6 /64; warn on leftover `ADMIN_PASSWORD`; `sshd -T` check in guide. Tests 153; 0 runtime vulnerabilities in `npm audit` |
| Simplicity | simplify | No | Single inline pass (Agent tool unavailable); removed duplication and dead code, no behaviour change |

### Verification

Verified (ran and saw pass): the five commands above; built-output smoke over real HTTP; working tree unchanged by the test run.

NOT verified:
- Docker build, `docker compose up`, Caddy HTTPS, the `sshd -T` line (Docker is not installed; compose YAML only syntax-checked with a parser).
- Install and Add to Home Screen on real Android Chrome or iOS Safari, offline start-up, and screen reader use.
- DigitalOcean and Hetzner prices (from memory), deployment to a real droplet, login hash timing on a 512 MB shared vCPU.
- The review fix in `public/views/usage.js` has no automated test (no DOM harness); only a throw-away Chromium script checked it.
- `node:sqlite` is experimental and was tested only on Node 22.23.1; a real two-process migration race was only simulated.

Test confidence: high per the test stage (automated checks above); that rating does not cover the items listed as not verified.

### Review

Two rounds, three lenses each (correctness, maintainability, risk). Round 1: 19 findings, 1 confirmed major (F1: editing or logging a drive dropped the reservation link for older reservations), fixed in `public/views/usage.js`. Round 2: 17 findings, 0 confirmed.

Remaining minor notes (not fixed): admin cannot save an edit of a deactivated user's drive from the member app; no upper bound on reservation end or duration; reserved-versus-actual history only for explicitly linked drives; `restoreBackup` does not check that the app is stopped; dead `PUBLIC_DIR`/`SHARED_DIR` env reads and undocumented env vars; docs gaps (`npm start`, "cheaper" Hetzner claim, no API reference); service worker does not fall back to cache on 502/503/504; edit forms shift the second occurrence of the repeated autumn hour; maintainability items (long `usage.js` render, repeated form-error code, backup code split across two files, hand-rolled CLI parsing).

### Assumptions and open questions

Defaults taken (none scope-changing; no one was asked):
- Exactly one car, 2-10 users, roles admin and member only; admins follow the same creation rules and can edit, cancel and correct anything.
- PWA over native; English UI with strings centralised for a later Dutch translation; no Web Push (in-app Inbox and badge only).
- Odometer km is optional on drive records, with per-person totals only; no wider kilometre registration.
- The app is served at `https://fiesta-reserveringen.lalutir.com`. `lalutir.com` is owned by the user and its DNS is in Cloudflare; the record must be **DNS only** (grey cloud), because login rate limiting reads the client address Caddy appends to `X-Forwarded-For` (see `docs/DEPLOYMENT.md` section 6). HTTPS is required for PWA install. (Originally the default was "owner supplies a domain; DuckDNS works"; changed on 2026-11-17.)
- Backups stay on the droplet; off-site copy is documented, not automated. DigitalOcean stays the default host; Hetzner is documented as cheaper.
- Open questions answered by default: PWA vs native, domain, kilometre registration, admin creating on behalf of others, UI language, push notifications, provider.

### Honesty flags

- Restarts: 1 (the ledger does not name the stage). Degraded stages: none recorded.
- Security specialist used the built-in rubric because no matching skill was installed.
- Simplify specialist ran as one inline pass, not the 4-agent fan-out.
- The test agent reported a pass although one command exited non-zero (mutation checks on new tests, temporary edits, restored and byte-compared with `cmp`).
- Ledger and git disagree on tests: the ledger's `tests_added` is empty, but git has `test/cli.test.ts`, `config.test.ts`, `deploy.test.ts`, `validate.test.ts` that no ledger list names, and the count rose from 153 to 192. Git is trusted; which stage added them is not recorded.
- `01-analysis.md` was not written (write refused outside a worktree). The audit directory has no `01-` to `05-` files; the ledger holds that content.
- Docker, Caddy, real-phone and cost checks were not run (see Verification).

### Reproduce

- Invocation: `/implement` with the Request text above, flags `gate_plan=false`, `stop_before_ship=false`, `claude_md=true`, `specialists=auto`. Skill `implement` 1.0.0.
- Limits: totalRestarts 6, build 3, debug 3, review 3, test 3, planRounds 3.
- Models: inherit for analyse, propose, plan, judge, build, specialist, test, debug, review, verify; `sonnet` for docs and git.
- Audit directory: `.claude/runs/shared-car-reservation-app` (excluded from git via `.git/info/exclude`). Base commit `26247fb05d92da965130dc834073d2796a925d4a`.
<!-- implement:run:shared-car-reservation-app:end -->
