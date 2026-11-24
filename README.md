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
- **Notifications for what somebody else does on your behalf.** When person A creates, changes or
  deletes something that is B's, B gets a push (one per device, and never A): a reservation
  suggested for you (and its change or withdrawal), your suggestion approved or declined, your
  reservation edited or cancelled by someone else such as an admin, a drive logged, changed or
  deleted in your name or on your reservation ("I drove this"), kilometres registered as yours by
  another driver (and changes or removals), a fill-up edited or deleted that changes your share, a
  fill-up entered in your name, your share marked paid or unpaid, the fueler hearing that a debtor
  pressed **I have paid**, and a traffic ticket entered, changed or deleted for a moment the app has
  you down as the driver (no price or reason in the text). A new damage report goes to everybody else
  who is active (the one notification that is not about something of yours; edits, repairs and
  deletes send nothing). The Account page lists them. There are
  no per-category settings: the one switch is Reminders on or off for the device, and without a
  device signed up the Inbox, the banners and the History screen carry the news as before.
  **This reverses two earlier defaults:** attributing kilometres to someone used to send them no
  push, and the fueler used to get no push when a debtor pressed "I have paid". Who may do what
  has not changed.
- **Fuel and costs.** Record who fuelled, when, the odometer reading, litres and price. The cost is split by the
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
- **Kilometre check.** The app lines up every odometer reading it knows (the start and end of
  each drive, the start of a drive you have not finished, and the reading at each fill-up) and
  shows **gaps** (the next reading is higher: kilometres nobody registered) and **mismatches** (it is
  lower: probably a typo) to everybody: a *Kilometre check* list on the Drives tab and the admin
  page, a line under the drives involved on the Drives tab and the History, and a note on a fuel
  card whose period holds an unexplained gap. A new drive starts from the last known reading and
  says where it comes from; a reading that does not fit gets a warning, never a block. A gap is
  cleared by *Add the missing drive*, by correcting a reading, or by **explaining** it with a note
  (the driver or fueler at either end, or an admin). A fill-up now needs its odometer reading.
  It is information only: the fuel split, the kilometre totals and every save are unchanged.
- **Car tab.** The car itself has its own page, Auto, under *Meer*. **Damage reports:** anybody files one with the
  day it was first noticed, who noticed it (you by default, somebody else, or unknown), where on
  the car (a fixed list) and a description. Everybody sees every report; the person who filed it or
  an admin edits and deletes it; **anybody can mark one repaired** (with the day and an optional
  note), and the creator or an admin can reopen it. Each report also shows who had the car before
  the day it was noticed, taken from the drive log (then an unfinished drive, then a confirmed
  reservation, then the last drive before that day). That is worked out on every read, never stored,
  and worded as information, not blame. Everybody else who is active gets one push when a report is
  filed. **APK:** one expiry date for the car that any member can enter or update. Until somebody
  does, the tab asks for it; afterwards it shows the date, the days left (or "expired"), and who
  entered it and when. Nothing reminds anybody of the date.
- **Six-month window.** You can see 6 months back and 6 months ahead, and you cannot create
  anything outside that. Everything that ended more than 6 months ago is deleted for good, every
  day and at start-up. The one exception is a **damage report that is still open**: the damage is
  still on the car, so it is kept however old it is. A repaired report is deleted 6 months after
  the day it was repaired.
- **Admin page** at `/admin/` (admins only): manage users (create, deactivate, reset password,
  roles), see and correct all reservations and drives, and check the purge and backup status.
- Times are stored in UTC and shown in the household time zone (default `Europe/Amsterdam`).
  The interface is Dutch (informal "je") and only Dutch: there is no language switcher. All text of the
  browser is in one file (`public/strings.js`), every push text in `src/notify-texts.ts`, the payment
  request in `src/payments.ts`, and the vocabulary is written down in [docs/GLOSSARY.md](docs/GLOSSARY.md).
  Dates, times, amounts and numbers are written the Dutch way (`maandag 16 november`, `€ 12,50`,
  `45.210 km`), and a decimal field accepts a comma or a dot. This README, the code, the logs and the
  command-line tool stay in English, and so do the button names quoted below (the screens say the Dutch
  ones, see the glossary); the English version of the interface is in the git history.

