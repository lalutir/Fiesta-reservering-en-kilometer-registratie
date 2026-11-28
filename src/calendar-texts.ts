// Every word of the calendar feed that a person reads in their calendar app (Dutch is the only interface language).
// Kept in one small module, like src/notify-texts.ts, so a text cannot hide in the feed code and the Dutch guard
// (test/dutch.test.ts) can read all of it. The feed never carries a note, a kilometre reading or an amount: a calendar
// app is not as private as this app, so it says who has the car and when, and nothing else.

/** The name of the calendar in the calendar app. */
export const CALENDAR_NAME = 'Gedeelde auto';

/** A confirmed reservation: who has the car. */
export const confirmedSummary = (person: string): string => `Auto: ${person}`;

/** A suggestion that is still waiting for an answer (shown as tentative): for whom the slot is. */
export const tentativeSummary = (person: string): string => `Voorstel: ${person}`;
