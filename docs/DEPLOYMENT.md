# Deployment guide

This guide puts the shared car app on one small cloud server (a "droplet" on
DigitalOcean, or the equivalent on Hetzner) with automatic HTTPS, a persistent
SQLite database and nightly backups. Plan on about an hour the first time.

> **Not verified here.** The Docker, Docker Compose and Caddy files in this
> repository were reviewed but never run by the people who wrote them, and every
> price below is from memory. Treat the first deployment as a test, follow the
> smoke checklist at the end, and check the provider's pricing page before you
> pay for anything.

What you get:

```
phone / browser --HTTPS--> Caddy (certificates, ports 80/443)
                              |  internal network only
                              v
                     app (Node 22, port 3000, not published)
                              |
                      volume app_data:  /data/car.db (SQLite, WAL) + /data/backups/
```

## 1. What you need

- A DigitalOcean account (or Hetzner, see the cost section) and an SSH key pair.
- The domain `lalutir.com`, with its DNS managed in Cloudflare. The app is served
  at **`fiesta-reserveringen.lalutir.com`**. HTTPS is required for installing the
  app on a phone, and Caddy can only get a certificate for a real name; section 6
  adds the one DNS record this needs.
- This repository, reachable from the server (`git clone`), for example from
  your own GitHub account.

## 2. Create the droplet

1. In DigitalOcean choose **Create > Droplets**.
2. Image: **Ubuntu 24.04 LTS** (any current Ubuntu LTS is fine).
3. Plan: **Basic**, shared CPU, the smallest regular-SSD size (512 MiB RAM,
   1 vCPU, about $4 per month, unverified). The 1 GiB size (about $6) is more
   comfortable, especially while building the image. The app itself uses well
   under 100 MiB.
4. Region: pick one close to you (for example Amsterdam or Frankfurt).
5. Authentication: **SSH key** (not a password).
6. Optional: tick **Backups** (about 20% extra). This is a second safety net on
   top of the app's own database backups, not a replacement.
7. Create it and note the IPv4 address.

## 3. First login and basic hardening

Log in as root once, create a normal user, and switch to it:

```bash
ssh root@YOUR_SERVER_IP
adduser car                      # choose a strong password; it is only for sudo
usermod -aG sudo car
rsync --archive --chown=car:car ~/.ssh /home/car     # reuse your SSH key
```

Open a second terminal and check `ssh car@YOUR_SERVER_IP` works before going on.
Then, as the `car` user, turn off root and password logins and enable the
firewall:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
# Check what sshd really uses: a file in /etc/ssh/sshd_config.d/ (for example the
# one cloud-init writes) takes precedence over the line edited above.
sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication) '   # both must say "no"

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp           # HTTP/3
sudo ufw enable
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install unattended-upgrades
```

Docker note: Docker edits the firewall itself and **bypasses ufw for any port it
publishes**. That is why `docker-compose.yml` publishes only Caddy's 80 and 443,
and the app's port 3000 is only `expose`d to the internal Docker network. Do not
add a `ports:` entry to the `app` service.

## 4. Swap space (512 MiB droplets only)

Building the image needs more memory than the smallest droplet has. Add 1 GiB of
swap first:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                           # Swap should now show 1.0Gi
```

## 5. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker car
exit                              # log out and back in so the group applies
ssh car@YOUR_SERVER_IP
docker compose version            # should print v2.x
```

## 6. Domain and DNS

The app lives at **`https://fiesta-reserveringen.lalutir.com`**. You own
`lalutir.com` and manage its DNS in Cloudflare, so the only thing to do is add
one record there. Do this once the droplet exists and you know its IPv4 address
(section 2).

1. Log in to the Cloudflare dashboard, open the `lalutir.com` site, then
   **DNS > Records > Add record**.
