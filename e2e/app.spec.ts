// One journey through the app, the way a household member uses it, at 390 px and 320 px:
// sign in, reserve the car, register the kilometres from the reservation card, look at the
// History, see the Kilometre check on the Drives tab, find that a fill-up needs its odometer
// reading, see the APK prompt and the damage form on the Car tab, and load the admin page (Users,
// Reservations and Drives). All seven tabs must fit the bar. Every step also asserts the page does not scroll sideways;
// the guard in ./fixtures.ts fails the test on console errors, uncaught errors, failed requests
// and error responses.
//
// Only getByRole, getByLabel and getByText are used (never CSS or XPath), so the suite survives a
// rebuilt frontend as long as people still see the same words. All the words are in UI below (the
// interface is Dutch).
import { NAV_NAME, expect, expectNoHorizontalScroll, expectTabsFit, pastSlot, test } from './fixtures.ts';

/** What a person reads on screen (see public/strings.js). When the wording changes, change it here only. */
const UI = {
  appName: 'Gedeelde auto',
  username: 'Gebruikersnaam',
  password: 'Wachtwoord',
  signIn: 'Inloggen',
  mainNav: NAV_NAME,
  tabAgenda: 'Agenda',
  tabReserve: 'Boeken',
  tabHistory: 'Historie',
  tabDrives: /^Ritten/,
  tabCar: 'Auto',
  tabAccount: 'Account',
  car: 'Auto',
  apkNotSet: 'De vervaldatum van de APK is nog niet ingevoerd.',
  reportDamage: 'Schade melden',
  dateNoticed: 'Datum eerst opgemerkt',
  whereOnCar: 'Waar op de auto',
  damageDescription: 'Beschrijving',
  noDamage: 'Nog geen schademeldingen. Maak de eerste met het formulier hierboven.',
  newReservation: 'Nieuwe reservering',
  fromDate: 'Van: Datum',
  fromTime: 'Van: Tijd',
  untilDate: 'Tot: Datum',
  untilTime: 'Tot: Tijd',
  note: 'Notitie (aanbevolen)',
  reserve: 'Reserveren',
  earlier: /^Eerder \(\d+\)$/,
  registerKm: 'Kilometers registreren',
  registerDrive: 'Ritregistratie',
  odometerStart: 'Kilometerstand bij start (km)',
  odometerEnd: 'Kilometerstand bij einde (km)',
  saveDrive: 'Rit opslaan',
  kmRegistered: 'Km geregistreerd: 42 km',
  drivenByMe: 'Gereden door jou',
  kmCheck: /Kilometercontrole/,
  fuelLink: 'Brandstof en kosten',
  fuelOdometer: 'Huidige kilometerstand (km)',
  litres: 'Liters',
  totalPrice: 'Totaalprijs (€)',
  saveFillUp: 'Tankbeurt opslaan',
  required: 'Verplicht.',
  history: 'Historie',
  admin: 'Admin',
  adminUsers: 'Gebruikers',
  adminReservations: 'Reserveringen',
  adminDrives: 'Ritten',
} as const;

/** The seven tabs of the bar, by the words on them (a count may follow the name; see expectTabsFit). */
const ALL_TABS = [UI.tabAgenda, UI.tabReserve, 'Inbox', 'Ritten', UI.tabHistory, UI.tabCar, UI.tabAccount];

/**
 * Both projects use the same database, and two reservations may not overlap, so each project
 * reserves its own slot in the past ([hours ago it started, hours ago it ended]). A reservation
 * that already started is one whose "Register km" button is available at once.
 */
const SLOT_HOURS: Record<string, [number, number]> = {
  'mobile-390': [4, 3],
  'mobile-320': [8, 7],
};

/** The words of the screens that only read (nothing is created): see public/strings.js. */
const SCREENS = {
  inboxTab: 'Inbox',
  inboxIncoming: 'Wacht op jouw antwoord',
  accountTitle: 'Account',
  signOut: 'Uitloggen',
  ticketsLink: 'Verkeersboetes',
  ticketsList: 'Alle verkeersboetes',
  adminRetentionTab: 'Bewaartermijn',
  adminRetention: 'Bewaartermijn en back-ups',
} as const;

