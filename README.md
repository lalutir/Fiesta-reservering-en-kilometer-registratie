# Fiesta reservering en kilometer registratie

A private reservation system for **one shared car** in a household of about 2 to 10 people.
It is a web app that installs on Android and iPhone like an app (a PWA, no app store needed),
plus an admin page for the person who manages it.

## What it does

- **Reservations.** Everyone has their own login. You book the car for yourself and it is
  confirmed at once. Two confirmed reservations can never overlap (touching ends are fine).
- **Agenda views.** The Agenda tab opens as a list (coming up, with Earlier folded away). A switcher
  above it also offers **Day**, **3 days**, **Week** (Monday to Sunday) and **Month**, each with
  Previous, Today and Next, limited to the six-month window. A reservation shows on every day it
  touches, with the same actions as in the list; in the month grid a day shows how many
  reservations it has (a dashed count means a suggestion is waiting) and opens the Day view. The
  view and the day live in the address (`#/?view=week&date=2026-11-18`), so a refresh keeps them;
  opening the app always starts at the list.
- **Suggestions.** You can suggest a time to someone else. It stays *pending* until that person
  approves or declines it (only they can). You can withdraw your own suggestion. Pending
  suggestions do not block the car, and unanswered ones lapse when their start time passes.
  Approving checks for overlap again.
- **Drive log with kilometres.** A separate record of who *actually* drove and when. Every
  finished drive needs both odometer readings, and the kilometres count for the person who
  drove. A reservation card has a **Register km** button (from 30 minutes before it starts) that
  opens the form already linked to it, and shows the drive and kilometres once registered. The
  history shows reserved versus actual driver and kilometres per person.
- **Kilometres that are not yours.** If you drove but the kilometres are someone else's (you took
  them somewhere) or for the whole household, tick *I drove, but the kilometres aren't mine* and
  choose the person or *Together*. A note is then compulsory. You stay the driver (registration,
  reminders and overlap follow you); the kilometre totals and the fuel split follow the owner, and
  *Together* kilometres are split in the same ratio as everybody's own kilometres.
- **Drafts.** Before leaving, save the drive with only the start reading; when back, open it
  (Drives tab, or the reminder) and add the end reading and time. One unfinished drive per person.
  Reservations that ended without a completed drive are listed on the Drives tab (with a count
  on the tab) and for the admin.
- **Notes.** A note is *recommended* on both a reservation and a drive (a hint and a friendly
  tip, never a blocker) and is shown wherever the item appears.
- **Reminders.** A phone notification (Web Push) 30 minutes before a reservation starts, when
  it ends, and once more an hour later if the kilometres are still missing. Each person turns it
  on per device on the Account page. On an iPhone the app must be on the Home Screen (iOS 16.4+).
- **Fuel and costs.** Record who fuelled, when, litres and price. The cost is split by the
  kilometres that count for each person since the previous fill-up, exact to the cent, with a
  running "who owes whom" and paid status. **Admins do not pay for fuel**: their own kilometres are
  not counted and they get no share, so the others pay the whole fill-up (an admin who fuels is
  still owed the money). Registering a fill-up sends a push to everybody who owes
  money. A person who owes presses **I have paid this request** (History screen or Fuel card) for
  their own share; what is still unpaid from earlier fill-ups between the same two people is
  carried into the next amount due (and what the fueler owes back is taken off), and paying that
  request settles the earlier shares with it.
- **Payment requests.** For each share the app writes a message you send yourself (share sheet,
  text message, WhatsApp, copy), optionally with a payment link you paste. A Tikkie adapter
  exists but is **optional, off by default and unverified**: Tikkie's API is offered to business
  customers, so a private household most likely cannot use it (see the deployment guide).
- **Traffic tickets.** On the Drives tab, *Traffic tickets* lets you enter a ticket with the date
  and time of the offence (required) and, if you know them, the price in euro and the reason. The
  app shows **who was driving at that moment**: the drive log first, then a drive that was started
  and not finished, then the confirmed reservation, otherwise "unknown". Everybody can see every
  ticket; the person who entered it or an admin can correct or delete it. The app does not collect
  the money or send anything about a ticket.
