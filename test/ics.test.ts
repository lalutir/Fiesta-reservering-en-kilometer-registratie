// The pure iCalendar writer (src/ics.ts), and the strict reader that checks it (test/ics-strict.ts). The reader is only
// worth anything if it refuses what the RFC refuses, so half of this file is the reader being shown broken input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIcs, escapeText, foldLine, toIcsUtc, type IcsCalendar, type IcsEvent } from '../src/ics.ts';
import { IcsError, parseIcs, unescapeText, valueOf } from './ics-strict.ts';

const EVENT: IcsEvent = {
  uid: 'reservation-1@gedeelde-auto',
  summary: 'Auto: Ben',
  start: '2026-06-15T10:00:00.000Z',
  end: '2026-06-15T12:30:00.000Z',
  modified: '2026-06-10T08:15:30.000Z',
  status: 'CONFIRMED',
};
const CALENDAR: IcsCalendar = { name: 'Gedeelde auto', prodId: '-//Gedeelde auto//Agendafeed//NL', refreshHours: 1, events: [EVENT] };

const good = (): string => buildIcs(CALENDAR);

// ---------------------------------------------------------------------------- the writer

test('escapeText: backslash, semicolon, comma and newline are escaped, other control characters become a space', () => {
  assert.equal(escapeText('plain text'), 'plain text');
  assert.equal(escapeText('a,b;c\\d'), 'a\\,b\\;c\\\\d');
  assert.equal(escapeText('one\ntwo\r\nthree\rfour'), 'one\\ntwo\\nthree\\nfour');
  assert.equal(escapeText('tab\there'), 'tab\there', 'a tab is allowed in text');
  assert.equal(escapeText('a\u0000b\u0007c\u001fd\u007fe'), 'a b c d e');
  assert.equal(escapeText('Ünïcode € 😀'), 'Ünïcode € 😀');
  // Round trip through the strict reader's unescape: what goes in comes out (after the newline and control rules).
  for (const text of ['a,b;c\\d', 'x\\ny', 'ends with backslash\\', ';;,,\\\\', 'Jan, Piet; Klaas']) {
    assert.equal(unescapeText(escapeText(text), 'test'), text, JSON.stringify(text));
  }
});

test('toIcsUtc turns the stored instant into the iCalendar UTC form and refuses any other shape', () => {
  assert.equal(toIcsUtc('2026-06-15T10:00:00.000Z'), '20260615T100000Z');
  assert.equal(toIcsUtc('2026-03-29T00:30:00.000Z'), '20260329T003000Z');
  assert.equal(toIcsUtc('2026-12-31T23:59:59.000Z'), '20261231T235959Z');
  for (const bad of ['2026-06-15 10:00:00', '2026-06-15T10:00:00Z', '2026-06-15T10:00:00.000+02:00', '2026-06-15', '', '20260615T100000Z']) {
    assert.throws(() => toIcsUtc(bad), RangeError, JSON.stringify(bad));
  }
});

test('foldLine: a short line is left alone, a long one is folded at 75 octets, and a character is never cut in two', () => {
  assert.equal(foldLine('SUMMARY:short'), 'SUMMARY:short');
  const exactly75 = `SUMMARY:${'x'.repeat(67)}`;
  assert.equal(Buffer.byteLength(exactly75), 75);
  assert.equal(foldLine(exactly75), exactly75, '75 octets fit');
  const folded = foldLine(`${exactly75}y`);
  assert.deepEqual(folded.split('\r\n').map((l) => l.length), [75, 2], '76 octets are two lines; the second starts with the fold space');
  assert.ok(folded.endsWith('\r\n y'));

  // Every offset of a multi-byte character around both fold points, for 2, 3 and 4 byte characters.
  for (const ch of ['é', '€', '😀', '\u{1F468}‍\u{1F469}']) {
    for (let lead = 60; lead < 160; lead++) {
      const line = `SUMMARY:${'a'.repeat(lead)}${ch}${'b'.repeat(lead % 7)}${ch}end`;
      const out = foldLine(line);
      const physical = out.split('\r\n');
      for (const [i, p] of physical.entries()) {
        assert.ok(Buffer.byteLength(p) <= 75, `line ${i} of "${ch}" at ${lead} is ${Buffer.byteLength(p)} octets`);
        assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(p)), 'each physical line is UTF-8 on its own');
        if (i > 0) assert.ok(p.startsWith(' '));
      }
      assert.equal(physical.map((p, i) => (i === 0 ? p : p.slice(1))).join(''), line, 'unfolding gives the line back');
    }
  }
  // A very long line.
  const huge = `SUMMARY:${'é'.repeat(5000)}`;
  const hugeLines = foldLine(huge).split('\r\n');
  assert.ok(hugeLines.every((l) => Buffer.byteLength(l) <= 75));
  assert.ok(hugeLines.length > 130);
});

