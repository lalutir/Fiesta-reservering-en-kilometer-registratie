# Read-only API and calendar feed

Two ways for the household's own tools to read the app without signing in as a person:

- **The token API**, four `GET` routes under `/api/v1/` for scripts and home-automation systems.
- **The calendar feed**, one private `.ics` address per person for Google, Apple or Outlook Agenda.

Both only read. Nothing here can create, change or delete anything, and neither shows a person more than the app
shows them. This file is the contract: a test (`test/v1.test.ts`) compares the field names below with the real
responses.

**Examples that were not run.** The `curl` commands are the same calls the tests make over real HTTP. The Home
Assistant and Google Apps Script examples, and the way of subscribing in Google, Apple and Outlook Agenda, were
**written from the documentation of those products and never run on a real Home Assistant, a real Apps Script or a
real calendar app**. Check them on your own system before you rely on them.

## Access tokens

A personal access token belongs to one person. It acts as that person and as a member, never as an admin, even
when the person is an admin: it sees what the app shows that person (confirmed reservations of everybody, their own
suggestions and nothing of anybody else's pending ones, the monthly statistics every member sees, their own
kilometres and fuel balances). There are no admin or user-management routes under `/api/v1/` and never will be.

- **Make one** on the Account page, card *Toegangstokens*: give it a name (1 to 60 characters, to recognise it by) and
  press *Token maken*. At most **5** per person.
- **It is shown once**, in the sheet that follows. It looks like `pat_` and 43 more characters (256 bits). The app
  stores only its SHA-256 digest, so a lost token cannot be shown again: make a new one and revoke the old one.
- **It is only accepted on `/api/v1/`**, in the header `Authorization: Bearer <token>`. A session cookie does not
  work there, and a token does not work on any other route (so a token cannot make tokens, sign in or change anything).
  Never put a token in a URL.
- **It ends** when you revoke it (Account page, *Intrekken*), when an admin revokes it (admin page, Users tab), when
  your account is deactivated (reactivating does not bring it back) and when an admin resets your password. Changing
  your own password does **not** revoke your tokens.
- **Limits.** A token may make 60 requests a minute; past that, only that token gets `429` with `Retry-After`. A
  wrong, malformed or revoked token counts as a failed attempt for the client address (30 per 15 minutes, an IPv6
  address counts by its /64 like the login does); past that the address gets `429` with `Retry-After` **before
  anything is looked up**, so even a good token from that address is refused until the window passes. A request
  with no `Authorization` header at all is not counted. Several tools behind one address share that count.
- **Logging.** The server logs the id of a token and the client address, never the token, its digest or its name.

## Request and errors

