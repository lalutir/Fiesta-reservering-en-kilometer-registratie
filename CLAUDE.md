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

<!-- implement:run:km-registration-fuel-split-notifications:start -->
### Mandatory km registration with drafts, fuel cost split with payment requests, recommended notes and start/end push reminders (km-registration-fuel-split-notifications)

Date 2026-11-17. Branch `implement/km-registration-fuel-split-notifications`. Base branch `main`, base commit `3489e2a55c1caa631c1957d44f15391a18c2418c`.

### Request

> I have one slight issue in the current version where it seems that reservations cannot be tied to a registered drive. I also want to add a new feature to do with kilometer registration, I want it obliged for each ride that the kilometers are registered to that person. I want to add a new option as well to say who has fueled the car up and when, then add the price of gas at that moment and calculate each's share of the gas. If possible with an API call to Tikkie to automatically create the money request so it can be texted to the other person. I also want notes to be recommended fields on both the reservation as the registration. Lastly, I want the app to send a notification if you have an upcoming reservation (and ending) to not forget the km registration, which should also be saveable as a draft so you can already enter the starting KM and then enter the finishing KM when finishing the drive.

### What was built

Registering km now starts from the reservation card, opens pre-linked and prefilled, and every reservation shows its drive and km state; the reported "cannot be tied to a drive" problem was reproduced in headless Chromium first (upcoming reservations were not selectable, the link was manual and optional, the card never showed the drive). A completed drive needs both odometer readings; a draft holds only the start reading and is finished later; ended reservations without a completed registration are listed for the driver and the admin. Fuel fill-ups are split by km driven per person, with a manual payment-request message by default and an optional, off-by-default, unverified Tikkie adapter. Notes are labelled recommended, and Web Push reminders (`node:crypto` and `fetch`, no new dependency) go out 30 minutes before the start, at the end and once more 60 minutes later. Nothing is committed: git shows 34 modified and 20 untracked files; `package.json`, the lockfile, `Dockerfile`, compose and `Caddyfile` are unchanged.

### Why this approach

- Chosen: minimal plan, additive migration v2, a draft is a usage row with a placeholder end, live fuel shares, dependency-free Web Push (mean score 7.7). It meets every acceptance criterion with the fewest new concepts and keeps zero runtime dependencies and six tabs.
- Rejected: idiomatic plan. Largest UI change (Account into the top bar, Fuel as a tab, 320 px fit risk), no push host allow-list, a nudge that swallows the first submit.
- Rejected: robust plan. About 25 new files and a `usage.js` split, unrequested auto-link, and it overrides the equal-split rule for empty periods.
- Rejected: Fastify + better-sqlite3 + `web-push` package. Native and runtime dependencies and a changed Docker runtime stage for a 2-10 user app.
- Rejected: grandfather meta row for legacy reservations. Couples tests to the real clock for a 14-day first-deploy effect.

### How it works

Start with `src/reservations.ts` (`REGISTERED_SQL`, the shared SELECT with `drive` and km state), then `src/usage.ts` (`shapeErrors`, drafts, pending), `src/fuel.ts`, `src/reminders.ts`, `public/views/agenda.js` (`kmAction`) and `public/views/usage.js`.

- Km: drafts are `usage` rows with a status column and one open draft per driver; finishing goes through the same overlap, window and ordering checks as a new drive. Distance counts for the driver, drafts are excluded.
- Fuel: `src/fuel.ts` splits each fill-up by km of counted drives since the previous fill-up, largest remainder so shares sum to the total; an empty period is split equally among active users and flagged. `src/payments.ts` is the provider seam (manual by default, Tikkie only when configured).
- Push: `src/webpush.ts` (VAPID and RFC 8291 crypto) and `src/push.ts` (endpoint allow-list, subscription routes, sender, 404/410 pruning); `src/reminders.ts` ticks every minute, once per reservation, kind and time, also across restarts, and skips stale moments after downtime. `public/sw.js` handles `push` and `notificationclick` and deep-links to the registration form.
- Persistence: migration v2 is additive, with a `backups/pre-migrate-v1.db` copy before it; purge, retention counts, admin page and backups include fuel, payment and push data. New env vars (`PUSH_*`, `TIKKIE_*`) are read in `src/config.ts`, listed in `.env.example` and `docs/DEPLOYMENT.md`.

