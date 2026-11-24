# Design

How the member app (`public/`) and the admin page (`public/admin/`) look and behave, and why. The behaviour, the API,
the routes, the data and the business rules did not change with the redesign: this page is about the surface only.
The interface is Dutch (see [GLOSSARY.md](GLOSSARY.md)); this page is English like the rest of the documentation.

Contents: [Users and tasks](#users-and-tasks) · [Information architecture](#information-architecture) ·
[Identity and tokens](#identity-and-tokens) · [Components](#components) · [Generated-UI tells](#generated-ui-tells) ·
[UX standards](#ux-standards) · [Layouts](#layouts) · [Technology](#technology) · [Targets under 44 px](#targets-under-44-px) ·
[Decisions](#decisions) · [How it was checked](#how-it-was-checked) · [What was not tried](#what-was-not-tried)

## Users and tasks

Two to ten people in one household share one car. Everybody has a phone (Android or iPhone, installed from the browser,
no store). They open the app standing next to the car, in a hallway, in the car park, often with one hand and with
the sun on the screen. Some are not comfortable with software. The admin (one person) also sits at a desk.

The tasks, ranked by how often they happen and how bad it is when they go wrong:

| # | Task | Where it lives |
| --- | --- | --- |
| 1 | Reserve the car | the Boeken button, always one tap away |
| 2 | See who has the car now and who is next | Start (the first block) |
| 3 | Register kilometres: start before the drive, finish after | Start (answers waiting, km to register), Agenda card, Ritten |
| 4 | Log a fill-up | Ritten, then Brandstof en kosten; Start has a quick row |
| 5 | Answer a suggestion for a reservation | Start (answers waiting), Inbox under Meer |
| 6 | See what I owe, and mark it paid | Start (owed block), Historie |
| 7 | Report damage, check the APK date | Start (APK and damage blocks), Auto under Meer |
| 8 | Look back: who drove when, traffic tickets | Historie, Verkeersboetes under Ritten |
| 9 | Admin: users, corrections, retention | `/admin/`, a desktop page that also works on a phone |

## Information architecture

Seven tabs did not fit a phone: at 320 px each was 45 px wide with a 10 px label. The bar now has **five** places, and
everything else is at most **two taps** away.

| Place | Hash | What is under it |
| --- | --- | --- |
| Start | `#/home` | the at-a-glance screen (new); a bare launch (an empty hash) opens it |
| Agenda | `#/` | list, day, 3 days, week, month; the reservation cards |
| **Boeken** | `#/reserve` | the reservation form; raised, yellow, in the thumb zone |
| Ritten | `#/usage` | drive log, kilometre check; Brandstof en kosten (`#/fuel`) and Verkeersboetes (`#/tickets`) hang under it |
| Meer | `#/more` | Inbox, Historie, Auto, Account, the theme choice, Admin (admins), sign out |

Meer is a **page**, not a menu that pops up: Back works, the address can be shared, it needs no focus trap and no
second dialog. From 768 px the same links become a left rail that also lists everything that is under Meer, so there
the second tap disappears.

All old addresses keep their meaning (`#/`, `#/?view=&date=`, `#/reserve[/id]`, `#/inbox`, `#/usage?res=|edit=|gap=`,
`#/fuel`, `#/tickets`, `#/history`, `#/car`, `#/account`, `/admin/`) and so do the push deep links
(`test/nav.test.ts` loops over every URL the server can send). Routes were added (`#/home`, `#/more`), none were removed.
Only an **empty** hash opens Start; `#/` is still the Agenda, because the README, the calendar and the tests use that address.

## Identity and tokens

The look is **paper and ink with one signal colour**, chosen to read in sunlight and to not look like a template.

- **Paper** (`#f6f3ee`) is the page, **surface** (`#fffdf9`) the cards and fields, **ink** (`#1d1b17`) the text and the
  primary button. Dark is the same family turned over (`#14130f` page, `#f1ede4` text), not a grey-blue.
- **Signal yellow** (`#f2c230`) means two things only: *Boeken* and *the car is out right now*. It is never text on
  paper (1.5:1) and always has ink on it (10.3:1); in light it also has an ink outline, because yellow on paper is not a
  shape you can see (3:1 rule for UI components).
- **Status** is a marker plus a word ("Bevestigd", "Wacht op antwoord"), a coloured rule on the card, never colour alone.
- **Hairlines** (1 px, `--border`) carry the structure. Nothing has a soft shadow except what floats over the page: the
  sheet and the toast.
- **Type**: the system font stack (`system-ui`, so SF on an iPhone, Roboto on Android), `font-variant-numeric:
  tabular-nums` so kilometres and euros line up. Scale 12 / 14 / 16 / 18 / 22 / 28 px. No web font: see
  [Technology](#technology).
- **Space** 4 / 8 / 12 / 16 / 24 / 32 / 48, **radius** 4 / 8 / 12 (small on purpose: cards are not pills), **motion**
  120 and 200 ms with one easing curve, and nothing moves for decoration.
- **Dutch** is long: "Kilometerstand bij einde", "Brandstof en kosten", "Verkeersboetes". The page is `lang="nl"`;
  running text hyphenates (`hyphens: auto`), labels, buttons and navigation never do (`hyphens: manual`), and no width
  is a fixed pixel number.

All of it is one set of CSS custom properties in `public/style.css`: colour roles (light; dark twice, once for
`prefers-color-scheme` and once for a chosen `data-theme="dark"`, because `light-dark()` needs Safari 17.5 and the app
supports iOS 16.4), type, space, radius, elevation, motion. `test/design.test.ts` keeps the two dark blocks identical,
checks that every `var(--x)` is defined, and **computes the contrast of every text and component pair in both themes**
(text 4.5:1, components and focus 3:1).

**Theme**: Systeem (follows the phone, the default), Licht, Donker. The choice is kept in `localStorage` (in a
try/catch: storage can be blocked) and shown as `data-theme` on `<html>`; a three-line classic script
(`theme-init.js`) runs before the first paint so the other theme never flashes, and the `theme-color` meta (the colour of
the phone's status bar) follows. The control is on Meer and in the rail.

## Components

Written once in `public/ui.js` (with `public/icons.js` and `dom.js`), used by every view:

| Component | Notes |
| --- | --- |
| button, link button | variants primary (ink), secondary (outline), danger, ghost; 44 px; busy = disabled and `cursor: progress` |
| icon button | cannot be built without a label (it throws): the label is its name |
| list row | a link, a button or plain; icon, title, line under it, trailing value, chevron |
| field | label, control, hint, error; focus moves to the first invalid field after a refused save |
| sheet, drawer | a native `<dialog>` opened with `showModal()`: focus trap, Escape and focus return come from the browser; a bottom sheet on a phone, a centred dialog on a tablet, a side drawer for editing |
| confirm sheet | replaces `window.confirm`; the safe answer has focus; resolves a promise |
| segmented control | `aria-pressed` buttons: the agenda views, the theme choice |
| banner | tone (info, ok, warn, bad) as icon and words; `role="alert"` only for bad |
| empty state, error state, skeleton | every screen has all three; the error state has *Opnieuw proberen* |
| toast | one line, optionally with one action (*Ongedaan maken*) |

Icons are one set (Lucide, ISC licence, see [third-party.md](third-party.md)) drawn with `createElementNS`, `aria-hidden`,
`currentColor`. There are no emoji and no icon font.

## Generated-UI tells

What makes an interface look generated, and how each one is kept out. The test or the screenshot named is the evidence.

| Tell | In this app | Evidence |
| --- | --- | --- |
| Purple or blue gradients | none; flat paper, ink and one yellow | `design.test.ts`: no `gradient(` in the sheet |
| Glassmorphism, blur | none | `design.test.ts`: no `backdrop-filter`, no `blur(` |
| The same soft-shadow card everywhere | hairlines; a shadow only on the sheet and the toast | `design.test.ts`: `box-shadow` only from the two tokens (and the invalid-field edge) |
| Emoji as bullets or icons | one SVG icon set | `design.test.ts`: no emoji in `public/` |
| A centred hero with a greeting | Start opens on the car's state, left aligned, no greeting | `screenshots/after/home-*`, `home-view.test.ts` |
| Decorative blobs, orbs, grids | none | `design.test.ts` (no `radial-gradient`, no `filter`) and the screenshots |
| Pill overload | a status chip is a 4 px rectangle with a dot and a word; pills only for counts | `design.test.ts`: `--r-pill` only on badges and counts |
| Gratuitous animation | a 200 ms sheet entrance and a skeleton pulse; one `prefers-reduced-motion` block removes all of it | `design.test.ts` |
| Filler copy ("Welcome back!", "Oops!", lorem) | every text is a fact or an instruction, written for this app | `dutch.test.ts`, `docs/GLOSSARY.md` |
| Accent colour on everything | the signal yellow is allowed in exactly the rules for Boeken and "car is out" | `design.test.ts`: where `var(--accent)` may be used |

## UX standards

- **Targets** are at least 44 × 44 CSS px on a phone ([exceptions](#targets-under-44-px)); the thumb zone (bottom half)
  holds the navigation, Boeken and the primary button of a sheet.
- **Feedback** is inline: a field says what is wrong under itself and takes focus; a button is disabled while its request
  runs; a save answers with a toast.
- **Optimistic and undoable.** Deletes that tell nobody anything (your own damage report, an explanation in the
  kilometre check, your own open drive when the kilometres are yours) disappear at once and a toast offers
  *Ongedaan maken* for six seconds; the real `DELETE` is sent after that, when the page goes to the background (with
  `keepalive`), before the next write, and when you leave the screen (`public/undo.js`). Anything that **notifies
  someone** (declining, cancelling a reservation, deleting a ticket or a fill-up, a drive with other people's
  reservation) asks first in a confirm sheet: a notification cannot be called back.
- **Unsent input survives.** The reservation, drive, fill-up, ticket and damage forms keep what you typed, per person,
  only the fields you changed, only for new records, never a password, for seven days, cleared on save, discard and
  sign-out; blocked storage just means nothing is kept (`public/drafts.js`).
- **Inputs**: odometer `inputmode="numeric"`, price and litres `inputmode="decimal"` accepting a comma or a dot, the
  native date and time pickers, correct `autocomplete`. Parsing and the request bodies did not change.
- **States**: loading (a skeleton, shown only if it takes more than 120 ms, so a fast answer does not flash, and only where there is
  nothing to keep: a place you walked to, a retry, an empty page. Redrawing the same place after an action keeps what is
  on screen until the new page is ready, so the scroll position survives), empty
  (one sentence and what to do), error (what failed and *Opnieuw proberen*), and a part that fails alone (Start).
- **Motion** respects `prefers-reduced-motion`; **safe areas** (`env(safe-area-inset-*)`) are kept on the top bar, the tab
  bar, sheets and the toast; the 60-second refresh never rebuilds a page under an open sheet or a field you are typing in.
- **Focus** is always visible, and visible *where it is drawn*: one 3 px ring (`--focus`), drawn inside the edge for what
  sits in a box that clips (the rows of a list, the segments of a switcher: a ring outside them would be cut off), in the
  colour of the label on a segment that is filled (ink on ink is no ring), and in ink on the yellow of Boeken and of "the car
  is out" (in Donker `--focus` is that same yellow). `test/design.test.ts` pins each of these rules.
- **Pressed and hovered** states are real: the primary button is ink, the colour of the text, so it has its own step
  (`--primary-press`). The toast and its *Ongedaan maken* leave together, exactly when the delete is sent (also when it goes out early:
  the toast is withdrawn at that moment, unless another message has taken its place), and a faded-out toast keeps no button in
  the tab order.
- **WCAG 2.2 AA** is the floor: contrast is computed, names come from `public/strings.js`, headings are real headings,
  the skip link is the first tab stop.

## Layouts

| Width | Navigation | Content |
| --- | --- | --- |
| under 768 px (phone) | top bar (name of the app and of the person) and a bottom bar of five | one column, sheets rise from the bottom |
| 768 px and up (tablet) | a left rail: Boeken as a yellow button, all places, theme, person | one column up to 52 rem, Start in two columns, dialogs centred |
| 1024 px and up | the rail, wider | lists in two columns, a form beside its list (`.split`), drawers from the right |
| 1280 px and up | the rail | Start in three columns, content up to 78 rem |

The admin page is a desktop dashboard from 1024 px (a sidebar with the four sections, sortable and filterable tables,
edit forms in a drawer) and a stack of the same parts on a phone. It shares the tokens and the components, and it
stays a separate document: `/admin/*` is admin-only and outside the service worker.

## Technology

Options weighed (measured as the sum of each file compressed on its own, gzip level 9. Before the redesign, on
`origin/main`: 22 client modules, 256,240 B of JavaScript raw and 69,169 B gzip, 22,745 B of CSS raw and 6,616 B gzip.
After: 28 modules, 321,263 B raw and 106,077 B gzip, 38,730 B of CSS raw and 9,448 B gzip, and the admin page 37,597 B raw and
10,881 B gzip in 2 modules. The growth is the new modules (components, icons, navigation, Start, Meer, drafts, undo, theme)
and the longer sheet; there is still no request for a font and no framework):

| | Dependency-free (chosen) | Small framework with a build step |
| --- | --- | --- |
| Install and deploy | nothing: the server serves `public/` as it is | a build stage in the Dockerfile and in CI, on a 512 MB droplet |
| Tests | the views are imported straight into Node and run on a fake DOM | a different harness, all 5,000 lines of client tests rewritten |
| Server | zero runtime dependencies, kept | zero runtime dependencies, but a toolchain to keep updated |
| Size | no framework to ship | tens of kB of runtime added to what is already small |
| Risk | the DOM helper `h()` stays; components are plain functions | a rewrite of every view |

No measured win would pay for that, so there is no framework, no bundler and no build step. A native `<dialog>`,
custom properties, CSS grid, `:has()`-free selectors and `hyphens` do what the design needs on iOS 16.4 (the floor, because
web push needs it). Fonts: **the system stack**, deliberately: no request, no licence file, no layout shift, no
`.woff2` MIME entry, and the platform's own face is the one the person's eyes are used to. Weight and the paper-and-ink
palette carry the identity instead.

## Targets under 44 px

Listed here so the exceptions are decisions, not accidents. The browser run measured every link, button, field and summary on
every screen at 320 and 390 px (light and dark); these are the only ones under 44 by 44 CSS px:

- the month grid cells (38 by 52 px at 320 px and 390 px; above the WCAG 2.2 minimum of 24 px, and the whole cell is the
  target);
- the checkbox of "Ik heb gereden, maar de kilometers zijn niet van mij" (22 by 22 px): its label is the whole 44 px row and
  taps the box;
- links inside running text;
- the compact buttons of the admin tables on a pointer device (on a touch screen they are 44 px: `@media (pointer: coarse)`);
- the skip link, which is off screen until it has focus.

At 768 px and up (a pointer, not a thumb) the rail links are 44 px and the compact buttons of a card are 36 px.

## Decisions

- **Meer is a page (`#/more`), not a sheet.** A sheet needs a focus trap, closes without Back, and would be a dialog
  only for navigation. A page is a link like the others.
- **Boeken stays in the bar** instead of a floating button over the content: it is then reachable from every screen
  and never covers a form.
- **Yellow is rare.** If it were on every primary button it would stop meaning anything; the primary button is ink.
- **The orientation lock was removed** from the manifest: an installed app on a tablet must be allowed to be wide.
- **Sorting in the admin tables** compares lower-cased, accent-stripped keys, never `localeCompare` or `Intl.Collator`
  (the Dutch tests ban them: the result would depend on the device's locale).
- **Undo is a deferred commit**, not a soft delete: the API has no soft delete and must not get one for this. The DELETE goes
  out at the end of the six seconds, when the page is hidden or closed (the app and the admin page both install that flush),
  before the next write, and when the person walks to another place. Drawing the same place again (a refresh, the background
  render, the edit form back to the list) leaves it waiting, and whatever sends the delete early withdraws the toast, so
  "Ongedaan maken" is never offered for something already sent.
- **A background refresh never makes Start worse.** Start loads each block on its own, so a failed request would otherwise
  turn the landing screen into error blocks the moment the phone wakes up before its network does. `app.js` tells the view
  the render is silent; Start then draws a block whose request failed from its last good answer (kept per request and per
  person, thrown away by every visit, retry and redraw after an action). Only a block that never had an answer says so.
- **Legacy class names were kept** (`.card`, `.btn`, `.reservation`, ...), so what the views render and what the 1,000-odd
  client tests assert stayed the same while the look changed.

## How it was checked

Headless Chromium (a desktop browser with a phone viewport), never a phone:

- **Screens**: every screen and every admin tab at 320, 390, 768 and 1280 px in light and dark (152 screenshots), before
  (the untouched `origin/main`) and after, read side by side. No horizontal scroll, no clipped text (only visually hidden
  text), no console error, no failed or cross-origin request.
- **Accessibility**: the `a11y-audit` skill (its static scanner only sees the HTML shells, which are filled by script, so
  its landmark findings were checked against the running page; the admin page did lack a `<main>`, now fixed) and
  **axe-core 4.10 on all 152 screen/width/theme combinations: 0 violations** against WCAG 2.0 A/AA, 2.1 A/AA and 2.2 AA.
  axe found two real contrast failures on the way (the heading of the "car is out" block, and the Boeken label in the rail in
  the dark theme); both are fixed. Contrast is also computed from the sheet by `test/design.test.ts`.
- **Lighthouse 12** (mobile profile, simulated slow 4G), once against the Node server and once through a gzip proxy,
  because Caddy compresses in production and the Node server does not:

| Screen | Accessibility | Performance (Node, raw) | Performance (gzip) | LCP (gzip) | JS gzip | CSS gzip |
| --- | --- | --- | --- | --- | --- | --- |
| Inloggen | 100 | 86 | 99 | 2.1 s | 122.7 kB | 10.0 kB |
| Start | 100 | 86 | 98 | 2.3 s | 122.7 kB | 10.0 kB |
| Agenda | 100 | 86 | 98 | 2.1 s | 122.7 kB | 10.0 kB |
| Ritregistratie | 100 | 85 | 98 | 2.4 s | 122.7 kB | 10.0 kB |
| Brandstof en kosten | 100 | 86 | 98 | 2.2 s | 122.7 kB | 10.0 kB |
| Historie | 100 | 87 | 98 | 2.1 s | 122.7 kB | 10.0 kB |
| Auto | 100 | 86 | 98 | 2.1 s | 122.7 kB | 10.0 kB |
| Admin | 100 | 95 | 99 | 1.8 s | 66.6 kB | 10.0 kB |

  The performance target of 90 is met through the compression the production server (Caddy) applies, and missed (85 to 87,
  login and Start included) when the Node server is read directly, which is not how it is deployed. The sizes are what
  Lighthouse transferred (they include response headers of about 40 requests, which is why they are larger than the sums of
  the compressed files above). The loading is the one real cost of having no bundler: the modules are fetched as a tree.
  Lighthouse also reports "label-content-name-mismatch" as informational on the tabs that carry a count (their spoken name
  is "Ritten, 1 te registreren", which contains the visible word "Ritten"); the accessibility category stays at 100.
- **PWA**: Lighthouse 12 has no PWA category. The install facts are pinned from the files by `test/pwa.test.ts` (manifest names,
  standalone display, start URL, icons of the documented sizes with `any` and `maskable` purposes, a complete shell, and a
  precache list equal to the files in `public/`). Chromium's own installability check (`Page.getInstallabilityErrors`) was
  tried and is **not** evidence: headless Chromium answers an empty list for the real manifest, for `display: "browser"` and
  for a manifest without icons, so it could not have failed. Whether a phone offers *Add to Home Screen* was not verified.
  What a real browser did show, with the service worker enabled: the shell is precached (35 files, only `car-static-v8`
  left), the page loads offline from the worker with its style sheet and script, and shows the app's own "Je kunt de server
  niet bereiken" message with *Opnieuw proberen*, which brings the app back when the network returns.
- **Theme**: Systeem, Licht and Donker through the real page: `data-theme`, both `theme-color` metas and the page colour follow,
  a reload keeps Donker with no flash, and no request leaves the origin.
- **Tests**: `npm run check` (none skipped; the suite is longer than the 1,094-test baseline), `npm run e2e` (including a spec at
  768 and 1280 px), and mutation checks of the new rules (every one turned a test red). The counts are left out on purpose:
  they change with every test, and the run record has the ones of the final tree.

## What was not tried

Nothing here was tried on a real phone, in an installed Android or iOS app (the install check above is Chromium's), with real
push delivery, on iOS Safari at all, or with a screen reader (VoiceOver, TalkBack, NVDA). No contrast was judged by eye in
sunlight. Docker was not run locally; it runs in CI (the image and the compose file did not change). Lighthouse and axe were
run from outside the repository and are not part of `npm run check`.
