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
- **Drive log.** A separate record of who *actually* drove and when, with optional odometer
  readings. The history shows reserved versus actual driver and kilometres per person.
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
- Notifications are in-app only (the Inbox tab and its badge).

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
  reservations.ts  reservations, suggestions, permissions          usage.ts    drive log and history
  retention.ts     the 6-month purge                               maintenance.ts  backups, daily job
  db.ts       the only file that touches node:sqlite              cli.ts      operator commands
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
- The Docker/Caddy files and the cloud prices have not been run or verified by the authors, and
  installing on real phones and the phone layout are manual checks (the checklist is in the guide).
- `node:sqlite` is still marked experimental in Node 22; it is confined to `src/db.ts`.