### Files

34 modified tracked files (+2801/-283 against `main` before this entry) and 20 untracked.

| Path | Change | Purpose |
| --- | --- | --- |
| `src/fuel.ts`, `payments.ts`, `push.ts`, `webpush.ts`, `reminders.ts` | added | Fuel and shares, payment providers, push routes and sender, push crypto, reminder scheduler |
| `public/views/fuel.js` | added | Fuel and costs view |
| `src/db.ts`, `usage.ts`, `reservations.ts`, `retention.ts`, `app.ts`, `http.ts`, `config.ts`, `server.ts`, `cli.ts`, `users.ts` | modified (10) | Migration v2, drafts and pending, drive and km state, purge counts, new settings, reminder timer |
| `public/views/` (usage, agenda, history, reserve, account), `app.js`, `api.js`, `dom.js`, `strings.js`, `sw.js`, `style.css`, `admin/admin.js` | modified (12) | Km flow, draft form, banner, notes, reminders card, push handlers, admin pending list |
| `test/km`, `fuel`, `payments`, `webpush`, `push`, `reminders`, `client` `.test.ts` | added (7) | Ledger-named: link regression, obligation, drafts, shares, providers, RFC vectors, scheduler, client helpers |
| `test/admin`, `admin-guard`, `forms`, `notes`, `strings` `.test.ts`, `fake-dom.ts`, `webpush-peer.ts` | added (7) | Git-only (no ledger list names them): admin page, forms, notes, error strings, fake DOM and push peer helpers |
| `test/helpers`, `usage`, `retention`, `db`, `maintenance`, `config`, `pwa` | modified (7) | Helpers, odometer-optional assertions rewritten, upgrade and restore, push handlers |
| `.env.example`, `README.md`, `docs/DEPLOYMENT.md`, `scripts/smoke.mjs`, `CLAUDE.md` | modified (5) | New settings and guide sections, smoke checks, this log |

### How to run and test

Last test stage, Windows, Node 22.23.1, all exit 0: `npm run typecheck` (server and client checkJs clean), `npm run lint` (no findings), `npm test` (364 of 364 pass, baseline 192), `npm run build` (clean), `npm run smoke` (11 of 11 over real HTTP). `npm run check` runs all five. Test count by stage: 305 after build, 307 backend, 308 data, 363 before the round 2 fix, 364 after. Also run: 15 mutation checks on the new rules in the build stage (all killed, files restored), a clean-room boot of the Dockerfile file layout on a schema v1 data directory (22 checks) in the devops pass.

### Specialist passes

| Concern | Skill used | Built-in rubric instead | Effect |
| --- | --- | --- | --- |
| UI and UX | frontend-design | No | Hint/error text split, focus on first invalid field, Fuel entry beside the Drives title, busy states, focus handling, banner as region; 29 Chromium checks at 390/320 px |
| Backend | engineering-skills:senior-backend | No | Mark-paid made idempotent, Tikkie failure cancels the response body, unreachable reminder logged; tests 305 to 307 |
| Data | engineering-advanced-skills:database-designer | No | Rollback test for migration v2 (308), backup note corrected: backups hold the push key and subscriptions |
| DevOps | docker-development | No | Warning when push is on without an https address, smoke check 11, rollback note; infra files unchanged |
| Security | security-review | No | No finding at confidence 8 or higher, no source change; filtering done inline (no parallel sub-tasks) |
| Simplicity | simplify | No | Single inline pass (Agent tool unavailable): merged duplicated queries and helpers, test-only crypto moved to `test/webpush-peer.ts` |

### Verification

Verified (ran and saw pass): the five commands above; headless Chromium at 390 and 320 px (build: 70 checks, no overflow, no console errors; UI/UX: 29 checks); RFC 8291 Appendix A against a stub peer; RFC 8292 example token verifying with the RFC key; EXPLAIN QUERY PLAN shows indexed new queries; v1 to v2 upgrade on synthetic files.

