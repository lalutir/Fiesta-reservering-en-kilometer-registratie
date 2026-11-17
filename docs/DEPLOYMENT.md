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

Two things to know:

1. **Retention caveat.** The app deletes data older than 6 months every day, but a
   backup made earlier still contains it. Old data therefore lingers in backups
   for up to 14 days. Lower `BACKUP_KEEP_DAYS` if that matters.
2. **Backups hold password hashes.** Treat copies like secrets.

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
older app refuses to open a newer database.

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