## Design decisions

- **PWA, not a native app.** An iPhone app outside the App Store needs a paid Apple developer
  account or re-signing every week; a PWA installs from the browser at no cost.
- **Zero runtime dependencies.** One Node 22 process using `node:http` and the built-in
  `node:sqlite`; TypeScript and ESLint are the only (dev) dependencies. This keeps it small
  enough for the cheapest cloud server and easy to keep up to date.
- **A frontend without a build step.** The member app and the admin page are plain ES modules with one stylesheet of
  custom properties (paper, ink and one signal yellow, light and dark, with a Systeem / Licht / Donker choice), the system
  fonts, one inline-SVG icon set and a small set of shared components (`public/ui.js`). The bar has five places and a page
  *Meer*, Start shows what matters right now, and from 768 px the bar is a rail. [docs/DESIGN.md](docs/DESIGN.md) says why
  each choice was made, how the generated-UI look is avoided and which targets are smaller than 44 px.
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
- **The odometer chain is derived, not stored.** `deriveChain()` in `src/odometer.ts` works out the gaps
  and mismatches on every read from the drive log and the fill-ups, like who drove a ticket. Readings
  are ordered by time and, at the same instant, by a fixed rank (the end of a drive, a zero-length
  drive, a fill-up, the start of a drive), then by id, so the same data always gives the same list.
  A fill-up that falls inside a finished drive (the pump stop was part of the trip) is not a link in
  the chain: it is only checked against that drive's own start and end readings. Only readings from
  the retention window take part and the oldest has no predecessor, so running the purge never
  changes the list. A person's "explained" note is the one thing stored (`odometer_explained`), under
  a key made of both neighbouring readings (source, row id, km, time, driver): correcting either
  reading, changing the driver or adding a drive in between gives the pair a new key, and the note
  stops applying. Drafts take part with their start reading but their kilometres never count.
  `public/kmcheck.js` is the browser side; it repeats only the two small rules the forms need before
  saving (the latest reading at or before a moment, and whether a fill-up lies inside a trip), and a
  test ties both to the server.
- **Web Push without a library.** VAPID signing and message encryption use `node:crypto` and
  `fetch` (checked against the RFC 8291 test vector), so there is still no runtime dependency.
  Subscription addresses are only accepted for the four push services the browsers use.
- **One notifier, one table, one texts file.** Routes call `notifier.emit(kind, () => payload)` after
  saving; `src/notify.ts` then (after the response is written) asks the event's row in its table who
  is told, drops the actor and anybody inactive, and sends one push per device, tagged per record so
  a later change replaces the earlier notification. Failures are logged by name and never reach the
  request. A new event is one payload type, one table row and one `emit` call; the damage report
  (`damage.created`, told to everybody active) was added exactly like that. All wording is in
  `src/notify-texts.ts`.
- **Calendar dates are not instants.** The day a dent was noticed or repaired and the APK expiry are
  `YYYY-MM-DD` text, not times: they mean the same day to everybody, whatever the server's own zone.
  One parser in `shared/time.js` (`parseDateKey`: a real day in exactly that shape) serves the server
  and the browser; "today" is the household's day (`localDateKey`), "days left" counts calendar days
  with UTC arithmetic so a 23 or 25 hour day is one day, and a date can never be in the future
  (no clock slack, unlike an instant). The database says the same with a `CHECK` that the day
  exists (`date(x) IS x`, because `=` would let an impossible day through). Retention compares
  dates too: a repaired report is deleted when its repaired date is before the local day of the
  window's start, which is coarser than the instants used for drives.