NOT verified:
- Real push delivery (Google, Apple, Mozilla), real phones, installed PWAs, service worker in a real browser, screen readers, light theme, the push enable/disable path in a browser.
- Tikkie beyond a local stub (its API targets business customers; off by default).
- Docker build, `docker compose up`, Caddy HTTPS, a real droplet deploy, SIGTERM shutdown on Windows.
- First deploy on the live database, the full-disk case of the pre-migration copy, a real two-process migration race; `node:sqlite` only on Node 22.23.1.
- The browser pass was not repeated after the specialist and fix changes; the DOM wiring edits of the simplify pass rely on typecheck, lint and the Node fake-DOM tests.

Test confidence: high for what the automated commands cover; it does not cover the items above.

### Review

Three rounds, three lenses each (correctness, maintainability, risk). Round 1: 20 findings, 2 confirmed majors: reminders shared one notification tag without renotify (`public/sw.js`), and requested or paid fuel shares diverged or vanished after a drive edit or delete (`src/fuel.ts`). Round 2: 17 findings, 1 confirmed major: any open draft suppressed the start reminder and mislabelled the end reminder (`src/reminders.ts`). Round 3: 19 findings, 0 confirmed. The majors were fixed and not reported again in the next round.

Remaining minor notes (not fixed): an open draft takes over an unrelated preset reservation and links to it on finish (`usage.js`); a daily purge drops an unpaid requested fuel debt from balances; the km obligation can be met or removed by someone other than the driver; the billed-drive rule and `shapeErrors` calls are duplicated; `COUNTED_SQL` not reused; duplicated `act` helper and client/server constants with no tying test; fuel lock for drafts and period boundary, permanent 4xx from a push service and the tick overlap guard are untested (round 1 also listed four surviving mutants); a bare `PATCH {end, odometerEnd}` on a draft returns 422 `must_be_empty`; Enable reminders reuses a subscription made with a stale VAPID key; README omits the billed-drive lock; Tikkie redirect and timeout settings not pinned; shared `.tmp` name for the pre-migration copy; dead exports and a duplicate constant.

### Assumptions and open questions

Defaults taken (none scope-changing; no one was asked):
- Obliged km is hard validation on completed drives plus banners and reminders; new reservations are never blocked while km are missing.
- Fuel price is entered by hand (EUR, integer cents, millilitres); the split runs per fill-up over the km since the previous one; empty period split equally among active users and flagged.
- Payment requests are a manual message by default; Tikkie is optional, env-gated and unverified.
- Reminders at 30 minutes before the start, at the end and 60 minutes later, tick every minute; iOS gets push only as an installed PWA on 16.4 or later, others rely on the in-app banner.
- Fuel and payment records follow the 6-month retention, so an unpaid request older than the window is deleted; legacy drives without readings are kept and shown as km missing; UI stays English with strings in `public/strings.js`.
- Open questions answered by default: block new reservations while km are missing, Tikkie for Business access, empty-period split, per fill-up or per month, reminder times, retention of unpaid requests, what exactly failed when linking.

### Honesty flags

- Restarts: 2 (the ledger does not name the stages). Degraded stages: none. Caveats: none. Debug attempts: 0. The test stage ran 3 times.
- Ledger and git disagree on tests: the ledger's `tests_added` for the test stage is empty, but git has `admin`, `admin-guard`, `forms`, `notes` and `strings` tests plus `fake-dom.ts` and `webpush-peer.ts` that no ledger list names, and the count rose from 308 to 364. Git is trusted; which stage added them is not recorded.
- The build worked on top of an earlier build pass already in the tree. Regression tests were written together with the code, not run red against the untouched tree first; mutation checks stand in.
- An unmarked section, `## /implement run log: km registration, fuel split, notes and reminders`, written by the build stage, remains below this entry. It was left untouched under the CLAUDE.md rules and is stale (305 tests, 10 smoke checks, no specialist or review results); this entry supersedes it.
- Security and simplify specialists ran inline, not as parallel fan-outs. RFC 8292 is a known-answer test only on the verifying side; our own signatures are checked for shape and verification.
- Unrequested extras kept: a test notification button, unsubscribe on sign-out, mark unpaid; plus an unplanned one-line CSS fix (`.table-wrap { position: relative }`).
- Real push, Tikkie, Docker, Caddy, phones and the live database were not exercised (see Verification).

### Reproduce