- **Six-month window.** You can see 6 months back and 6 months ahead, and you cannot create
  anything outside that. Everything that ended more than 6 months ago is deleted for good, every
  day and at start-up.
- **Admin page** at `/admin/` (admins only): manage users (create, deactivate, reset password,
  roles), see and correct all reservations and drives, and check the purge and backup status.
- Times are stored in UTC and shown in the household time zone (default `Europe/Amsterdam`).
  The interface is in English with all text in one file (`public/strings.js`).

## Design decisions

- **PWA, not a native app.** An iPhone app outside the App Store needs a paid Apple developer
  account or re-signing every week; a PWA installs from the browser at no cost.
- **Zero runtime dependencies.** One Node 22 process using `node:http` and the built-in
  `node:sqlite`; TypeScript and ESLint are the only (dev) dependencies. This keeps it small
  enough for the cheapest cloud server and easy to keep up to date.
- **SQLite** in WAL mode on a volume: no database server, and a backup is a file copy.
- **A draft is a normal drive row** with `status = 'draft'` and the start time as a placeholder end
  (the API shows `end: null`); database checks keep that placeholder from leaking into a finished
  drive, and a partial unique index allows one draft per person. Drafts never count as kilometres.
- **One definition of "registered".** The reservation card, the pending list and the reminder
  scheduler share one SQL predicate (`REGISTERED_SQL`), so the banner and the notification agree.
- **Fuel shares are computed live** from the drives (pure largest-remainder function, integer
  cents and millilitres, no floats); a payment request is a snapshot of the amount that was asked.
  Personal kilometres weigh their owner (admins are left out: they do not pay for fuel); *Together*
  kilometres are split in the same ratio, which comes down to weighing the whole fill-up by
  personal kilometres, so the pool changes nobody's share. Only when nobody has personal kilometres
  in the period (nobody drove, or only together) is the cost split equally over the active members.
  The date maths of the Agenda views sits in `public/calendar.js` (pure functions, unit tested).
- **Settlement is derived, not stored.** A request remembers the highest fill-up id that existed
  when it was made (ids are creation order, no clock involved). Paying it settles the earlier shares
  of the same two people up to that id; marking it unpaid opens them again. `src/fuel-carry.ts` is
  the pure function behind the card, the request text, the push and the balances, so they agree.
- **Who drove a ticket is derived, never stored.** A ticket holds only its time, price, reason and who
  entered it. `whoDrove()` in `src/tickets.ts` works out the driver on every read, in this order: a
  completed drive that covers the moment (the person who drove, whatever the kilometres' owner and
  with or without odometer readings), an open draft that began up to 24 hours earlier and was not
  replaced by a later completed drive, a confirmed reservation, else nobody. The drive log beats the
  reservation because it records who actually drove; pending, declined and expired suggestions never
  count. Correcting a drive or a reservation therefore corrects the ticket with it.
- **Web Push without a library.** VAPID signing and message encryption use `node:crypto` and
  `fetch` (checked against the RFC 8291 test vector), so there is still no runtime dependency.
  Subscription addresses are only accepted for the four push services the browsers use.
- **Upgrades keep a copy.** Before the first migration that changes an existing database the app
  writes `backups/pre-migrate-v<old>.db`.
- The Inbox tab and its badge show suggestions waiting for your answer; the Drives tab and its
  badge show kilometres still to register.

## Quick start on Windows (development)