test('the other screens fit the phone: Inbox, Account, Traffic tickets and the admin Retention tab', async ({ page }) => {
  const username = process.env['E2E_ADMIN_USERNAME'] ?? '';
  const password = process.env['E2E_ADMIN_PASSWORD'] ?? '';
  expect(username !== '' && password !== '', 'the config exports the admin sign-in').toBe(true);
  const mainNav = page.getByRole('navigation', { name: NAV_NAME });

  await page.goto('/');
  await page.getByLabel(UI.username).fill(username);
  await page.getByLabel(UI.password, { exact: true }).fill(password);
  await page.getByRole('button', { name: UI.signIn }).click();
  await expect(mainNav).toBeVisible();

  await test.step('Inbox', async () => {
    await mainNav.getByRole('link', { name: SCREENS.inboxTab }).click();
    await expect(page.getByRole('heading', { name: SCREENS.inboxIncoming })).toBeVisible();
    await expectNoHorizontalScroll(page, 'inbox');
  });

  await test.step('Account', async () => {
    await mainNav.getByRole('link', { name: UI.tabAccount, exact: true }).click();
    await expect(page.getByRole('heading', { name: SCREENS.accountTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: SCREENS.signOut })).toBeVisible();
    await expectNoHorizontalScroll(page, 'account');
    await expectTabsFit(page, 'tab bar on the Account tab', ALL_TABS);
  });

  await test.step('Traffic tickets', async () => {
    await mainNav.getByRole('link', { name: UI.tabDrives }).click();
    await page.getByRole('link', { name: SCREENS.ticketsLink }).click();
    await expect(page.getByRole('heading', { name: SCREENS.ticketsList })).toBeVisible();
    await expectNoHorizontalScroll(page, 'traffic tickets');
  });

  await test.step('the admin Retention tab', async () => {
    // Leave no request in flight when the page is replaced: an aborted request is a failed request.
    await page.waitForLoadState('networkidle');
    await page.goto('/admin/');
    await page.getByRole('button', { name: SCREENS.adminRetentionTab, exact: true }).click();
    await expect(page.getByRole('heading', { name: SCREENS.adminRetention })).toBeVisible();
    await expectNoHorizontalScroll(page, 'admin retention');
    await page.waitForLoadState('networkidle');
  });
});

