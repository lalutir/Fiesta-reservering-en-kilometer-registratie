# Statistics API

`GET /api/stats` returns monthly totals for the household and for each person. It is read-only, the same for
every signed-in user, and versioned (`version`). The same document, byte for byte, is served at
`GET /api/v1/stats` to a personal access token (see [API.md](API.md)). This file is the contract: a test compares
the field names below with the real response.

Everything here is integers. Money is whole cents, volume whole millilitres, distance whole kilometres. Averages
are derived on read as integers with a fixed scale (see "Derived values"); nothing is a float.

## Request

`GET /api/stats?from=YYYY-MM&to=YYYY-MM`

- Needs a signed-in session (any role). Anonymous is `401`. There is no per-user filter: every user gets the
  same body, and the call writes nothing.
- `from` and `to` are calendar months in the household time zone, both ends included. Omitted `to` is the current
  month. Omitted `from` is eleven months before `to`, but never older than what is kept.
- An empty value (`?from=&to=`) counts as omitted, a repeated parameter uses its first value, and any other
  parameter is ignored. Only a value that is present and not a month is an error.
- What is kept is the current month and the months before it up to `retentionMonths` months in all (default 24,
  `STATS_RETENTION_MONTHS`, 6 to 120).
- Nothing is clamped silently. A bad range is `422` with `error.code` `validation_failed` and one code per field
  in `error.fields`:
  - `invalid_month`: not `YYYY-MM`, a month 00 or 13, or a year outside 2000 to 2100.
  - `in_future`: `to` is after the current month.
  - `after_to`: `from` is after `to`.
  - `outside_retention`: `from` or `to` is older than what is kept.

## Response

```json
{
  "version": 1,
  "timeZone": "Europe/Amsterdam",
  "windowMonths": 6,
  "retentionMonths": 24,
  "current": "2026-06",
  "range": { "from": "2026-05", "to": "2026-06" },
  "users": [{ "id": 2, "name": "Anna", "active": true }],
  "months": [
    {
      "month": "2026-05",
      "provisional": false,
      "frozen": false,
      "incomplete": false,
      "unavailable": false,
      "household": {
        "trips": 1,
        "km": 100,
        "togetherKm": 0,
        "fillUps": 0,
        "millilitres": 0,
        "paidCents": 0,
        "shareCents": 0,
        "costCents": 0,
        "costKm": 0,
        "poolKm": 0,
        "consumptionMl": 0,
        "consumptionKm": 0,
        "tickets": 0,
        "ticketCents": 0,
        "damageReports": 0,
        "unaccountedKm": 0,
        "totalKm": 100,
        "pricePerLitreMillis": null,
        "costPerKmMillis": null,
        "consumptionHundredths": null
      },
      "people": [
        {
          "userId": 2,
          "trips": 1,
          "km": 100,
          "togetherKm": 0,
          "fillUps": 0,
          "millilitres": 0,
          "paidCents": 0,
          "shareCents": 0,
          "costCents": 0,
          "costKm": 0,
          "poolKm": 0,
          "consumptionMl": 0,
          "consumptionKm": 0,
          "tickets": 0,
          "ticketCents": 0,
          "damageReports": 0,
          "unaccountedKm": 0,
          "totalKm": 100,
          "pricePerLitreMillis": null,
          "costPerKmMillis": null,
          "consumptionHundredths": null
        }
      ]
    }
  ]
}
```

### Top level

| Field | Meaning |
| --- | --- |
| `version` | Version of this contract. It changes only when a field is removed or changes meaning; new fields can appear without a new version. |
| `timeZone` | The household time zone (IANA name). Every month starts at local midnight in it. |
| `windowMonths` | The retention window of everything else in the app, in months (6). |
| `retentionMonths` | How many months of totals are kept, the current month included. |
| `current` | The current month, `YYYY-MM`. |
| `range` | The months in `months`: `from` and `to`, both included. |
| `users` | Everybody who ever had an account, so a number can always be given a name. Not filtered, and without roles. |
| `months` | One entry per month of the range, oldest first. |

`users` entries: `id`, `name` and `active` (false for a deactivated user, whose numbers stay in the totals).
`range` has `from` and `to`.

### A month

| Field | Meaning |
| --- | --- |
| `month` | `YYYY-MM`. |
| `provisional` | The current month: still being added to. |
| `frozen` | A stored total. It is never recomputed: a later correction of a drive or a fill-up in that month does not change it. |
| `incomplete` | The numbers are known to be short of what happened: they were cut short by a purge before they were stored, or the purge changed the live month. |
| `unavailable` | Nothing is known about this month: it is before the household existed, or it was purged before the statistics existed. `household` is `null` and `people` is empty. A month that is available and quiet reads zero. |
| `household` | The sum of every row of the month, including what belongs to nobody in particular (see "Attribution"). `null` for an unavailable month. |
| `people` | One entry per person who has anything in the month, by `userId`. The household-only items are in no person. |

### Totals (`household` and each entry of `people`)

