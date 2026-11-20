// One journey through the app, the way a household member uses it, at 390 px and 320 px:
// sign in, reserve the car, register the kilometres from the reservation card, look at the
// History, and load the admin page. Every step also asserts the page does not scroll sideways;
// the guard in ./fixtures.ts fails the test on console errors, uncaught errors, failed requests
// and error responses.
//
// Only getByRole, getByLabel and getByText are used (never CSS or XPath), so the suite survives a
// rebuilt frontend as long as people still see the same words. All the words are in UI below.
import { expect, expectNoHorizontalScroll, pastSlot, test } from './fixtures.ts';

/** What a person reads on screen (see public/strings.js). When the wording changes, change it here only. */
const UI = {
  appName: 'Shared car',
  username: 'Username',
  password: 'Password',
  signIn: 'Sign in',
  mainNav: 'Main',
  tabAgenda: 'Agenda',
  tabReserve: 'Reserve',
  tabHistory: 'History',
  newReservation: 'New reservation',
  fromDate: 'From: Date',
  fromTime: 'From: Time',
  untilDate: 'Until: Date',
  untilTime: 'Until: Time',
  note: 'Note (recommended)',
  reserve: 'Reserve',
  earlier: /^Earlier \(\d+\)$/,
  registerKm: 'Register km',
  registerDrive: 'Register a drive',
  odometerStart: 'Odometer at start (km)',
  odometerEnd: 'Odometer at end (km)',
  saveDrive: 'Save drive',
  kmRegistered: 'Km registered: 42 km',
  drivenByMe: 'Driven by me',
  history: 'History',
  admin: 'Admin',
  adminUsers: 'Users',
  adminReservations: 'Reservations',
} as const;

/**
 * Both projects use the same database, and two reservations may not overlap, so each project
 * reserves its own slot in the past ([hours ago it started, hours ago it ended]). A reservation
 * that already started is one whose "Register km" button is available at once.
 */
const SLOT_HOURS: Record<string, [number, number]> = {
  'mobile-390': [4, 3],
  'mobile-320': [8, 7],
};

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
    await page.waitForLoadState('networkidle');
  });
});