2. Fill it in:
   - **Type:** `A`
   - **Name:** `fiesta-reserveringen` (Cloudflare shows the full name
     `fiesta-reserveringen.lalutir.com` next to it)
   - **IPv4 address:** the droplet's IPv4 address
   - **Proxy status:** **DNS only** (grey cloud). New records default to
     *Proxied* (orange cloud): click the cloud once so it turns grey.
   - **TTL:** Auto (or 5 min while you are still testing)
3. Save. Add an **AAAA** record with the same name only if you enabled IPv6 on
   the droplet and use its IPv6 address; otherwise leave IPv6 out.

**Why "DNS only".** Caddy gets its Let's Encrypt certificate by itself over ports
80 and 443, so it needs the name to lead straight to the droplet. No Cloudflare
API token or plugin is needed, which also means no Cloudflare credentials on the
server. And the app rate-limits logins per client address (the one Caddy puts in
`X-Forwarded-For`). Behind Cloudflare's proxy that address would be a Cloudflare
one, shared by everyone, so the household would be throttled as a single client.
Cloudflare still hosts the DNS; you just do not route the traffic through it.

If you switch the proxy on anyway, this guide has not been tested that way: set
**SSL/TLS > Overview** to **Full (strict)** (never *Flexible*, which causes an
endless redirect loop), and expect the login throttle to see Cloudflare addresses.

If you ever added CAA records to `lalutir.com`, make sure one of them allows
`letsencrypt.org`, or the certificate is refused.

Wait until the name resolves to your server before starting the stack, otherwise
Caddy cannot get a certificate. From your own computer (on Windows use
`nslookup`; on Linux or macOS use `dig`):

```bash
nslookup fiesta-reserveringen.lalutir.com        # Windows
dig +short fiesta-reserveringen.lalutir.com      # Linux / macOS
```

It must print your droplet's IP. If it prints any other address (Cloudflare's own
look like `172.67.x.x` or `2606:4700:...`), the record is still proxied: switch it
to **DNS only**.

## 7. Get the code and configure it

```bash
git clone https://github.com/YOUR-ACCOUNT/YOUR-REPO.git shared-car
cd shared-car
cp .env.example .env
chmod 600 .env
nano .env
```

Set at least:

| Variable | Value |
| --- | --- |
| `DOMAIN` | `fiesta-reserveringen.lalutir.com` (already the value in `.env.example`) |
| `HOUSEHOLD_TZ` | your time zone, for example `Europe/Amsterdam` |
| `ADMIN_USERNAME` | the first admin's username (3-32 characters: a-z, 0-9, `.`, `_`, `-`) |
| `ADMIN_PASSWORD` | a long random password, for example from `openssl rand -base64 24` (empty in `.env.example` on purpose: with no password no admin is created) |

Keep the password to letters, digits and `- _ . / + =`: Docker Compose treats `$`
and `#` in a `.env` file specially. Leave `COOKIE_SECURE` unset (it defaults to
on). `.env` is git-ignored: never commit it and never paste it into chat or tickets.

The reminders and the optional Tikkie link have settings of their own; the defaults
are right for this household (section 18).

## 8. Start it

```bash
docker compose up -d --build
docker compose ps                 # both services "running"/"healthy"
docker compose logs -f            # Ctrl+C to leave; look for certificate messages from caddy
```

Then open `https://fiesta-reserveringen.lalutir.com`. The first start builds the
image (several minutes on the smallest droplet). Caddy fetches the certificate
within a minute once DNS is right.

## 9. The first admin

There is **no public sign-up**. Accounts are created by an admin only.

**Option A: from the environment (default).** On its first start, with an empty
user table, the app creates the admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
Log in, then **remove the `ADMIN_PASSWORD` line from `.env`** and re-create the
container so the password no longer sits in its environment:

```bash
nano .env                         # delete the ADMIN_PASSWORD line
docker compose up -d              # recreates the app container
```

**Option B: with the command line.** Useful if you forgot the password or
skipped the environment variables:

```bash
# generated password, printed once
docker compose exec app node dist/src/cli.js create-admin lars --name "Lars"

# or choose the password without leaving it in your shell history
read -rs -p "Password: " PW; echo
printf '%s' "$PW" | docker compose exec -T app node dist/src/cli.js create-admin lars --name "Lars" --password-stdin

# reset a forgotten password (signs that user out everywhere)
docker compose exec app node dist/src/cli.js reset-password lars
```

Other users are added in the admin page: sign in, open `/admin/`, tab **Users**.
Leave the password empty to have one generated, and hand it over privately.

## 10. Install the app on phones

Open `https://fiesta-reserveringen.lalutir.com` on the phone and sign in once.

- **Android (Chrome):** menu (three dots) > **Install app** (or **Add to Home screen**).
- **iPhone / iPad (Safari):** Share button > **Add to Home Screen**. The installed
  app keeps its own storage, so **sign in again once** inside it.

The home-screen app opens full screen. Without a connection it still starts, but
reservations and drives need the network.

## 11. Backups

The app does this by itself:

- once per local day (and at start-up if there is none for today) it writes
  `car-YYYY-MM-DD.db` into `/data/backups` (inside the `app_data` volume),
  consistent even while the app is running;
- it keeps the newest 14 (`BACKUP_KEEP_DAYS`) and deletes older ones.

Three things to know:

1. **Retention caveat.** The app deletes data older than 6 months every day, but a
   backup made earlier still contains it. Old data therefore lingers in backups
   for up to 14 days. Lower `BACKUP_KEEP_DAYS` if that matters.
2. **Backups hold password hashes**, the push signing key and every phone's push subscription. Treat copies like secrets.
3. **Upgrade copies.** When an update changes the database layout, the app first
   writes `pre-migrate-v<old version>.db` into the same folder. Those are not
   rotated or deleted by themselves (section 18).

**Off-site copy** (not automated, to keep the cost at zero; do it now and then,
and always before an update):

```bash
# on the server: copy the backups out of the volume
rm -rf ~/backups-copy && docker compose cp app:/data/backups ~/backups-copy

# on your own computer
scp -r car@YOUR_SERVER_IP:backups-copy ./car-backups
```

**Take a backup right now:**

```bash
docker compose exec app node dist/src/cli.js backup
```

**Restore** (the app must be stopped; a safety copy `pre-restore-<time>.db` of the
current database is kept in `/data/backups`):

```bash
docker compose stop app
docker compose run --rm --no-deps app node dist/src/cli.js restore /data/backups/car-2026-06-14.db
docker compose start app

# restoring a file you copied from your computer instead:
mkdir -p ~/restore && cp car-2026-06-14.db ~/restore/
docker compose run --rm --no-deps -v ~/restore:/restore:ro app node dist/src/cli.js restore /restore/car-2026-06-14.db
```

Try a restore once on purpose, before you need it.

## 12. Updating

```bash
cd ~/shared-car
docker compose exec app node dist/src/cli.js backup     # always first: migrations only go forward
git pull
docker compose build --pull                              # --pull: newest patch of the pinned Node base image
docker compose pull caddy                                # newest patch of the pinned Caddy minor
docker compose up -d                                     # recreates only the containers that changed
docker compose logs --tail 50 app                        # check it started cleanly
docker image prune -f                                    # free disk space
```

**Rollback:** check out the previous version and rebuild:

```bash
git log --oneline -5
git checkout PREVIOUS_COMMIT_OR_TAG
docker compose up -d --build
# later, to get back on the normal branch before the next `git pull`:
git switch -
```

If the new version had changed the database layout (the release notes will say
so), also restore the backup you took before updating (section 11), because an
older app refuses to open a newer database. The app itself keeps the copy it made
just before such an upgrade as `/data/backups/pre-migrate-v<old version>.db`
(section 18).

## 13. Pinned versions

Both images are pinned to a minor version so a rebuild of the same commit gives
the same result:

- **Node:** `ARG NODE_VERSION=22.23` at the top of the `Dockerfile` (image
  `node:22.23-alpine`). This is the only place it is set.
- **Caddy:** `image: caddy:2.11-alpine` in `docker-compose.yml`.