test('buildIcs writes the calendar the feed promises: CRLF, METHOD:PUBLISH, UTC, a stable UID, DTSTAMP = LAST-MODIFIED, both names and both refresh hints', () => {
  const text = good();
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(text.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(text), 'no bare LF');
  const parsed = parseIcs(text);
  assert.equal(parsed.events.length, 1);
  const e = parsed.events[0]!;
  assert.equal(valueOf(e, 'UID'), 'reservation-1@gedeelde-auto');
  assert.equal(valueOf(e, 'DTSTART'), '20260615T100000Z');
  assert.equal(valueOf(e, 'DTEND'), '20260615T123000Z');
  assert.equal(valueOf(e, 'DTSTAMP'), '20260610T081530Z');
  assert.equal(valueOf(e, 'LAST-MODIFIED'), valueOf(e, 'DTSTAMP'), 'DTSTAMP equals LAST-MODIFIED, so the body only changes when the data does');
  assert.equal(valueOf(e, 'STATUS'), 'CONFIRMED');
  assert.equal(valueOf(e, 'SUMMARY'), 'Auto: Ben');
  assert.equal(valueOf(parsed.calendar, 'X-WR-CALNAME'), 'Gedeelde auto');
  assert.equal(valueOf(parsed.calendar, 'NAME'), 'Gedeelde auto');
  assert.equal(parsed.calendar.get('REFRESH-INTERVAL')?.[0]?.value, 'PT1H');
  assert.equal(parsed.calendar.get('REFRESH-INTERVAL')?.[0]?.params['VALUE'], 'DURATION');
  assert.equal(valueOf(parsed.calendar, 'X-PUBLISHED-TTL'), 'PT1H');
  assert.equal(valueOf(parsed.calendar, 'METHOD'), 'PUBLISH');
  assert.doesNotMatch(text, /DESCRIPTION|LOCATION|ATTENDEE|ORGANIZER|TZID|VTIMEZONE/, 'nothing about a person beyond the summary, and no time zone');
  assert.equal(good(), text, 'the same input gives the same bytes');
});

test('a feed with no events, a tentative event and hostile names is still valid', () => {
  assert.equal(parseIcs(buildIcs({ ...CALENDAR, events: [] })).events.length, 0);
  const names = ['Ben, de ; baas\\', 'Zoë "de" Vries', 'Jan\nPiet', '😀'.repeat(60), 'é'.repeat(300), 'A'.repeat(500)];
  const events: IcsEvent[] = names.map((summary, i) => ({ ...EVENT, uid: `reservation-${i + 1}@gedeelde-auto`, summary, status: i % 2 === 0 ? 'CONFIRMED' : 'TENTATIVE' }));
  const text = buildIcs({ ...CALENDAR, name: 'Naam, met ; tekens', events });
  const parsed = parseIcs(text);
  assert.equal(parsed.events.length, names.length);
  assert.equal(valueOf(parsed.calendar, 'X-WR-CALNAME'), 'Naam, met ; tekens');
  assert.deepEqual(
    parsed.events.map((e) => valueOf(e, 'SUMMARY')),
    names.map((n) => n.replace(/\r\n|\r|\n/g, '\n')),
    'what a person typed comes back out of the calendar app as it was',
  );
  assert.deepEqual(parsed.events.map((e) => valueOf(e, 'STATUS')), ['CONFIRMED', 'TENTATIVE', 'CONFIRMED', 'TENTATIVE', 'CONFIRMED', 'TENTATIVE']);
});

// ------------------------------------------------------------- the strict reader, shown broken input