- Invocation: `/implement` with the Request text above as the argument, flags `gate_plan=false`, `stop_before_ship=false`, `claude_md=true`, `specialists=auto`. Skill `implement` 1.0.0.
- Limits: totalRestarts 6, build 3, debug 3, review 3, test 3, planRounds 3.
- Models: inherit for analyse, propose, plan, judge, build, specialist, test, debug, review, verify; `sonnet` for docs and git.
- Audit directory: `.claude/runs/km-registration-fuel-split-notifications` (git-excluded). Base commit `3489e2a55c1caa631c1957d44f15391a18c2418c`.
<!-- implement:run:km-registration-fuel-split-notifications:end -->

## /implement run log: km registration, fuel split, notes and reminders

### Mandatory km registration with drafts, fuel cost split with payment requests, recommended notes and start/end push reminders (km-registration-fuel-split-notifications)

Date 2026-11-17. Branch `implement/km-registration-fuel-split-notifications`. Base branch `main` at `3489e2a`. Nothing is committed by the build step. This section is the build stage's record; later stages (specialists, test, review) add their own results below it. The first run log above is unchanged.

### Request

> I have one slight issue in the current version where it seems that reservations cannot be tied to a registered drive. I also want to add a new feature to do with kilometer registration, I want it obliged for each ride that the kilometers are registered to that person. I want to add a new option as well to say who has fueled the car up and when, then add the price of gas at that moment and calculate each's share of the gas. If possible with an API call to Tikkie to automatically create the money request so it can be texted to the other person. I also want notes to be recommended fields on both the reservation as the registration. Lastly, I want the app to send a notification if you have an upcoming reservation (and ending) to not forget the km registration, which should also be saveable as a draft so you can already enter the starting KM and then enter the finishing KM when finishing the drive.

### What was built

- **The link problem (reproduced first, in headless Chromium at 390 and 320 px, before any change).** The server could link a drive to a reservation, but: the Drives picker only offered reservations that had already ended (`to=now`, then `slice(-20)`), a drive cannot end in the future so an upcoming reservation could not be linked, the link was manual and optional, and neither the card nor the history showed the drive. Now a reservation card has **Register km** (from 30 minutes before it starts) that opens the form pre-linked and prefilled, the picker offers reservations 30 days back to 14 days ahead without a count cut-off, and every reservation, inbox item and history entry carries `drive` and `kmState` (`registered`, `draft`, `missing`).
- **Km obligation.** A completed drive needs an end time and both odometer readings (422 `required` otherwise); distance counts for the driver; drafts and old rows without readings are left out of totals. Reservations that ended without a completed registration are listed for the driver (banner and count on the Drives tab, `GET /api/usage/pending`) and for the admin (30 days, toggle for the whole window). New reservations are never blocked.
- **Drafts.** `POST /api/usage` with `status: 'draft'`, a start and the start reading; finish with `PATCH` (end time and end reading) through the same overlap, window and ordering checks. One open draft per person (`409 draft_exists`). The form switches between Save draft and Finish drive by what is filled in.
- **Fuel.** `src/fuel.ts`: fill-ups (who, when, litres, total, price per litre derived) in integer cents and millilitres; shares per fill-up by km of completed drives that ended since the previous fill-up, largest-remainder so the shares add up exactly; balances; request and paid status per person.
- **Payment requests.** `src/payments.ts`: a manual provider (message to share, text, WhatsApp or copy, optional pasted https link) is the default. A Tikkie adapter is env-gated (all three `TIKKIE_*` or none), **unverified** and exercised only against a stub.
- **Notes.** Labelled "recommended" with a hint on the reservation, drive and fill-up forms; an empty note saves and shows a friendly tip; notes show on agenda, drives, history and admin.
- **Reminders.** `src/webpush.ts` (VAPID and RFC 8291 encryption with `node:crypto`), `src/push.ts` (endpoint allow-list, key store in `meta`, sender, routes), `src/reminders.ts` (a tick every minute: 30 minutes before the start, at the end, once more an hour later; once per reservation, kind and time, also across restarts). Service worker `push` and `notificationclick` open the registration form; the Account page has the Reminders card with an iOS install note.
- **Persistence.** Migration v2 is additive (`usage.status` with CHECKs, one-draft index, `fuel`, `fuel_requests`, `push_subscriptions`, `reminders_sent`); before it the app writes `backups/pre-migrate-v1.db`. Purge, retention counts, the admin page and backups include the new data.

### Why this approach