- **The driver hint on a damage report is derived, never stored**, like who drove a ticket: the
  start of the noticed local day goes through `whoDrove()` (`src/tickets.ts`) and, when that finds
  nobody, the driver of the last completed drive that ended before it is used. Correcting a drive
  corrects the hint on the next read.
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
| `npm run smoke` | Build, start the built server on a free port and check it over HTTP; a second built server with push on and `fetch` stubbed checks who is notified (nothing leaves the machine) |
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
  fuel-carry.ts  carried-over amounts and settlement (pure)        notify.ts   the one notifier and its event table
  notify-texts.ts  every word of every notification (in Dutch)
  tickets.ts  traffic tickets and who was driving at the time       odometer.ts  the odometer chain, its gaps and explanations
  car.ts      the Car tab: damage reports and the APK date
  webpush.ts  VAPID and message encryption (pure)                  push.ts     push endpoints, key, sender, routes
  reminders.ts  the once-a-minute reminder scheduler               retention.ts  the 6-month purge
  maintenance.ts  backups, daily job                               cli.ts      operator commands
  db.ts       the only file that touches node:sqlite (schema v6, migrations)
shared/     time.js: time zone, DST, calendar-month and calendar-date maths, and the Dutch date display;
            format.js: euro, litres, price per litre and kilometres as integers written the Dutch way.
            Both are used by the server and the browser
public/     the PWA (vanilla JavaScript modules, no build step; calendar.js is the pure date maths of the Agenda
            views, kmcheck.js the Kilometre check: prefill, warnings, the findings list; views/car.js the Car tab;
            nav.js the five places of the bar and the rail; ui.js and icons.js the shared components and the one
            icon set; theme.js, drafts.js, undo.js and storage.js the theme choice, unsent form input and
            "Ongedaan maken"; views/home.js the Start screen, views/more.js the page Meer)
            and public/admin/ (admin page: admin.js, and table.js the sortable and filterable table)
docs/       DEPLOYMENT.md, DESIGN.md (the design decisions), GLOSSARY.md (the Dutch vocabulary), third-party.md (the icon licence)
test/       tests (API integration tests plus unit tests)
scripts/    icon generator, the built-output smoke test (and its push stub) and the container check CI runs
e2e/        browser suite (Playwright specs, run by `npm run e2e`; not part of `npm test`)
.github/    the CI workflow and Dependabot config (`.nvmrc` is the Node version CI uses)
docs/       DEPLOYMENT.md, GLOSSARY.md (the Dutch vocabulary and tone, checked by test/dutch.test.ts)
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
reservation card, opens History, opens the Car tab (the APK prompt and the damage form; nothing is
saved there) and loads `/admin/`, once at 390 px and once at 320 px wide; `e2e/layout.spec.ts` also looks at the
rail and the admin dashboard at 768 and 1280 px. The page Meer is how the places that are not in the bar are
reached (`viaMore` in `e2e/fixtures.ts`). All five places of the bar must be readable: each label has to lie inside its own tab (`expectTabsFit` in
`e2e/fixtures.ts`; a failure there is a font size or padding to fix in `public/style.css`, not a
check to loosen; it also runs on the Linux fonts of CI, which could not be tried locally). In
every step the page must not scroll sideways, and the whole run must have no console errors,
uncaught errors, failed requests or responses with status 400 and up. The one exception is the
`401` of `GET /api/auth/me` before sign-in (that is how the app learns it must show the sign-in
screen); it is allowed once per page. Elements are found with `getByRole`, `getByLabel` and
`getByText` only, never with CSS or XPath, so the suite keeps working when the frontend is rebuilt
as long as people still read the same words; the words are in one `UI` constant in
`e2e/app.spec.ts`. `e2e/guard.spec.ts` tests that safety net itself: it makes a page misbehave
in one way at a time (a console error, an uncaught error, a failed request, a 4xx or 5xx, a
second `auth/me` probe, sideways scrolling, a tab label cut off by its tab) and expects each one to be reported, so the journey
cannot stay green because the guard went quiet. `scripts/container-check.mjs`, the check the
`Docker` job runs against the container, is tested the same way by `test/container-check.test.ts`
(inside `npm test`): it must pass against the real app and fail, naming the check, when the
server breaks one promise.