Patch and Alpine security fixes still arrive, but only when you ask for them with
`docker compose build --pull` and `docker compose pull caddy` (section 12);
a plain `docker compose up -d --build` reuses the base image already on the server.

The app uses Node's built-in `node:sqlite`, which is still marked experimental,
so moving to a newer Node **minor** is a deliberate step: take a backup, change
`NODE_VERSION` in the `Dockerfile`, run `docker compose up -d --build`, check
`docker compose logs --tail 50 app`, and run the smoke checklist (section 15).
`docker compose exec app node -v` shows the version that is actually running.
Treat a new Caddy minor the same way (edit the `image:` line).

## 14. Never do this

- `docker compose down -v` (or `docker volume rm`) **deletes the database, the
  backups and the HTTPS certificates**. Plain `docker compose down` is safe.
- Do not commit `.env`, and do not leave `ADMIN_PASSWORD` in it after the first login.
- Do not publish port 3000 or set `COOKIE_SECURE=false` on the server.

## 15. Smoke checklist after the first deployment

- [ ] `curl -s https://fiesta-reserveringen.lalutir.com/api/health` prints `{"status":"ok"}`.
- [ ] `http://fiesta-reserveringen.lalutir.com` redirects to `https://` and the browser shows a valid certificate.
- [ ] The Cloudflare record is **DNS only** (grey cloud): `curl -sI https://fiesta-reserveringen.lalutir.com | grep -i '^server:'` prints nothing. If it prints `server: cloudflare`, the proxy is on (section 6).
- [ ] You can sign in, a wrong password is refused with a generic message.
- [ ] Making a reservation works, and the same time again is refused as taken.
- [ ] `/admin/` opens for the admin; for a normal member or when signed out it does not.
- [ ] `docker compose exec app ls -l /data/backups` lists today's backup.
- [ ] `docker compose logs app | grep retention.purge` shows a JSON line with the deleted counts.
- [ ] After an update from the first version: `docker compose exec app ls -l /data/backups`
      lists `pre-migrate-v1.db`, and the Drives tab and the admin page open without errors (section 18).
- [ ] On one phone: Account > Reminders > Enable reminders, then **Send test notification**;
      the notification appears. On an iPhone this needs the app on the Home Screen (section 18).
- [ ] A drive can be saved as a draft with only the start reading and finished later;
      a fill-up shows each person's share, and a payment request can be copied or shared.
- [ ] After an update from the version with fuel costs: `docker compose exec app ls -l /data/backups`
      lists `pre-migrate-v2.db`, and existing drives still show as the driver's own (section 18).
- [ ] Tick **I drove, but the kilometres aren't mine** on a drive: it needs a note, and the
      fuel share moves to the other person. With reminders on for a second phone, registering a
      fill-up sends that person a notification, and **I have paid this request** on the
      History screen marks their share paid.
- [ ] **Login speed:** run this (an unknown user still pays for one password hash).
      If it takes clearly more than 0.5 s, set `SCRYPT_P=1` (or 2) in `.env` and
      run `docker compose up -d`; existing passwords keep working.
      ```bash
      time curl -s -o /dev/null -X POST https://fiesta-reserveringen.lalutir.com/api/auth/login \
        -H 'Content-Type: application/json' -d '{"username":"nobody","password":"wrong-password-1"}'
      ```
- [ ] Android Chrome and iPhone Safari can install the app; it fits the phone
      screen without sideways scrolling; opening it in airplane mode shows the shell.
- [ ] You restored a backup once on purpose (section 11).