- Chosen: the minimal plan (additive migration, a draft is a usage row with a placeholder end, live fuel shares, Web Push on `node:crypto` and `fetch`). It meets every acceptance criterion with the fewest new concepts, keeps the six tabs (Fuel is a sub-route of Drives) and keeps zero runtime dependencies; `package.json`, the lockfile, `Dockerfile`, compose and `Caddyfile` are untouched.
- Rejected: a `web-push` dependency (breaks the zero-dependency design and the Docker runtime stage), a nullable `end_utc` table rebuild (first rebuild migration on a live database), a seventh tab for fuel (320 px).
- Tikkie: its API is offered to Tikkie business customers, so a private household most likely has no access. The default is a message the person who is owed sends themselves.

### How it works

Start with `src/reservations.ts` (`REGISTERED_SQL`, `drive` and `kmState` in the shared SELECT), then `src/usage.ts` (`shapeErrors`, drafts, pending), `src/fuel.ts`, `src/reminders.ts`, `public/views/agenda.js` (`kmAction`) and `public/views/usage.js`.

- **One definition of "registered"**: a completed drive with both readings that is linked to the reservation or strictly overlaps it, by anyone. The same SQL feeds the reservation card, the pending list and the reminder scheduler, so they cannot disagree. `kmState: 'registered'` always comes with a non-null `drive` (tested as an invariant).
- **Who sees what on a card**: the owner (or an admin) gets Register km from 30 minutes before the start, or Finish drive for a started draft; another member gets "I drove this" only once it has started and only while nothing is registered.
- A draft stores `end_utc = start_utc` as a placeholder; the API shows `end: null`; a CHECK keeps the placeholder out of finished rows.
- Reminders: stale moments (server down more than 15 minutes) are skipped; a claim is released when every send failed transiently, so the next minute retries; a 404 or 410 from a push service removes that subscription.
- Push endpoints are accepted only for `fcm.googleapis.com` and hosts below `push.apple.com`, `push.services.mozilla.com`, `notify.windows.com`; https, port 443, no credentials or IPs, no redirects, 10 s timeout. The VAPID subject is `https://<DOMAIN>` (or `PUSH_CONTACT`); `PUSH_ENABLED=false` is the kill switch.

### Files

| Path | Change | Purpose |
| --- | --- | --- |
| `src/fuel.ts`, `src/payments.ts`, `src/push.ts`, `src/webpush.ts`, `src/reminders.ts` | added | Fuel and shares, payment providers, push routes and sender, pure push crypto, reminder scheduler |
| `src/db.ts`, `usage.ts`, `reservations.ts`, `retention.ts`, `app.ts`, `http.ts`, `config.ts`, `server.ts`, `cli.ts`, `users.ts` | modified | Migration v2, drafts and pending, drive and `kmState`, purge counts, `Ctx.fetch`, new settings, reminder timer |
| `public/views/fuel.js` | added | Fuel and costs view (a Drives sub-route) |
| `public/views/usage.js`, `agenda.js`, `history.js`, `reserve.js`, `account.js`, `app.js`, `api.js`, `dom.js`, `strings.js`, `sw.js`, `style.css`, `admin/admin.js` | modified | Km flow, draft form, banner and badge, notes, reminders card, push handlers, admin pending list |
| `test/km.test.ts`, `fuel.test.ts`, `payments.test.ts`, `webpush.test.ts`, `push.test.ts`, `reminders.test.ts`, `client.test.ts` | added | Link regression, obligation, drafts, shares, providers, RFC 8291 vector, scheduler, client helpers |
| `test/helpers.ts`, `usage`, `retention`, `db`, `maintenance`, `config`, `pwa` tests | modified | Helpers, odometer-optional assertions converted (not deleted), upgrade and restore tests, push handlers |
| `.env.example`, `docs/DEPLOYMENT.md`, `README.md`, `scripts/smoke.mjs`, `CLAUDE.md` | modified | `PUSH_ENABLED`, `PUSH_CONTACT`, `TIKKIE_*`; guide section 18; smoke checks 8 to 10 |

### How to run and test

All run on Windows with Node 22.23.1 and exited 0.