Four more specs look at what the design promises, in a real browser, at both phone widths. `e2e/touch-targets.spec.ts` measures
every link, button and field on every key screen and on the four admin sections: at least 44 by 44 CSS px, apart from the
exceptions that `docs/DESIGN.md` lists (the month cells, the checkbox, links inside text, the skip link), no text cut off by
its own box, nothing past the right edge, and a long unbroken word in a ticket wraps instead of widening the page.
`e2e/pwa.spec.ts` turns the service worker on (the rest of the suite blocks it): the shell is precached under the cache name of
`public/sw.js`, the browser reads the manifest without a complaint, with the network gone the shell opens from the worker with the
app's own message and *Opnieuw proberen* brings it back, and Systeem, Licht and Donker change the page and both `theme-color` metas.
Chromium's installability verdict is deliberately not used: in the headless browser it answers "no errors" even for a manifest
without icons, so `test/pwa.test.ts` pins what makes the app installable and only a phone can say whether it is offered.
`e2e/states.spec.ts` makes the server fail or answer slowly on purpose (so it uses Playwright's plain test, not the guard, and checks
for uncaught errors and requests to other sites by hand): every list screen shows what went wrong with *Opnieuw proberen*, one failing
request on Start costs only its own block, and a slow screen shows a loading status first. `e2e/undo.spec.ts` files a damage report and
deletes it: it leaves the screen at once without a request, *Ongedaan maken* brings it back (and a reload still shows it), and the
delete is sent when the person walks to another place. They share `e2e/session.ts` for signing in.

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
- **Kilometre check.** There is no tolerance: any difference between two neighbouring readings is
  flagged, so the few kilometres to the pump show up as a small gap after a fill-up (one constant,
  `GAP_TOLERANCE_KM`, if real use shows it is too noisy). A drive from before the check that has only
  one reading contributes that reading, so the stretch next to it can look like a gap; adding the
  missing reading or one explanation clears it. An explanation belongs to the exact pair of readings
  and applies again if exactly that pair returns. Fill-ups from before the check have no reading and
  are simply not in the chain. A phone that still runs an old copy of the app needs one reload before
  it can save a fill-up (the old form does not send the reading). The odometer of a fill-up that a
  payment depends on can still be corrected, since no money moves; its other fields stay locked.
- **Car tab.** (Superseded by the redesign: the bar has five places and a page Meer, see [docs/DESIGN.md](docs/DESIGN.md).) The tab bar then had seven tabs, so on a phone narrower than 420 px the labels are a
  little smaller (10.6 px) and the tab you are on is marked by colour and the bar above it, not by
  bold text (a bold label is the widest one; checked at 320 to 390 px in the system font and in
  Verdana, never on a real phone). It is a stop-gap until the navigation is redesigned. There is no
  photo of the damage (that needs file storage, size limits and backups, so it is a separate
  decision), no reminder or push for the APK date, and the damage list has no cap and works out the
  driver hint per day, which is fine for a household. The hint is a best match from the drive log,
  not a ruling, and an open draft is used for up to 24 hours, as for tickets. A repaired report is
  deleted by its repaired date at day granularity, so one repaired on the first day of the window is
  kept a little longer than a drive of the same moment would be. Nobody is told when a report is
  edited, repaired or deleted. The APK is one date: there is no history, only the log line of who
  changed it.
- **Notifications are sent once**, after the change is saved, and not retried; a person without a
  device signed up hears nothing and finds it in the Inbox, on the Drives tab or on the History
  screen. There is no per-category mute (the switch is per device), a suggestion that nobody
  answers still lapses without a reminder, and a drive that only overlaps somebody's reservation in
  time (without being linked to it) does not notify the reservation's owner. Real delivery to
  phones has never been tried by the authors.
- Km are obliged by validation and nagging, not by blocking new reservations. After the upgrade,
  older reservations without a drive show up as "km to register" until they are cancelled or
  registered.
- CI builds the image, runs the `app` service and validates the compose file and `Caddyfile`, but
  Caddy has not been run with a real domain and certificate, nothing has been deployed to a real
  server, and the cloud prices are unverified. Installing on real phones and the phone layout are
  manual checks (the checklist is in the guide).
- `node:sqlite` is still marked experimental in Node 22; it is confined to `src/db.ts`.