## 16. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Browser says the connection is not private | Caddy has no certificate yet. `docker compose logs caddy`: usually DNS not pointing at the server, or ports 80/443 blocked. |
| The browser says "too many redirects", a Cloudflare error page (52x) appears, or everyone gets "too many attempts" at sign-in | The Cloudflare record is proxied (orange cloud). In Cloudflare **DNS > Records**, edit `fiesta-reserveringen` and set **Proxy status** to **DNS only** (section 6). |
| Sign-in works on one phone but "session ended" keeps appearing | The page is open over plain `http://`. Use the `https://` address. |
| `docker compose up` stops with `set DOMAIN in .env` | `DOMAIN` is missing from `.env`. |
| Build is killed or hangs on the smallest droplet | Add the swap file (section 4) or use the 1 GiB droplet. |
| The test notification never arrives | Check, in this order: reminders are on for that device (Account page), notifications are allowed for the app in the phone's settings, the app is installed on the Home Screen on an iPhone, `PUSH_ENABLED` is not `false`, `docker compose logs app` has no "Reminders are off" warning from the start-up (it means `DOMAIN` is not a bare host name such as `car.example.com` and `PUSH_CONTACT` is empty), and the same logs show no `push.send_failed` lines (they name the push service and the status). A phone whose push service answers "gone" is removed and has to enable reminders again. |
| The Account page says this browser's push service is not supported | Only Google (Chrome, Edge, Android), Apple, Mozilla and Microsoft push services are used (section 18). |
| Times look an hour off | `HOUSEHOLD_TZ` is wrong in `.env`; times are shown in that zone whatever the phone is set to. |
| Disk is filling up | `docker system df` shows where. Container logs are capped at 3 x 10 MB each; old images and build cache are the usual cause: `docker image prune -f` and `docker builder prune -f`. Do not prune volumes (`docker volume prune`, `docker system prune --volumes`): with the stack down they can remove the database volume. |

## 17. Monthly cost estimate

All figures are **from memory and not verified**; check the pricing pages.

