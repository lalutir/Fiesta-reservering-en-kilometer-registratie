// A pure writer for the one iCalendar (RFC 5545) shape the calendar feed needs: a read-only list of events in UTC.
// No database, no http and no time zone database in here: it takes strings that are already UTC instants and turns
// them into lines, so everything it does can be checked against the RFC on its own (test/ics.test.ts, which also holds
// a strict reader that parses what this module writes).
//
// What the output is, on purpose:
// - CRLF line ends and a final CRLF; no line longer than 75 octets (longer ones are folded at a character boundary,
//   never in the middle of a UTF-8 character); text values escaped (backslash, semicolon, comma, newline).
// - METHOD:PUBLISH (a feed, not an invitation), UTC times with a trailing Z only (no VTIMEZONE, no TZID), one stable
//   UID per event, LAST-MODIFIED from the row, and DTSTAMP equal to it, so the body does not change between two
//   requests unless the data did (the ETag depends on it).
// - Refresh hints in both spellings calendar apps read (REFRESH-INTERVAL and X-PUBLISHED-TTL), a calendar name in both
//   (X-WR-CALNAME and NAME). No DESCRIPTION, LOCATION or ATTENDEE: nothing about a person beyond the summary.
const CRLF = '\r\n';

export type IcsStatus = 'CONFIRMED' | 'TENTATIVE';

export interface IcsEvent {
  /** Stable for the life of the record: the same record is the same event in every fetch. */
  uid: string;
  summary: string;
  /** UTC instant as stored: 2026-06-15T10:00:00.000Z. */
  start: string;
  end: string;
  /** When the record last changed (also written as DTSTAMP). */
  modified: string;
  status: IcsStatus;
}

export interface IcsCalendar {
  name: string;
  prodId: string;
  /** How often a client is asked to look again, in hours. */
  refreshHours: number;
  events: IcsEvent[];
}

/**
 * RFC 5545 TEXT escaping: backslash, semicolon and comma get a backslash and a newline becomes \n. Control
 * characters other than the tab and the newline have no place in a text value and become a space.
 */
export function escapeText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, '\n')
    .replace(/[^\P{Cc}\t\n]/gu, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Fold one content line at 75 octets (RFC 5545 3.1): each continuation starts with a single space, which counts
 * towards its 75. The line is cut between characters, never inside a multi-byte UTF-8 character.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

const UTC_MS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

/** 2026-06-15T10:00:00.000Z -> 20260615T100000Z. Anything but the app's own stored shape is refused. */
export function toIcsUtc(instant: string): string {
  const m = UTC_MS.exec(instant);
  if (!m) throw new RangeError(`Not a stored UTC instant: ${instant}`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
}

/** The whole calendar as the text of an .ics file. */
export function buildIcs(calendar: IcsCalendar): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${calendar.prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `NAME:${escapeText(calendar.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${calendar.refreshHours}H`,
    `X-PUBLISHED-TTL:PT${calendar.refreshHours}H`,
  ];
  for (const event of calendar.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${toIcsUtc(event.modified)}`,
      `DTSTART:${toIcsUtc(event.start)}`,
      `DTEND:${toIcsUtc(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `STATUS:${event.status}`,
      `LAST-MODIFIED:${toIcsUtc(event.modified)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
