# Dutch glossary

The interface is Dutch only (there is no language switcher). This page fixes the vocabulary and the tone, so every
screen, error sentence, push message and payment request says the same thing in the same words. The code, the logs,
the CLI, the README and the deployment guide stay in English; the English names in the table below are the names used
there.

Where the texts live:

- `public/strings.js`: every text the browser shows (the member app and the admin page).
- `src/notify-texts.ts`: every push message. `src/payments.ts`: the payment-request message and the Tikkie description.
- `public/sw.js`: two fallback texts for a push without a payload (the service worker cannot import the dictionary).
- `shared/format.js` writes amounts, litres and kilometres (`€ 12,50`, `40,5`, `45.210`); `shared/time.js` writes dates.

`test/dutch.test.ts` checks this page against the dictionary: every term in the "Use" column must occur in the texts,
and no term in the "Do not use" column may. Change a term here and in the texts together.

## Tone and voice

- Informal: "je" and "jouw", never "u". The app talks to one person ("Je hebt nog geen ritten"), also on the admin page,
  in error sentences and in push messages.
- Short sentences, no passive where an active one is just as short. No exclamation marks, no jokes.
- Buttons that are an action of the person themselves are first person ("Ik heb betaald", "Ik heb dit gereden").
  Other buttons are an infinitive ("Opslaan", "Verwijderen") or a short noun ("Annuleren").
- A person's name stands for them as it is stored. The word for "you" in a name slot depends on where it stands:
  `S.me` and `S.you` are "jou" and only go **behind a preposition** ("Gereden door jou", "Van jou aan Ben").
  `S.meLabel` is "jij" and is used where the name stands alone inside a sentence or in brackets ("Anna (jij)", "Laatst bekend: 45.210 km, jij, di 14:05").
  `S.meHead` is "Jij", the same word with a capital where it heads a card or a row next to the names of the others ("Jij" above a reservation, "Jij  150 km · 1 rit").
  Sentences are written so a name never has to be a subject and an object at once.
- Dates and times come from `Intl` with `nl-NL` in the household time zone: 24-hour clock, Monday first, lower-case
  weekday and month names ("maandag 16 november", "16 nov 2026, 14:05"). Amounts are written `€ 12,50` with a
  non-breaking space; litres `40,5`; price per litre `1,859`; kilometres `45.210`.
- A decimal field accepts a comma or a dot. It shows and prefills a comma, without a thousands dot.
- Words that stay as they are: APK, Tikkie, km, Admin, Inbox, Account, Agenda. The names of the menus of a phone are
  written as a Dutch phone shows them ("Deel", "Zet op beginscherm", "Installeer app").

## Vocabulary

The "Use" and "Do not use" columns are read by the test. Separate several terms with a comma; a term is matched
without regard to case, and a "Do not use" term only as a whole word.

| Concept | English name | Use | Do not use | Notes |
| --- | --- | --- | --- | --- |
| Reservation | reservation | reservering | boeking, reservatie | The verb is "reserveren". The tab is called "Boeken": "Reserveren" does not fit the tab bar at 320 px. |
| Suggestion for someone else | suggestion | voorstel | suggestie | The other person approves it ("goedkeuren") or declines it ("afwijzen"). |
| Approve, decline, withdraw | approve, decline, withdraw | goedkeuren, afwijzen, intrekken | accepteren, weigeren | |
| Drive | drive | rit | tocht | Tab: "Ritten". |
| Registering a drive | drive registration | ritregistratie | | The title of the form is "Ritregistratie"; the actions are "Rit opslaan" and "Kilometers registreren". |
| Odometer reading | odometer | kilometerstand | tellerstand | |
| Kilometre check | kilometre check | kilometercontrole | kilometercheck | |
| Kilometres nobody registered | gap | niet geregistreerd | | "45.210 km niet geregistreerd tussen ... en ...". |
| Two readings that contradict each other | mismatch | tegenstrijdig | mismatch | |
| Unfinished drive | draft | concept | klad | |
| Fill-up | fill-up | tankbeurt | tankstop, vulling | The verb is "tanken", past "getankt". Screen: "Brandstof en kosten". |
| Share of the fuel costs | share | aandeel | | |
| Payment request | payment request | betaalverzoek | betalingsverzoek | |
| "I have paid this request" | I have paid | Ik heb betaald | | The button of the person who owes the money. |
| Traffic ticket | traffic ticket | verkeersboete | bekeuring | |
| Damage report | damage report | schademelding | schaderapport | A "melding" on its own is a notification. |
| APK (inspection) | APK | APK | inspectie | Stays "APK"; the report of the inspection is the "keuringsrapport". |
| Tikkie | Tikkie | Tikkie | | Stays as it is. |
| Notification | notification | melding | notificatie | |
| Reminder | reminder | herinnering | reminder | |
| Note | note | notitie | opmerking | A note is "aanbevolen" (recommended) or "verplicht" (required). |
| Retention | retention | bewaartermijn | retentie | |
| Statistics | statistics | statistieken | | The screen under Ritten with the monthly totals as charts. |
| Monthly total | monthly total | maandtotaal | maandcijfer | The numbers of one month (kilometres, euros, counts). They are kept longer than the records behind them (24 months unless the server says otherwise). |
| Provisional | provisional | voorlopig | tijdelijk | The current month: its numbers still change. |
| Incomplete | incomplete | onvolledig | gedeeltelijk | A month of which a part was already deleted when its total was stored, so the numbers can be too low. |
| Stored (frozen) | frozen | vastgelegd | bevroren | A monthly total that is stored does not change any more, also when a drive or fill-up of that month is corrected afterwards. |
| Together (kilometres of the household) | together | samen | gezamenlijk | |
| History | history | historie | geschiedenis | Tab label; "Geschiedenis" does not fit. |
| Car | car | auto | wagen | |
| Admin | admin | admin | beheerder | The role and the page. The other role is "lid". |
| Member | member | lid | | |
| Inbox | inbox | Inbox | postvak | Stays as it is. |
| Time zone | time zone | tijdzone | | |
| Password | password | wachtwoord | | |
| Username | username | gebruikersnaam | | |
| Sign in, sign out | sign in | inloggen, uitloggen | aanmelden, afmelden | |
| Save | save | opslaan | bewaren | |
| Change (a saved item) | edit | wijzigen | bewerken | |
| Delete | delete | verwijderen | wissen | |
| Cancel (a form, or a reservation) | cancel | annuleren | | |
| Start screen | home | Start | Home, Thuis | The first place of the bar: the car now, what waits for you, what you owe. A launch with an empty address opens it. |
| The page for the rest | more | Meer | | The fifth place of the bar and its page: Inbox, Historie, Auto, Account, the theme, Admin, Uitloggen. |
| Theme | theme | Weergave, Systeem, Licht, Donker | thema | The choice between the phone's own setting (Systeem), always light (Licht) and always dark (Donker). |
| Unsent input | unsent input | niet-opgeslagen invoer | | What was typed in a form and not sent; it comes back when you return to the form. |
| Undo | undo | Ongedaan maken | | The button in the toast after a delete that tells nobody anything; it works for six seconds. |
| Access token | personal access token | toegangstoken | API-sleutel, toegangscode | A secret that lets a tool of your own (a script, a home-automation system) read the app as you. It is shown once; "intrekken" ends it. |
| Calendar link | calendar feed | agendalink | agendafeed, ics-link | The private address that a calendar app subscribes to. The card is called "Agenda-abonnement"; "Nieuwe link maken" replaces it and "Link uitzetten" turns it off. |