function refuses(label: string, text: string | Buffer, pattern: RegExp): void {
  assert.throws(() => parseIcs(text), (err: unknown) => err instanceof IcsError && pattern.test(err.message), `${label} must be refused with ${pattern}`);
}
const replaceOnce = (text: string, from: string, to: string): string => {
  assert.ok(text.includes(from), `the good feed has ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

test('the strict reader accepts the good feed and refuses a broken line ending', () => {
  assert.doesNotThrow(() => parseIcs(good()));
  assert.doesNotThrow(() => parseIcs(Buffer.from(good(), 'utf8')));
  refuses('LF only', good().replace(/\r\n/g, '\n'), /bare LF/);
  refuses('a lone CR', replaceOnce(good(), 'VERSION:2.0\r\n', 'VERSION:2.0\r'), /bare CR/);
  refuses('no final CRLF', good().slice(0, -2), /does not end with CRLF/);
  refuses('an empty line', replaceOnce(good(), 'VERSION:2.0\r\n', 'VERSION:2.0\r\n\r\n'), /is empty/);
  refuses('nothing at all', '', /empty/);
});

test('the strict reader refuses lines over 75 octets, a fold inside a UTF-8 character, and bytes that are not UTF-8', () => {
  refuses('a 100 octet line', replaceOnce(good(), 'SUMMARY:Auto: Ben', `SUMMARY:${'x'.repeat(100)}`), /octets/);
  // A fold that cuts the euro sign (E2 82 AC) after its first byte.
  const head = Buffer.from(`${good().split('SUMMARY:')[0]}SUMMARY:${'x'.repeat(66)}`, 'utf8');
  const split = Buffer.concat([head, Buffer.from([0xe2]), Buffer.from('\r\n ', 'latin1'), Buffer.from([0x82, 0xac]), Buffer.from(`\r\n${good().slice(good().indexOf('STATUS:'))}`, 'utf8')]);
  refuses('a fold splitting a character', split, /not valid UTF-8/);
  refuses('Latin-1 bytes', Buffer.concat([Buffer.from(good().replace('Auto: Ben', 'Auto: B'), 'utf8').subarray(0, 0), Buffer.from(good().replace('Auto: Ben', 'Auto: Bén'), 'latin1')]), /not valid UTF-8/);
  // A correct fold is fine: the writer's own output with a long summary.
  assert.doesNotThrow(() => parseIcs(buildIcs({ ...CALENDAR, events: [{ ...EVENT, summary: '€'.repeat(100) }] })));
  refuses('a continuation as the first line', ` x\r\n${good()}`, /first line is a continuation/);
});

test('the strict reader refuses bad text escaping', () => {
  refuses('an unescaped comma', replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:Auto, Ben'), /unescaped ","/);
  refuses('an unescaped semicolon', replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:Auto; Ben'), /unescaped ";"/);
  refuses('an unknown escape', replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:Auto\\x Ben'), /not an escape/);
  refuses('a trailing backslash', replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:Auto Ben\\'), /not an escape/);
  refuses('a control character', replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:Auto\u0001Ben'), /control character/);
  assert.doesNotThrow(() => parseIcs(replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:Auto\\, Ben\\; \\\\ \\n x')));
});

test('the strict reader refuses a broken structure and missing or extra properties', () => {
  refuses('no VERSION', replaceOnce(good(), 'VERSION:2.0\r\n', ''), /VERSION is missing/);
  refuses('VERSION 1.0', replaceOnce(good(), 'VERSION:2.0', 'VERSION:1.0'), /VERSION is "1.0"/);
  refuses('METHOD REQUEST', replaceOnce(good(), 'METHOD:PUBLISH', 'METHOD:REQUEST'), /METHOD/);
  refuses('no PRODID', replaceOnce(good(), 'PRODID:-//Gedeelde auto//Agendafeed//NL\r\n', ''), /PRODID is missing/);
  refuses('no refresh interval', replaceOnce(good(), 'REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n', ''), /REFRESH-INTERVAL is missing/);
  refuses('a refresh interval without VALUE=DURATION', replaceOnce(good(), 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'REFRESH-INTERVAL:PT1H'), /DURATION in hours/);
  refuses('no ttl', replaceOnce(good(), 'X-PUBLISHED-TTL:PT1H\r\n', ''), /X-PUBLISHED-TTL is missing/);
  refuses('two different names', replaceOnce(good(), 'NAME:Gedeelde auto', 'NAME:Iets anders'), /names differ/);
  refuses('lower-case property name', replaceOnce(good(), 'SUMMARY:', 'summary:'), /upper case/);
  refuses('a property that is not in the feed', replaceOnce(good(), 'STATUS:CONFIRMED', 'STATUS:CONFIRMED\r\nDESCRIPTION:a note'), /unexpected property DESCRIPTION/);
  refuses('an unknown calendar property', replaceOnce(good(), 'METHOD:PUBLISH', 'METHOD:PUBLISH\r\nX-OTHER:1'), /unexpected property X-OTHER/);
  refuses('an unclosed event', replaceOnce(good(), 'END:VEVENT\r\n', ''), /END:VCALENDAR closes VEVENT|not closed/);
  refuses('a nested event', replaceOnce(good(), 'UID:', 'BEGIN:VEVENT\r\nUID:'), /VEVENT outside VCALENDAR/);
  refuses('content after the end', `${good()}BEGIN:VCALENDAR\r\n`, /after END:VCALENDAR/);
  refuses('a second VCALENDAR', `${good().replace(/END:VCALENDAR\r\n$/, '')}BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nEND:VCALENDAR\r\n`, /second or nested VCALENDAR/);
  refuses('an unknown component', replaceOnce(good(), 'BEGIN:VEVENT', 'BEGIN:VTODO'), /unknown component/);
  refuses('a property outside a component', `X-A:1\r\n${good()}`, /outside a component/);
  refuses('not a content line', replaceOnce(good(), 'VERSION:2.0', 'VERSION 2.0'), /not a content line/);
});

test('the strict reader refuses an event without its required properties, a duplicate or an odd UID, and a status that is not allowed', () => {
  for (const name of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'STATUS', 'LAST-MODIFIED']) {
    const line = good().split('\r\n').find((l) => l.startsWith(`${name}:`)) as string;
    refuses(`no ${name}`, replaceOnce(good(), `${line}\r\n`, ''), new RegExp(`${name} is missing`));
  }
  refuses('UID twice', replaceOnce(good(), 'STATUS:CONFIRMED', 'STATUS:CONFIRMED\r\nUID:other'), /UID occurs 2 times/);
  const twoEvents = buildIcs({ ...CALENDAR, events: [EVENT, { ...EVENT }] });
  refuses('the same UID in two events', twoEvents, /is not unique/);
  refuses('a UID with a space', replaceOnce(good(), 'UID:reservation-1@gedeelde-auto', 'UID:reservation 1'), /UID "reservation 1"/);
  refuses('STATUS CANCELLED', replaceOnce(good(), 'STATUS:CONFIRMED', 'STATUS:CANCELLED'), /STATUS CANCELLED/);
  refuses('an empty summary', replaceOnce(good(), 'SUMMARY:Auto: Ben', 'SUMMARY:  '), /SUMMARY is empty/);
});

test('the strict reader refuses anything but UTC moments that are real and in order', () => {
  refuses('local time (no Z)', replaceOnce(good(), 'DTSTART:20260615T100000Z', 'DTSTART:20260615T100000'), /not a UTC date-time/);
  refuses('a date only', replaceOnce(good(), 'DTSTART:20260615T100000Z', 'DTSTART:20260615'), /not a UTC date-time/);
  refuses('a TZID', replaceOnce(good(), 'DTSTART:20260615T100000Z', 'DTSTART;TZID=Europe/Amsterdam:20260615T120000'), /has parameters/);
  refuses('VALUE=DATE', replaceOnce(good(), 'DTSTART:20260615T100000Z', 'DTSTART;VALUE=DATE:20260615T100000Z'), /has parameters/);
  refuses('month 13', replaceOnce(good(), 'DTSTART:20260615T100000Z', 'DTSTART:20261315T100000Z'), /not a real moment/);
  refuses('Feb 30', replaceOnce(good(), 'DTSTAMP:20260610T081530Z', 'DTSTAMP:20260230T081530Z'), /not a real moment/);
  refuses('hour 25', replaceOnce(good(), 'DTEND:20260615T123000Z', 'DTEND:20260615T253000Z'), /not a real moment/);
  refuses('the end before the start', replaceOnce(good(), 'DTEND:20260615T123000Z', 'DTEND:20260615T093000Z'), /DTEND is not after DTSTART/);
  refuses('the end equal to the start', replaceOnce(good(), 'DTEND:20260615T123000Z', 'DTEND:20260615T100000Z'), /DTEND is not after DTSTART/);
  assert.doesNotThrow(() => parseIcs(replaceOnce(good(), 'DTEND:20260615T123000Z', 'DTEND:20260615T100001Z')), 'one second is a valid event');
});

test('the writer refuses a time that is not a stored instant, so a malformed row cannot make a malformed feed', () => {
  assert.throws(() => buildIcs({ ...CALENDAR, events: [{ ...EVENT, start: '2026-06-15 10:00:00' }] }), RangeError);
  assert.throws(() => buildIcs({ ...CALENDAR, events: [{ ...EVENT, modified: 'yesterday' }] }), RangeError);
});