Every route is `GET`, answers JSON (`Content-Type: application/json`, `Cache-Control: no-store`) and has no side
effect except that the time a token was last used is written, at most once an hour.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://YOUR-DOMAIN/api/v1/status"
```

An error is `{"error": {"code": "...", "message": "...", "fields": {...}}}`, the same shape as the rest of the app.
`message` is English and for developers; `fields` is only there for a bad query value. A `GET` is the only method
that exists here: any other method, and any other path under `/api/v1/`, is `404 not_found`.

- `401 unauthenticated`: no token, a malformed one, an unknown or revoked one, or the owner is deactivated. The answer
  has `WWW-Authenticate: Bearer`.
- `429 too_many_attempts`: too many failed attempts from this address. `Retry-After` is in seconds.
- `429 rate_limited`: this token made more than 60 requests in a minute. `Retry-After` is in seconds.
- `422 validation_failed`: a query value is wrong; `error.fields` has one code per parameter.
- `404 not_found`: no such route.

## `GET /api/v1/status`

Who has the car right now, who is next, and what is waiting. It follows the rule of the Start screen: an open drive
that started in the last 7 days means the car is on the road; otherwise the confirmed reservation that covers this
moment has it; otherwise it is free. (The Start screen looks 60 days ahead for the next reservation, this route looks
as far as the 6-month window.)

```json
{
  "now": "2026-06-15T10:00:00.000Z",
  "car": {
    "state": "reserved",
    "holder": { "id": 3, "name": "Ben" },
    "since": "2026-06-15T09:00:00.000Z",
    "until": "2026-06-15T11:00:00.000Z",
    "freeUntil": null
  },
  "next": { "id": 12, "userId": 2, "userName": "Anna", "start": "2026-06-16T09:00:00.000Z", "end": "2026-06-16T10:00:00.000Z" },
  "myNext": { "id": 12, "userId": 2, "userName": "Anna", "start": "2026-06-16T09:00:00.000Z", "end": "2026-06-16T10:00:00.000Z" },
  "kmToRegister": 1,
  "openDamage": 1,
  "apk": { "expiresOn": "2026-07-15", "daysLeft": 30, "updatedBy": { "id": 2, "name": "Anna" }, "updatedAt": "2026-06-01T08:00:00.000Z" }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `now` | string | The server time of the answer (UTC). |
| `car` | object | Who has the car. |
| `state` | string | `driving` (somebody has started a drive and not finished it), `reserved` (a confirmed reservation covers now) or `free`. |
| `holder` | object or null | `id` and `name` of the person who has it; `null` when it is free. |
| `since` | string or null | When the drive started or the reservation began (UTC); `null` when it is free. |
| `until` | string or null | When the reservation ends (UTC); `null` when it is free or somebody is on the road (no end is known). |
| `freeUntil` | string or null | While it is free: when the next confirmed reservation starts; `null` otherwise or when nothing is planned. |
| `next` | object or null | The next confirmed reservation after now, of anybody. |
| `myNext` | object or null | The first confirmed reservation of the token's owner that has not ended (one in progress counts). |
| `id` | number | Of a person (in `holder`, `updatedBy`) or of a reservation (in `next`, `myNext`). |
| `name` | string | A display name. |
| `userId` | number | Whose reservation it is. |
| `userName` | string | Their display name. |
| `start` | string | Start of the reservation (UTC). |
| `end` | string | End of the reservation (UTC). |
| `kmToRegister` | number | How many drives the owner still has to register (ended reservations without a registration in the last 14 days, and open drafts). The same number as `count` of `GET /api/usage/pending`. |
| `openDamage` | number | How many damage reports are still open. |
| `apk` | object | The APK date of the car. |
| `expiresOn` | string or null | `YYYY-MM-DD`; `null` while nobody has entered it. |
| `daysLeft` | number or null | Calendar days until it expires; negative when it has expired. |
| `updatedBy` | object or null | Who entered the date: `id` and `name`. |
| `updatedAt` | string or null | When (UTC). |

## `GET /api/v1/reservations`

The reservations the token's owner may see, exactly as `GET /api/reservations` shows a member, without the `can`
flags (they are for buttons). Confirmed reservations of everybody, and the owner's own other ones (suggestions made
by or for them, declined ones). Nobody else's pending suggestion is ever in it, not even for an admin's token.

Query (all optional): `from` and `to` (instants like `2026-06-01T00:00:00.000Z`, clamped to the 6-month window),
`status` (`confirmed`, `pending`, `declined` or `expired`) and `userId` (a number: whose reservations).