- `npm run check` runs everything below. `npm test`: 305 tests, 305 pass (baseline was 192, the odometer-optional assertions were rewritten, not removed). `npm run typecheck`, `npm run lint` and `npm run build`: clean. `npm run smoke`: 10 of 10 checks (now also the push key endpoint and a draft round trip).
- Browser pass in the installed Playwright Chromium (driver scripts live outside the repo): 70 checks at 390 and 320 px, no horizontal overflow on agenda, drives, register form, history, fuel, reserve, inbox, account and the admin tabs, no console errors. It exercised register km from a card, save as draft, finish, the pending banner and cancel-unused, the note tip, a fill-up with request, share panel and mark paid, the Reminders card, and a member's view.
- Mutation checks: 15 deliberate breaks of the new rules (required readings, draft filters, one draft per person, paid-request lock, leftover cents, reminder claim, look-alike push hosts, notification origin, lead time, Tikkie settings and link, RFC 8291 key schedule). All 15 turned a test red; every file was restored and compared byte for byte. Two of the first run survived (the zero-length draft placeholder case and a half Tikkie configuration) and got their own tests.

### Verification

Verified (ran and saw pass): the commands above, the browser pass, the RFC 8291 Appendix A example (the stub decrypts our output, and the RFC's own message encrypts to exactly the RFC's body), and the RFC 8292 example token verifying with the RFC's key (the verifying side: signing is randomised, so our own tokens are checked for shape and for verification with our public key).

NOT verified:
- **Real push delivery** to Google, Apple or Mozilla, and anything on a real phone or in a real installed PWA (Android Chrome, iOS Safari 16.4+): the tests use a stand-in push service. The Account page has a **Send test notification** button for the owner to check delivery.
- **Tikkie** beyond a local stub; its API most likely needs a business account. The adapter uses one static token and is off by default.
- **Docker, Docker Compose, Caddy** and deployment to a real droplet (Docker is not installed here), including the new section 18 of the guide.
- **First deploy on the real database**: tested on a synthetic v1 file with rows and on a v1 backup restore, not on the live data.
- Screen reader behaviour (labels and `role="status"` were added and checked only structurally).

### Deliberate extras (not asked for)

A **Send test notification** button, **unsubscribing the device on sign-out** (a shared phone must not show someone else's reminders), and **mark unpaid** as an undo for payment mistakes. Each exists because real delivery cannot be tested here, phones are shared, or money records need an undo.

### Behaviour to know about

- First day after the upgrade: reservations from before the update have no completed drive, so they show as "km to register" (members: last 14 days; admin: last 30 days, toggle for 190). Each row offers **Car not used? Cancel the reservation** (existing cancel, keeps drives). No grandfather flag, because it would couple the tests to the real clock. No reminder is sent for old reservations.
- A drive by anyone that overlaps a reservation counts as registering it (Ben drives Anna's reservation: Anna is not nagged afterwards). An admin gets Register km on any reservation (the driver defaults to its owner); members get "I drove this".
- Fuel shares of the oldest fill-up can change when its oldest drives are purged; a payment request keeps the amount asked and is flagged "amount changed".
- A fill-up with a paid request is locked until it is marked unpaid.

### Deviations from the plan

- Regression tests were written together with the code, not run against the untouched tree first; the failure itself was shown in the browser reproduction and the mutation checks stand in as proof the tests bite.
- Unplanned one-line CSS fix: `.table-wrap { position: relative }`. In the browser pass the visually hidden "Actions" column heading (absolutely positioned) escaped the scrolling table box and widened the document on the admin Reservations and Drives tabs (it was already so on Reservations).
- Two extra tests after surviving mutations (above). `test/client.test.ts` also covers the `account.js` helpers (`keyBytes`, `reminderSupport`) and the fuel decimal arithmetic.

### Honesty flags

- This is the build stage's record. The specialist, test and review stages were not run when it was written.
- Real push, Tikkie, Docker, Caddy and phones are NOT VERIFIED (see above); the browser was a headless Chromium on Windows only.
- Several files in the working tree were produced across more than one build pass; the table above and `git status` are the source of truth.
- `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.yml` and `Caddyfile` are unchanged.

### Reproduce

- Invocation: `/implement` with the Request text above. Plan: `.claude/runs/km-registration-fuel-split-notifications/04-chosen-plan.md` (detail in `03-plan-0.md`). Audit directory `.claude/runs/km-registration-fuel-split-notifications` (git-excluded).