You need [Node.js](https://nodejs.org) 22.18 or newer (check with `node -v`).

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

For local development edit `.env` so it contains at least:

```
COOKIE_SECURE=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=pick-a-throwaway-password
```

(`COOKIE_SECURE=false` is only for plain `http://localhost`; the first admin is created from the
two `ADMIN_` lines when the database is empty.) Then:

```powershell
npm run dev
```

Open <http://localhost:3000>, sign in, and add more users at <http://localhost:3000/admin/>.
Data lives in `data/` (git-ignored).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server with auto-restart and `.env` loaded |
| `npm test` | Run all tests (Node's built-in test runner) |
| `npm run typecheck` | Type-check the server and tests, and the browser code (`checkJs`) |
| `npm run lint` | ESLint (also bans `innerHTML` in browser code) |
| `npm run build` | Compile `src/` and `shared/` to `dist/` |
| `npm run smoke` | Build, start the built server on a free port and check it over HTTP |
| `npm run check` | typecheck, lint, test, build and smoke in one go |
| `npm run e2e` | Browser suite (Playwright) at 390 and 320 px; run `npx playwright install chromium` once first |
| `npm run cli -- <command>` | Operator commands: `create-admin`, `reset-password`, `backup`, `restore`, `purge` |
| `npm run icons` | Regenerate the PWA icons in `public/icons/` |

## Project layout

```
src/        server (TypeScript, run directly by Node in dev, compiled to dist/ for production)
  server.ts   entry point        app.ts      request pipeline     http.ts     router, CSRF, headers
  auth.ts     passwords, sessions, login throttle                  users.ts    login and user admin
  reservations.ts  reservations, suggestions, permissions          usage.ts    drive log, drafts, pending km
  fuel.ts     fill-ups, cost shares, payment requests              payments.ts payment request provider (manual, Tikkie)
  fuel-carry.ts  carried-over amounts and settlement (pure)        fuel-notify.ts  the push for a new fill-up
  tickets.ts  traffic tickets and who was driving at the time
  webpush.ts  VAPID and message encryption (pure)                  push.ts     push endpoints, key, sender, routes
  reminders.ts  the once-a-minute reminder scheduler               retention.ts  the 6-month purge
  maintenance.ts  backups, daily job                               cli.ts      operator commands
  db.ts       the only file that touches node:sqlite (schema v4, migrations)
shared/     time.js: time zone, DST and calendar-month maths, used by the server and the browser
public/     the PWA (vanilla JavaScript modules; calendar.js is the pure date maths of the Agenda views)
            and public/admin/ (admin page)
test/       tests (API integration tests plus unit tests)
scripts/    icon generator, the built-output smoke test and the container check CI runs
e2e/        browser suite (Playwright specs, run by `npm run e2e`; not part of `npm test`)
.github/    the CI workflow and Dependabot config (`.nvmrc` is the Node version CI uses)
docs/       DEPLOYMENT.md
Dockerfile, docker-compose.yml, Caddyfile   production setup
```

## Continuous integration

Every pull request and every push to `main` runs `.github/workflows/ci.yml` on GitHub Actions.
It has four jobs; the names below are what GitHub shows and what branch protection refers to.

| Job | What it does | The same thing on your machine |
| --- | --- | --- |
| `Check (ubuntu-latest)` and `Check (windows-latest)` | On Linux (what production runs on) **and** Windows: `npm ci`, typecheck, lint, test, build, smoke and `npm audit --omit=dev`, each as its own step | `npm ci`, then `npm run check`, then `npm audit --omit=dev` |
| `Docker` | Lints the workflow (actionlint), validates `docker-compose.yml` and the `Caddyfile`, builds the image, starts the real `app` service on a throw-away volume, waits until it is healthy, then signs in and calls the API against the container (`scripts/container-check.mjs`), checks it runs as a non-root user with a read-only root and stops cleanly, and removes everything | see "Docker" below |
| `Browser` | `npm run e2e`: Chromium at 390 px and 320 px wide, with the browsers cached between runs. A failed run uploads the report, traces and screenshots as an artifact | see "Browser suite" below |

What CI will not do: deploy anything, use a secret or change a repository setting. The token is
read-only (`permissions: contents: read`), every action is pinned to a full commit SHA with its
version in a comment, and a new push to a pull request cancels the run that is still going for
the old one. Dependabot (`.github/dependabot.yml`) opens one grouped pull request per week for
npm, Docker, the Compose file and the actions. `test/ci.test.ts` fails when one of these rules
is broken by a later edit.

### One Node version

`.nvmrc` holds the Node version (a minor, such as `22.23`). CI installs exactly that, and the
`Docker` job builds the image with it and checks `node -v` inside the image. The `Dockerfile`
keeps the same number as its `ARG NODE_VERSION` default, so `docker compose build` on the droplet
needs no extra argument; `test/ci.test.ts` fails when the two differ. To move to a newer Node
minor, change both and follow `docs/DEPLOYMENT.md` section 13. With `nvm` or `fnm`, `nvm use`
in the project folder picks the same version.

### The gate (Linux and Windows)

```
npm ci
npm run check                # typecheck, lint, test, build, smoke
npm audit --omit=dev         # the server must stay free of runtime dependencies
```

The suite also runs on Linux in CI, so path, line-ending and timing mistakes that Windows hides
show up there. Production dependencies must stay empty: `package.json` has no `dependencies`
key and every package in the lock file is a development tool (`test/ci.test.ts` checks that).

### Browser suite

```
npx playwright install chromium     # once; downloads the browser that matches Playwright's version
npm run e2e                         # builds, starts the built server on a throw-away data folder, runs the suite
npx playwright show-report          # after a failure: the report with traces and screenshots
```

`e2e/` holds the suite. It signs in, creates a reservation, registers the kilometres from the
reservation card, opens History and loads `/admin/`, once at 390 px and once at 320 px wide. In
every step the page must not scroll sideways, and the whole run must have no console errors,
uncaught errors, failed requests or responses with status 400 and up. The one exception is the
`401` of `GET /api/auth/me` before sign-in (that is how the app learns it must show the sign-in
screen); it is allowed once per page. Elements are found with `getByRole`, `getByLabel` and
`getByText` only, never with CSS or XPath, so the suite keeps working when the frontend is rebuilt
as long as people still read the same words; the words are in one `UI` constant in
`e2e/app.spec.ts`. `e2e/guard.spec.ts` tests that safety net itself: it makes a page misbehave
in one way at a time (a console error, an uncaught error, a failed request, a 4xx or 5xx, a
second `auth/me` probe, sideways scrolling) and expects each one to be reported, so the journey
cannot stay green because the guard went quiet. `scripts/container-check.mjs`, the check the
`Docker` job runs against the container, is tested the same way by `test/container-check.test.ts`
(inside `npm test`): it must pass against the real app and fail, naming the check, when the
server breaks one promise.

The suite uses its own port (4173) and data folder. If the browser Playwright wants cannot be
installed, `E2E_CHROMIUM_PATH` can point at a Chromium or Chrome you already have (a local escape
hatch, never set in CI).

### Docker

Needs Docker. The commands use their own compose project name, so `down -v` cannot touch the
volume of a real installation on the same machine.

```bash
export COMPOSE_PROJECT_NAME=shared-car-ci
cp .env.example .env     # then in .env: ADMIN_PASSWORD=<a long random password>, COOKIE_SECURE=false, PUSH_ENABLED=false
docker compose config --quiet
docker run --rm -e DOMAIN=example.com -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile     # use the image tag in docker-compose.yml
docker compose build --build-arg "NODE_VERSION=$(cat .nvmrc)" app
docker compose up -d --no-build --wait app                             # only the app, never Caddy
docker run --rm --network shared-car-ci_default -v "$PWD/scripts:/checks:ro" \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="<the password from .env>" \
  "node:$(cat .nvmrc)-alpine" node /checks/container-check.mjs http://app:3000
docker compose down -v --remove-orphans                                # removes the throw-away volume
```

On a Linux machine the container can also be reached at its own address (CI does that):
`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q app)"`.
The workflow itself can be checked with
`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color`. CI pins that image by
digest; Dependabot does not update it, so bump it by hand.

### Requiring the checks before a merge

Nothing in this repository changes repository settings: the checks only *run*. To make GitHub
refuse a merge into `main` until all four are green, the owner runs this once (it needs admin
rights on the repository, and the four names only appear in GitHub's list after the workflow
has run once):

```bash
gh api -X PUT repos/lalutir/Fiesta-reservering-en-kilometer-registratie/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["Check (ubuntu-latest)", "Check (windows-latest)", "Docker", "Browser"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

The same in PowerShell:

```powershell
@'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["Check (ubuntu-latest)", "Check (windows-latest)", "Docker", "Browser"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
'@ | gh api -X PUT repos/lalutir/Fiesta-reservering-en-kilometer-registratie/branches/main/protection --input -
```

`enforce_admins: false` lets the owner still merge in an emergency; `strict: false` does not
force a branch to be up to date before it can merge. Check the result with
`gh api repos/lalutir/Fiesta-reservering-en-kilometer-registratie/branches/main/protection/required_status_checks --jq .contexts`
(before the command above the protection endpoint answers `404 Branch not protected`). To undo:
`gh api -X DELETE repos/lalutir/Fiesta-reservering-en-kilometer-registratie/branches/main/protection`.

Without the command: *Settings > Rules > Rulesets > New ruleset > New branch ruleset*, target the
default branch, switch on **Require status checks to pass**, add `Check (ubuntu-latest)`,
`Check (windows-latest)`, `Docker` and `Browser`, and save (or *Settings > Branches > Add branch
protection rule* for `main` with **Require status checks to pass before merging**).

## Deploying

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for a step-by-step guide: a DigitalOcean droplet
(Hetzner works the same and is a cheaper alternative), a Cloudflare DNS record for
`fiesta-reserveringen.lalutir.com`, Docker Compose with Caddy for automatic HTTPS, first admin,
backups, updates and a monthly cost estimate (about $4-6).

## Known limits

- Exactly one car; roles are only admin and member.
- **Tikkie is unverified.** The adapter was only tried against a local stand-in, uses one static
  token and is off unless all three `TIKKIE_*` settings are filled in. Payment requests work
  without it.
- **Reminders are best effort** and real push delivery (Google, Apple, Mozilla) was never tried by
  the authors; the Account page has a test button. iPhones only get them once the app is on the
  Home Screen. Without reminders the Drives tab still shows what is waiting.
- The Agenda views Day, 3 days and Week are lists per day, not an hour-by-hour grid; the view is not
  remembered between launches (the app opens at the list), and the layout at 320 and 390 px, tap
  size and contrast were only checked in a headless browser, never on a real phone.
- Admins pay no fuel. This follows the role every time, so changing a role re-splits the existing
  fill-ups, and a request made earlier for someone who is an admin now keeps its amount and is
  flagged "amount changed".
- Fuel is entered by hand (no price lookup) in euro. Because everything older than 6 months is
  deleted, the share of the oldest fill-up can change when its oldest drives disappear.
- **"I have paid" is a self-report** (the person who is owed or an admin can undo it) and the app
  moves no money. Carry-over is netted per pair of people, not across the household. A settled
  share stays settled if a drive is added to its period later; the request that settled it is
  flagged "amount changed" and that flag is the only signal. A person with nothing owed on a new
  fill-up is not asked: their older amounts wait for their next share.
- **Traffic tickets.** The driver shown for a ticket is a best match, not a ruling: if a drive or a
  reservation is corrected later the driver changes with it, and there is no way to override it by
  hand (correct the drive log instead). An open draft is used for up to 24 hours, so a forgotten
  draft can name its driver over someone else's reservation for that long. Everybody sees every
  ticket with its price and reason. A ticket is deleted with the 6-month rule, by the time of the
  offence, so an unpaid ticket older than that is gone from the app (keep the letter). The list has
  no cap and works out each driver separately, which is fine for a household and its six months.
- The fill-up push is sent once, after saving, and not retried; a person without a device signed up
  for reminders hears nothing and finds the amount on the History screen.
- Km are obliged by validation and nagging, not by blocking new reservations. After the upgrade,
  older reservations without a drive show up as "km to register" until they are cancelled or
  registered.
- The Docker/Caddy files and the cloud prices have not been run or verified by the authors, and
  installing on real phones and the phone layout are manual checks (the checklist is in the guide).
- `node:sqlite` is still marked experimental in Node 22; it is confined to `src/db.ts`.
