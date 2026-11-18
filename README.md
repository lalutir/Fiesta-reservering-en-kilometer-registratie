# Fiesta reservering en kilometer registratie

A private reservation system for **one shared car** in a household of about 2 to 10 people.
It is a web app that installs on Android and iPhone like an app (a PWA, no app store needed),
plus an admin page for the person who manages it.

## What it does

- **Reservations.** Everyone has their own login. You book the car for yourself and it is
  confirmed at once. Two confirmed reservations can never overlap (touching ends are fine).
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
  *Together* kilometres are split equally over everybody active.
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
  running "who owes whom" and paid status. Registering a fill-up sends a push to everybody who owes
  money. A person who owes presses **I have paid this request** (History screen or Fuel card) for
  their own share; what is still unpaid from earlier fill-ups between the same two people is
  carried into the next amount due (and what the fueler owes back is taken off), and paying that
  request settles the earlier shares with it.
- **Payment requests.** For each share the app writes a message you send yourself (share sheet,
  text message, WhatsApp, copy), optionally with a payment link you paste. A Tikkie adapter
  exists but is **optional, off by default and unverified**: Tikkie's API is offered to business
  customers, so a private household most likely cannot use it (see the deployment guide).
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
  Personal kilometres weigh their owner; *Together* kilometres are a pool every active user carries
  an equal part of (each weight is scaled by the number of active users, so it stays an integer).
- **Settlement is derived, not stored.** A request remembers the highest fill-up id that existed
  when it was made (ids are creation order, no clock involved). Paying it settles the earlier shares
  of the same two people up to that id; marking it unpaid opens them again. `src/fuel-carry.ts` is
  the pure function behind the card, the request text, the push and the balances, so they agree.
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
  webpush.ts  VAPID and message encryption (pure)                  push.ts     push endpoints, key, sender, routes
  reminders.ts  the once-a-minute reminder scheduler               retention.ts  the 6-month purge
  maintenance.ts  backups, daily job                               cli.ts      operator commands
  db.ts       the only file that touches node:sqlite (schema v3, migrations)
shared/     time.js: time zone, DST and calendar-month maths, used by the server and the browser
public/     the PWA (vanilla JavaScript modules) and public/admin/ (admin page)
test/       tests (API integration tests plus unit tests)
scripts/    icon generator and the built-output smoke test
docs/       DEPLOYMENT.md
Dockerfile, docker-compose.yml, Caddyfile   production setup
```

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
- Fuel is entered by hand (no price lookup) in euro. Because everything older than 6 months is
  deleted, the share of the oldest fill-up can change when its oldest drives disappear.
- **"I have paid" is a self-report** (the person who is owed or an admin can undo it) and the app
  moves no money. Carry-over is netted per pair of people, not across the household. A settled
  share stays settled if a drive is added to its period later; the request that settled it is
  flagged "amount changed" and that flag is the only signal. A person with nothing owed on a new
  fill-up is not asked: their older amounts wait for their next share.
- The fill-up push is sent once, after saving, and not retried; a person without a device signed up
  for reminders hears nothing and finds the amount on the History screen.
- Km are obliged by validation and nagging, not by blocking new reservations. After the upgrade,
  older reservations without a drive show up as "km to register" until they are cancelled or
  registered.
- The Docker/Caddy files and the cloud prices have not been run or verified by the authors, and
  installing on real phones and the phone layout are manual checks (the checklist is in the guide).
- `node:sqlite` is still marked experimental in Node 22; it is confined to `src/db.ts`.