test('sign in, reserve, register km from the card, open History and the admin page', async ({ page }, testInfo) => {
  const hours = SLOT_HOURS[testInfo.project.name];
  if (!hours) throw new Error(`no reservation slot for project ${testInfo.project.name}`);
  const slot = pastSlot(hours[0], hours[1]);
  // Unique per project and run, so the card can be found by what a person typed.
  const note = `E2E trip ${testInfo.project.name} ${Date.now()}`;
  const username = process.env['E2E_ADMIN_USERNAME'] ?? '';
  const password = process.env['E2E_ADMIN_PASSWORD'] ?? '';
  expect(username !== '' && password !== '', 'the config exports the admin sign-in').toBe(true);

  const mainNav = page.getByRole('navigation', { name: UI.mainNav });
  const reservationCard = () => page.getByRole('article').filter({ hasText: note });

  await test.step('the sign-in screen fits the phone', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: UI.appName })).toBeVisible();
    await expect(page.getByLabel(UI.username)).toBeVisible();
    await expectNoHorizontalScroll(page, 'sign-in screen');
  });

  await test.step('sign in', async () => {
    await page.getByLabel(UI.username).fill(username);
    await page.getByLabel(UI.password, { exact: true }).fill(password);
    await page.getByRole('button', { name: UI.signIn }).click();
    await expect(mainNav).toBeVisible();
  });

  await test.step('all seven tabs fit in the bar', async () => {
    await expectTabsFit(page, 'tab bar', ALL_TABS);
    await expectNoHorizontalScroll(page, 'tab bar');
  });

  await test.step('create a reservation', async () => {
    await mainNav.getByRole('link', { name: UI.tabReserve, exact: true }).click();
    await expect(page.getByRole('heading', { name: UI.newReservation })).toBeVisible();
    await page.getByLabel(UI.fromDate, { exact: true }).fill(slot.start.date);
    await page.getByLabel(UI.fromTime, { exact: true }).fill(slot.start.time);
    await page.getByLabel(UI.untilDate, { exact: true }).fill(slot.end.date);
    await page.getByLabel(UI.untilTime, { exact: true }).fill(slot.end.time);
    await page.getByLabel(UI.note).fill(note);
    await expectNoHorizontalScroll(page, 'reservation form');
    await page.getByRole('button', { name: UI.reserve, exact: true }).click();
  });

  await test.step('the reservation is on the agenda with a Register km link', async () => {
    // It lies in the past, so it is listed under "Earlier", which is collapsed.
    await page.getByText(UI.earlier).click();
    await expect(reservationCard()).toBeVisible();
    await expect(reservationCard().getByRole('link', { name: UI.registerKm })).toBeVisible();
    await expectNoHorizontalScroll(page, 'agenda');
  });

  await test.step('register km from the reservation card', async () => {
    await reservationCard().getByRole('link', { name: UI.registerKm }).click();
    await expect(page.getByRole('heading', { name: UI.registerDrive })).toBeVisible();
    await page.getByLabel(UI.odometerStart).fill('1000');
    await page.getByLabel(UI.odometerEnd).fill('1042');
    await expectNoHorizontalScroll(page, 'register drive form');
    await page.getByRole('button', { name: UI.saveDrive }).click();
    // The saved drive is in the list, with its distance.
    await expect(reservationCard()).toContainText('42 km');
  });

  await test.step('the reservation card now shows the registered km', async () => {
    await mainNav.getByRole('link', { name: UI.tabAgenda, exact: true }).click();
    await page.getByText(UI.earlier).click();
    await expect(reservationCard()).toContainText(UI.kmRegistered);
    await expect(reservationCard().getByRole('link', { name: UI.registerKm })).toHaveCount(0);
  });

  await test.step('open History', async () => {
    await mainNav.getByRole('link', { name: UI.tabHistory, exact: true }).click();
    await expect(page.getByRole('heading', { name: UI.history })).toBeVisible();
    await expect(reservationCard()).toContainText(UI.drivenByMe);
    await expectNoHorizontalScroll(page, 'history');
  });

  await test.step('the Drives tab shows the kilometre check', async () => {
    // The drive registered above is a reading, so there is something to check (and it never takes more room than the phone has).
    await mainNav.getByRole('link', { name: UI.tabDrives }).click();
    await expect(page.getByRole('heading', { name: UI.registerDrive })).toBeVisible();
    await expect(page.getByRole('heading', { name: UI.kmCheck })).toBeVisible();
    await expectNoHorizontalScroll(page, 'drives with the kilometre check');
  });

  await test.step('a fill-up cannot be saved without the odometer reading', async () => {
    await page.getByRole('link', { name: UI.fuelLink }).click();
    await expect(page.getByLabel(UI.fuelOdometer)).toBeVisible();
    await page.getByLabel(UI.litres, { exact: true }).fill('40');
    await page.getByLabel(UI.totalPrice, { exact: true }).fill('60');
    // Nothing may be sent: the app says what is missing itself. (Creating a fill-up here would leave data in the
    // database both projects share, and the drives above already depend on it being tidy.)
    let sent = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/fuel') sent++;
    });
    await page.getByRole('button', { name: UI.saveFillUp }).click();
    await expect(page.getByText(UI.required, { exact: true })).toBeVisible();
    expect(sent, 'no fill-up request without the reading').toBe(0);
    await expectNoHorizontalScroll(page, 'fill-up form with the odometer');
  });

  await test.step('the Car tab asks for the APK date and offers the damage form (nothing is saved here)', async () => {
    // Nothing is created: both projects share one database, and the APK date and the damage list are shared by everybody.
    await mainNav.getByRole('link', { name: UI.tabCar, exact: true }).click();
    await expect(page.getByRole('heading', { name: UI.car, exact: true })).toBeVisible();
    await expect(page.getByText(UI.apkNotSet, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: UI.reportDamage })).toBeVisible();
    await expect(page.getByLabel(UI.dateNoticed)).toBeVisible();
    await expect(page.getByLabel(UI.whereOnCar)).toBeVisible();
    await expect(page.getByLabel(UI.damageDescription, { exact: true })).toBeVisible();
    await expect(page.getByText(UI.noDamage, { exact: true })).toBeVisible();
    // With the Car tab current, every label still fits its tab.
    await expect(mainNav.getByRole('link', { name: UI.tabCar, exact: true })).toHaveAttribute('aria-current', 'page');
    await expectTabsFit(page, 'tab bar on the Car tab', ALL_TABS);
    await expectNoHorizontalScroll(page, 'car');
  });

  await test.step('load the admin page', async () => {
    // Leave no request in flight when the page is replaced: an aborted request is a failed request.
    await page.waitForLoadState('networkidle');
    await page.goto('/admin/');
    await expect(page.getByRole('heading', { name: UI.admin, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: UI.adminUsers, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: UI.adminReservations, exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page, 'admin users');
    await page.getByRole('button', { name: UI.adminReservations, exact: true }).click();
    await expect(page.getByText(note)).toBeVisible();
    await expectNoHorizontalScroll(page, 'admin reservations');
    // The same check as on the Drives tab of the app.
    await page.getByRole('button', { name: UI.adminDrives, exact: true }).click();
    await expect(page.getByRole('heading', { name: UI.kmCheck })).toBeVisible();
    await expectNoHorizontalScroll(page, 'admin drives');
    await page.waitForLoadState('networkidle');
  });
});