```json
{
  "items": [
    {
      "id": 12,
      "userId": 2,
      "userName": "Anna",
      "createdBy": 2,
      "createdByName": "Anna",
      "status": "confirmed",
      "suggestion": false,
      "start": "2026-06-16T09:00:00.000Z",
      "end": "2026-06-16T10:00:00.000Z",
      "note": "",
      "createdAt": "2026-06-10T08:00:00.000Z",
      "updatedAt": "2026-06-10T08:00:00.000Z",
      "drive": {
        "id": 4,
        "userId": 2,
        "userName": "Anna",
        "status": "completed",
        "odometerStart": 10000,
        "odometerEnd": 10050,
        "distanceKm": 50,
        "linked": true,
        "kmFor": "self",
        "kmUserId": null,
        "kmUserName": null
      },
      "kmState": "registered"
    }
  ],
  "window": { "from": "2025-12-15T11:00:00.000Z", "to": "2026-12-15T11:00:00.000Z" }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `items` | array | The reservations, by start time. |
| `window` | object | The range that was asked for, clamped to the window: `from` and `to` (UTC). |
| `id` | number | The reservation (and, in `drive`, the drive). |
| `userId` | number | Whose reservation it is. |
| `userName` | string | Their display name. |
| `createdBy` | number | Who made it; differs from `userId` for a suggestion. |
| `createdByName` | string | Their display name. |
| `status` | string | `confirmed`, `pending`, `declined`, or `expired` (a pending suggestion whose start has passed). |
| `suggestion` | boolean | True when somebody other than the driver made it. |
| `start` | string | Start (UTC). |
| `end` | string | End (UTC). |
| `note` | string | The note of the reservation (the app shows it to everybody who sees the reservation). |
| `createdAt` | string | When it was made (UTC). |
| `updatedAt` | string | When it last changed (UTC). |
| `drive` | object or null | The drive that registers it, a linked draft, or an older linked drive; `null` when there is none. |
| `status` | string | In `drive`: `draft` or `completed`. |
| `odometerStart` | number or null | In `drive`: the reading at the start. |
| `odometerEnd` | number or null | In `drive`: the reading at the end; `null` for a draft. |
| `distanceKm` | number or null | In `drive`: the difference, when both readings exist. |
| `linked` | boolean | In `drive`: linked to this reservation (true) or only overlapping it in time (false). |
| `kmFor` | string | In `drive`: whose kilometres: `self`, `person` or `together`. |
| `kmUserId` | number or null | In `drive`: for `person`, whose. |
| `kmUserName` | string or null | In `drive`: their display name. |
| `kmState` | string | `registered`, `draft` or `missing`. |

## `GET /api/v1/stats`

The monthly statistics, exactly what `GET /api/stats` answers (the same function, the same bytes, the same query
`from=YYYY-MM&to=YYYY-MM` and the same errors). The contract is in [STATS-API.md](STATS-API.md).

## `GET /api/v1/me`

The token owner's own numbers, and nobody else's.

```json
{
  "user": { "id": 2, "username": "anna", "displayName": "Anna" },
  "km": { "trips": 12, "tripsWithKm": 12, "km": 640, "window": { "from": "2025-12-15T11:00:00.000Z", "to": "2026-12-15T11:00:00.000Z" } },
  "fuel": {
    "owe": [{ "userId": 3, "userName": "Ben", "cents": 1250 }],
    "owed": [{ "userId": 4, "userName": "Carla", "cents": 4000 }],
    "oweTotalCents": 1250,
    "owedTotalCents": 4000
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `user` | object | The owner: `id`, `username` and `displayName`. |
| `username` | string | The sign-in name of the owner (the only username the API gives). |
| `displayName` | string | The name the app shows. |
| `km` | object | The owner's drives in the window. |
| `trips` | number | Finished drives the owner drove (kilometres that belong to somebody else count as a trip of the driver). |
| `tripsWithKm` | number | Of those, the ones with both odometer readings. |
| `km` | number | Kilometres that are the owner's (their own, and kilometres another driver registered as theirs; not the shared "together" pool). |
| `window` | object | The window the totals are over: `from` and `to` (UTC). |
| `fuel` | object | Who the owner owes money for fuel and who owes the owner, netted per person like the Fuel screen. |
| `owe` | array | People the owner owes: `userId`, `userName` and `cents`. |
| `owed` | array | People who owe the owner: `userId`, `userName` and `cents`. |
| `cents` | number | The amount in whole euro cents. |
| `oweTotalCents` | number | The sum of `owe`. |
| `owedTotalCents` | number | The sum of `owed`. |

An admin pays no fuel, so `owe` is always empty for an admin's token; `owed` still lists what others owe an admin who
filled the tank.

## Examples

`curl`, with the token in an environment variable so it does not end up in your shell history:

```bash
export TOKEN="paste-the-token-here"
curl -sS -H "Authorization: Bearer $TOKEN" "https://YOUR-DOMAIN/api/v1/status"
curl -sS -H "Authorization: Bearer $TOKEN" "https://YOUR-DOMAIN/api/v1/reservations?status=confirmed&from=2026-06-01T00:00:00.000Z"
curl -sS -H "Authorization: Bearer $TOKEN" "https://YOUR-DOMAIN/api/v1/stats?from=2026-01&to=2026-06"
curl -sS -H "Authorization: Bearer $TOKEN" "https://YOUR-DOMAIN/api/v1/me"
```

**Home Assistant** (a REST sensor; not run on a real Home Assistant). Put `car_token: "Bearer paste-the-token-here"` in
`secrets.yaml`, and in `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: Shared car
    resource: https://YOUR-DOMAIN/api/v1/status
    headers:
      Authorization: !secret car_token
    value_template: "{{ value_json.car.state }}"
    json_attributes:
      - car
      - next
      - myNext
      - kmToRegister
      - openDamage
      - apk
    scan_interval: 300
```

Every five minutes is far below the limit of 60 a minute. Keep it at a minute or more.

**Google Apps Script** (not run on a real Apps Script). Store the token under *Project settings > Script properties*
as `CAR_TOKEN`, not in the code:

```javascript
function carStatus() {
  const token = PropertiesService.getScriptProperties().getProperty('CAR_TOKEN');
  const response = UrlFetchApp.fetch('https://YOUR-DOMAIN/api/v1/status', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('The car API answered ' + response.getResponseCode());
  }
  const status = JSON.parse(response.getContentText());
  Logger.log(status.car.state + ', ' + status.kmToRegister + ' drive(s) still to register');
}
```

Google runs `UrlFetchApp` from shared addresses. Only failed attempts are counted per address, so a good token is
not affected by other people's scripts, but a token you revoked and a script that keeps polling with it will
count against that address.

## The calendar feed

Each person can have one private link that lists the car's reservations in a calendar app. Make it on the Account
page, card *Agenda-abonnement*: *Agendalink maken*, then copy the link and add it as a **subscription** (Google
Agenda: *Other calendars > From URL*; Apple Agenda: *File > New Calendar Subscription*; Outlook: *Add calendar >
Subscribe from web*). The link looks like `https://YOUR-DOMAIN/api/calendar/<43 characters>.ics`.

- **The link is the secret.** Anyone who has it can see when the car is reserved, and by whom, until it is replaced.
  *Nieuwe link maken* replaces it: the old link answers 404 at once. *Link uitzetten* turns the feed off. When a
  person is deactivated their link is deleted (reactivating does not bring it back).
- **Use the `https://` address only.** Some apps fetch a `webcal://` address over plain `http://` first, which would
  send the secret over the network unencrypted before the server redirects to `https://`. The app offers the
  `https://` address only; do not change it to `webcal://`.
- **What it lists:** every confirmed reservation in the 6-month window of everybody, as `CONFIRMED`, and the
  person's **own** suggestions that are still waiting for an answer and have not started (suggestions they made
  and ones made for them) as `TENTATIVE`. Declined, lapsed and deleted ones are not there. The summary says who
  (`Auto: Ben`, `Voorstel: Anna`). **No notes**, no odometer readings and no money: a calendar app is not as
  private as this app.
- **Format.** RFC 5545, `METHOD:PUBLISH`, UTC times only (`DTSTART:20260615T100000Z`, no time zone definitions),
  one `UID` per reservation (`reservation-<id>@gedeelde-auto`, the same for the life of the reservation),
  `LAST-MODIFIED` and `DTSTAMP` from the time the reservation last changed, the calendar name in `X-WR-CALNAME` and
  `NAME`, and refresh hints of one hour in `REFRESH-INTERVAL` and `X-PUBLISHED-TTL`. A reservation that is
  cancelled disappears from the feed.
- **Refresh.** Calendar apps decide for themselves how often they look again. **Google Calendar refreshes
  subscribed calendars slowly, a few times a day, and ignores the one-hour hint**, so a change can take hours to
  show. Apple Agenda and Outlook follow the hint more closely. Nothing here can speed Google up.
- **HTTP.** The body has a strong `ETag` (a digest of the body). A client that sends `If-None-Match` (one tag, a list,
  `*`, or a weak `W/"..."` tag) gets `304` with no body when nothing changed, and an edit changes the tag. `HEAD`
  works. The answer is `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- **Misses.** An address that was never made, one that was replaced, one of a deactivated person and one of the
  wrong shape all answer the same `404`, byte for byte as a path that does not exist. The attempts are counted per
  client address like failed tokens are (30 per 15 minutes, in a counter of their own), and past that the address
  gets `429` with `Retry-After` before anything is looked up.
- **The secret stays out of logs.** The app logs the path as `/api/calendar/[redacted]`, and the Caddyfile
  redacts it in anything Caddy writes (Caddy writes no access log today; its error log names request addresses).

## Not verified

Real calendar apps (Google, Apple, Outlook: the refresh behaviour above is documented knowledge, not something
measured here), a real Home Assistant, a real Apps Script, real phones, and the Caddy log filter on a running Caddy
(only `caddy validate` in CI, which checks the syntax and not what a running server writes).