| Item | Estimate |
| --- | --- |
| DigitalOcean Basic droplet, 512 MiB / 1 vCPU / 10 GiB | about $4 per month |
| DigitalOcean Basic droplet, 1 GiB (more comfortable) | about $6 per month |
| Optional DigitalOcean droplet backups | about +20% of the droplet price |
| Domain name | EUR 0 extra: `lalutir.com` is already yours, and the one DNS record in Cloudflare's free DNS costs nothing |
| HTTPS certificate | EUR 0 (Let's Encrypt, via Caddy) |
| **Total** | **about $4-6 per month** |

**Cheaper alternative: Hetzner Cloud.** Their smallest cloud server costs roughly
EUR 4-5 per month (unverified) with more memory and disk than the smallest
DigitalOcean droplet, and has data centres in Germany and Finland. Everything in
this guide works the same there: create an Ubuntu server, and follow sections 3
to 15 (the swap file is then usually unnecessary).

## 18. Kilometres, reminders, fuel costs and payment requests

This section is about the part of the app that records every drive with its
odometer readings, reminds people to do that, and splits the fuel. Like the rest
of this guide it was **never run on a real server, phone or push service by the
people who wrote it**: the automated tests cover the logic and the message
format, not delivery to a real phone. Section 15 has a short checklist for it.

### Updating to this version (database upgrade)

The first start of this version upgrades the database from schema v1 to v2
(drafts, fuel, payment requests, reminder subscriptions). Nothing is removed.

- **Take a backup first**, as for any update (section 12).
- Right before the upgrade the app also writes a full copy of the old database to
  `/data/backups/pre-migrate-v1.db`. It is written once, not rotated and not
  deleted by the daily clean-up. It holds password hashes like every backup, so
  treat it as a secret, and delete it (`docker compose exec app rm /data/backups/pre-migrate-v1.db`)
  once you are happy with the new version. If it cannot be written (disk full),
  the app refuses to start and the database is left untouched.
- **Going back:** stop the app, restore that file with the restore command from
  section 11, and start the previous version. Drafts, fill-ups and payment
  requests made after the upgrade are lost by a restore, and an older app refuses
  to open a v2 database. If you go back and later try the update again, delete
  `pre-migrate-v1.db` first: the app never overwrites an existing copy, so
  otherwise it would keep the old one instead of making a fresh copy of the
  database as it is by then.
- **Coming from the version that already had fuel costs (schema v2)?** The first
  start of the current version upgrades the database once more, to schema v3
  (whose kilometres a drive is, and what a payment request covers). Nothing is
  removed, and the same rules apply with a second copy,
  `/data/backups/pre-migrate-v2.db`: take a backup first, treat the copy as a
  secret, delete it when you are happy, and to go back stop the app, restore that
  file and start the previous version (an older app refuses to open a v3
  database). If you come straight from the first version, the app upgrades
  v1 to v3 in one start and writes only `pre-migrate-v1.db`. After the upgrade
  every existing drive reads as the driver's own kilometres, and a payment
  request made before it keeps asking for the share alone and settles nothing
  but itself.
- **What people see on the first day:** reservations from before the update have
  no completed drive with odometer readings, so they count as "kilometres to
  register". A member's Drives tab lists their reservations that ended in the
  last 14 days; the admin page lists the last 30 days and has a button for the
  whole 6 months. Every row has **Car not used? Cancel the reservation**, which
  removes the reservation and keeps any drive. Old drives without readings are
  kept and shown, but saving a change to one now needs both readings. No
  reminder notification is sent for old reservations.

### Kilometre registration

- Every finished drive has an end time and both odometer readings; the kilometres
  count for the person who drove (not for the person who reserved), unless the
  driver says they are someone else's or shared (see below).
- A drive can be saved as a **draft** with only the start reading, before leaving,
  and finished with the end reading and end time when back. Each person can have
  one unfinished drive at a time.
- A reservation card offers **Register km** from 30 minutes before it starts and
  shows who registered it and how far. Someone else who drove a reservation uses
  **I drove this**, once it has started.
- The note on a reservation or a drive is recommended, never required, except when
  the kilometres are not the driver's own (next).

### Kilometres that are not the driver's own

A driver (or an admin, for any drive) can tick **I drove, but the kilometres
aren't mine** on the drive form and choose **another person** or **Together**.
A note is then compulsory: say why. It is the only way to charge the fuel to
the right person, for example when you take someone to the station in their
errand, or when a trip is for the whole household.

- The driver stays the driver. The obligation to register the drive, the
  reminders and the overlap check all follow the driver; only the kilometre
  totals and the fuel split follow whose kilometres they are. No approval from the
  other person is needed: it is visible, with the note, in History, in the Drives
  list, on the reservation card and in the admin Drives table.
- **Together** kilometres are not anybody's: when fuel is shared out they are a
  pool that is split **in the same ratio as the personal kilometres of the same
  period** (to the cent, the odd cent goes to the lowest user id). That comes down to
  splitting the whole fill-up by each person's own kilometres, so a person who drove
  nothing of their own in that period pays none of the pool, and the pool only
  matters when nobody has personal kilometres (then the cost is split equally over
  the active members, and the card says so). The Drives tab lists the pool on its
  own line; a person's own total never includes it.
- Kilometres per person count under their owner; the grand total is unchanged.
  The number of drives still counts for the driver.
- A member cannot change this on a drive that a payment request depends on
  (the same rule as for the other fields of such a drive); an admin can.
- A person who is deactivated later keeps the kilometres already given to them,
  but cannot be chosen for new ones, and does not take part in the equal split
  (they still pay for personal kilometres already given to them).

### Agenda views

The Agenda tab opens as the list. The switcher above it adds **Day**, **3 days**
(the chosen day and the two after it), **Week** (Monday to Sunday) and **Month**.
Previous, Today and Next step by one day, three days, a week or a month and stop
at the edges of the six-month window; days outside the window are not shown. A
reservation appears on every day of the household time zone it touches (a night
booking is on both days; one that ends exactly at midnight is not on the next
day), with the same buttons as in the list, and says in words whether it is
confirmed or waiting for an answer. Declined and expired suggestions are not
shown, as in the list. In the month grid each day shows a count (a dashed edge
means a suggestion is waiting) and opens the Day view.

The view and the day are kept in the address (`#/?view=week&date=2026-11-18`), so
the refresh every minute, a reload and every action keep them; nothing is stored
on the phone, so opening the app always starts at the list. An address with an
unknown view or a date that does not exist falls back to the list or to today,
and a date outside the window to the nearest day inside it. Known limits: the
views are lists per day, not an hour-by-hour grid; after Previous or Next the
screen reader focus moves to the heading of the new period; and a button that has
keyboard focus loses it when the page refreshes itself after a minute (like every
other screen).

### Reminders (Web Push)

The app can send a phone notification 30 minutes before a reservation starts (to
save the start reading), when it ends, and once more an hour later if the
kilometres are still not registered. Each moment is sent once per reservation,
also across restarts. Nothing is sent when the reservation is not confirmed, when
a drive is registered, or when the server was down so long that the moment is more
than 15 minutes in the past.

- **It needs nothing in `.env`.** The app identifies itself to the push services
  with `https://` plus `DOMAIN`. `PUSH_CONTACT` overrides that with another
  `https://` address or a `mailto:` address. Either one is sent to Google, Apple
  and Mozilla with each notification, so prefer the website address over a
  personal mailbox. `PUSH_ENABLED=false` switches all reminders off.
- **Everyone turns it on per device:** Account > Reminders > Enable reminders, and
  allow notifications when the phone asks. **Send test notification** is the way
  to see that delivery really works on that phone.
- **iPhone and iPad:** push only works for the app installed on the Home Screen
  (Share, then Add to Home Screen) on iOS or iPadOS 16.4 or later. Open the
  installed app to turn reminders on. In a Safari tab the Account page says so.
- **Supported push services:** Google (`fcm.googleapis.com`, used by Chrome, Edge
  and Android), Apple (below `push.apple.com`), Mozilla (below
  `push.services.mozilla.com`) and Microsoft (below `notify.windows.com`). The
  server only ever contacts these, over HTTPS on port 443, and does not follow
  redirects. Any other browser is told its push service is not supported. The
  list sits near the top of `src/push.ts`, so adding a service is a one-line change.
- **The container needs outbound HTTPS.** Docker's default networking allows it.
- **The key:** the first time it is needed the app creates a signing key for push
  and keeps it in the database, so phones stay signed up across restarts, updates
  and restores. With a brand-new database everyone has to enable reminders again.
- **Best effort.** Phones can delay or drop notifications (battery saving, "do not
  disturb"). Without notifications the Drives tab still shows a banner and a count
  of what is waiting.

### Fuel costs

- Anyone records a fill-up (when, and any two of litres, total price and price per
  litre; the third is worked out). An admin can record one for someone else.
  Money is kept in whole cents and volume in millilitres, in euro.
- Each fill-up is split over the kilometres of the **finished drives that ended
  between the previous fill-up and this one**, to the cent (leftover cents go to
  the largest shares). The person who fuelled does not owe themselves. If nobody
  has personal kilometres in that period (nobody drove, or only together) the cost
  is split equally over the active members, and the card says so. The first
  fill-up covers every drive before it.
- **Admins do not pay for fuel.** Every user with the admin role (active or not)
  is left out of the split: they get no share, no payment request, no push and no
  "I have paid" button, their own kilometres are not counted, and the other people
  pay the whole fill-up. An admin who fuels is still owed the money, and
  kilometres an admin drove *for* a member or for *Together* count under that
  owner. The rule is read from the user's role every time, so it is retroactive:
  making someone an admin (or a member again) re-splits the existing fill-ups at
  once, like any other change of drives or users. A payment request that was made
  earlier for a person who is an admin now keeps the amount that was asked, is
  marked "amount changed", stays on the card of the person who fuelled (who can
  still mark it paid or unpaid) and is no longer counted as a debt. If everybody
  is an admin a fill-up is saved without any shares.
- Fill-ups follow the 6 month retention like everything else, together with their
  payment requests, so an unpaid request older than that disappears. When old
  drives are deleted the share of the oldest fill-up can change; a request that
  was already made keeps the amount that was asked and is marked "amount changed"
  (paid or not), with the difference written under it. A person a request was made
  for stays on the card even when their share has dropped to nothing. "Who owes
  whom" counts every unpaid share at what is owed now and nothing for a paid one,
  so a paid request whose share changed afterwards is not settled by the balances:
  read the difference on its card and mark it unpaid to ask again.
- Only the person who fuelled (or an admin) can edit, delete or request, and a
  fill-up with a payment marked as paid, or one whose share a later payment settled
  (below), is locked until that payment is marked unpaid. Marking paid is also open
  to the person who owes the money, for their own share only (next).
- Once a payment request exists for a fill-up, the drives that ended in its period
  can no longer be edited, moved or deleted by their owners (the drive says so);
  an admin still can. Registering a new drive is always possible.

### Telling people, "I have paid" and amounts carried over

- **A push when a fill-up is registered.** Everybody with a share above zero who
  has reminders turned on gets one notification per device, naming who fuelled and
  the amount due, and opening the History screen. It is sent after the fill-up is
  saved, so a slow or broken push service never delays or fails the save; a failure
  is logged (host and status, never the address or keys) and not retried. Nothing is
  sent when reminders are switched off, for people without a device, for deactivated
  people, or when a fill-up is edited or deleted. The amount can still change when
  more drives are registered, and the message says so.
- **"I have paid this request."** The person who owes money sees their open shares
  on the History screen (under **Fuel you owe**) and on the Fuel card, each with the
  amount due and this button. It works with or without a payment request, marks the
  share paid and records who and when. Only the person who is owed (or an admin) can
  undo it. It is a self-report: nothing is checked against a bank.
- **Unpaid amounts are carried over.** What a person still owes the same fueler from
  earlier fill-ups is added to their share of the next one, and what the fueler
  still owes them in return is taken off (never below zero). The card, the payment
  request text and the push show the share, what is carried and the total. When
  that request is marked paid, the earlier shares it included are settled with it,
  in one step: the request's paid mark is the only thing written, and the settled
  shares follow from it. Marking it unpaid opens them again. Only fill-ups that
  existed when the request was made are included, so a forgotten fill-up added
  afterwards stays owed. A debtor with nothing owed on the new fill-up is not
  asked anything: their old amounts wait until they next have a share.
- **Where it can mislead.** A settled share is no longer counted, even if a drive
  that changes it is added to its period afterwards; the request that settled it
  is then marked "amount changed" with the difference, and that flag is the only
  signal, so read it. A fill-up whose share was settled by a later payment is
  locked like one with a paid request. Money is whole cents everywhere and the
  sums are exact; the app does not move money.

### Payment requests (and Tikkie)

- **Default: a message you send yourself.** The app writes the request text; the
  person who is owed shares it by the phone's share sheet, text message, WhatsApp
  or copy and paste. They can paste a payment link from a bank app or Tikkie to
  include it (https only). They mark the share paid when the money arrives.
- **Tikkie is optional, off, and unverified.** Tikkie's own API is offered to
  Tikkie business customers; a private household most likely has no access, and
  nobody involved in writing this could try it. The adapter switches on only when
  **all three** of `TIKKIE_PAYMENT_REQUEST_URL`, `TIKKIE_API_KEY` and
  `TIKKIE_ACCESS_TOKEN` are set in `.env` (the app refuses to start with only
  some). It sends one static bearer token, whereas the real API uses short-lived
  tokens, and it was tried only against a stand-in server in the automated tests.
  Whatever goes wrong, the request falls back to the normal message, and only a
  link on `tikkie.me` is ever shown. The key and token are never logged or sent to
  the browser. Leave all three empty unless you really have that access.

### Switching things off

- Reminders and the push for a new fill-up: `PUSH_ENABLED=false` in `.env`, then `docker compose up -d`.
- Tikkie: empty the three variables.
- Nothing else needs a rollback; fuel costs and drafts are simply not used.