The components are additive: two months or two people can be added field by field. `household` is the sum of the
rows of the month, so it equals the sum of `people` plus what belongs to nobody in particular.

| Field | Unit | Meaning |
| --- | --- | --- |
| `userId` | | Only in `people`: the person. |
| `trips` | count | Finished drives, to the driver. Open drafts are not trips. |
| `km` | km | Kilometres that are the person's: their own, and those another driver registered as theirs. Only drives with both readings count. |
| `togetherKm` | km | Kilometres registered as "together". Household only. |
| `fillUps` | count | Fill-ups, to the person who fuelled. |
| `millilitres` | ml | Fuel filled, to the person who fuelled. |
| `paidCents` | cents | Paid at the pump, to the person who fuelled. |
| `shareCents` | cents | What the person owes for the fill-ups of the month: the same shares as the Fuel screen. An admin has none. |
| `costCents` | cents | The part of `shareCents` that was split over kilometres (not the equal split of a period nobody drove in). |
| `costKm` | km | The person's own kilometres in those periods. |
| `poolKm` | km | Together kilometres of the periods that were split over kilometres. Household only. |
| `consumptionMl` | ml | Fuel of the fill-ups that have a measured interval. Household only. |
| `consumptionKm` | km | The kilometres of those intervals. Household only. |
| `tickets` | count | Traffic tickets, to the person the drive log and the reservations name as the driver; with nobody on record they are only in `household`. |
| `ticketCents` | cents | The prices of those tickets (a ticket without a price counts 0). |
| `damageReports` | count | Damage reports, to the person who filed them. |
| `unaccountedKm` | km | Open odometer gaps: kilometres that were driven but not registered. Household only. |
| `totalKm` | km | `km` plus `togetherKm`. |

### Derived values

Computed from the components, as whole numbers, rounded half up, `null` when there is nothing to divide by.

| Field | Scale | Formula |
| --- | --- | --- |
| `pricePerLitreMillis` | thousandths of a euro per litre (1859 is 1,859 EUR/L) | `paidCents * 10000 / millilitres` |
| `costPerKmMillis` | thousandths of a euro per kilometre (120 is 0,12 EUR/km) | `costCents * 10 / (costKm + poolKm)` |
| `consumptionHundredths` | hundredths of a litre per 100 km (650 is 6,50 L/100 km) | `consumptionMl * 10 / consumptionKm` |

Consumption assumes every fill-up fills the tank: the litres of a fill-up are what was used since the previous
one. It uses two consecutive fill-ups (in the full order) that both have an odometer reading and a positive
distance between them, and counts the litres of the later one, in the month of the later one. Anything else
leaves the interval out.

## Attribution

One rule, in the household time zone. A month starts at local midnight.

| Record | Month | Person |
| --- | --- | --- |
| Drive | The month it started in, also when it ends in the next one. | Trips: the driver. Kilometres: whose they are (own, another person's, or together). |
| Fill-up | Its own month, and everything derived from it: litres, euros, shares, the kilometres they were split over, and the consumption interval that ends at it. | Fuel and euros: the person who fuelled. Shares and their kilometres: the person who pays. |
| Traffic ticket | The month of the offence. | The driver that the drive log and the reservations name (the same as the tickets screen), else nobody. |
| Damage report | The month of the day it was noticed. | The person who filed it. |
| Odometer gap | The month of its later reading. | Nobody: household only. |

Fuel numbers are the numbers of the Fuel screen, summed per month: the admin pays nothing and his own kilometres are
left out of the split, the together pool follows the ratio of the personal kilometres, a period nobody drove in is
split equally over the people who pay, and a deactivated user with kilometres still pays for them. Drafts never count.
A finished drive without both readings is a trip and adds no kilometres.

## Retention

Every record in the app is kept for the 6-month window and then deleted. The monthly totals are the exception: they
are numbers only (counts, cents, millilitres, kilometres, no time of an event, no note, no id of a record) and are kept for
`retentionMonths` months.

- The live months are computed from the records. `frozen` months are read from the table.
- Only the purge writes a stored month. In the same transaction, before it deletes the rows, it stores every month
  whose numbers it is about to change, from the numbers just before the delete. That includes a month whose own rows
  stay (a fill-up whose earlier fill-up is purged gets a shorter period and other shares) and a month that lies wholly
  before the cutoff. The current month is never stored; if a purge changes it, it is flagged `incomplete`.
- If storing fails the whole purge rolls back: no record is deleted without its totals. The next maintenance tick retries.
- A stored month is never recomputed. A correction of a drive or a fill-up in a month that is already stored does not change its totals.
- Totals older than `retentionMonths` are deleted by the next purge. Raising the setting later restores nothing.

### First deploy

Nothing is back-filled and nothing is invented. At the first purge after the upgrade, months that were already
partly purged are stored once from the rows that are left and flagged `incomplete`. Months with nothing in them that
lie before the household existed, or in the part that was purged before the statistics existed, are `unavailable`,
not zero.
