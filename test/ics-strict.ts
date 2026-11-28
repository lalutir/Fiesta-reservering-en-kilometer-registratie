// A strict, byte-level reader for the iCalendar (RFC 5545) subset the calendar feed writes. It is a test helper: the
// project has no iCal library and must not get one, so what the writer promises is checked by an independent reader
// that refuses everything the RFC refuses and a little more (it insists on the exact properties the feed has).
//
// It checks, in this order: the bytes are UTF-8 and every physical line is UTF-8 on its own (so a fold that splits a
// character is caught), CRLF only (no bare CR or LF) and a final CRLF, no physical line over 75 octets and no empty
// line, folding (a line that starts with a space or tab continues the one before), the shape of a content line
// (NAME;PARAM=value:value, upper-case names), BEGIN/END nesting, escaping of TEXT values, UTC date-times that are real
// moments, and the properties of the calendar and of every event.
export class IcsError extends Error {}

export interface IcsProp {
  params: Record<string, string>;
  /** The value as written (TEXT values are unescaped in `text`). */
  value: string;
  /** The unescaped value of a TEXT property; the same as `value` for the others. */
  text: string;
}

export type IcsProps = Map<string, IcsProp[]>;

export interface ParsedIcs {
  calendar: IcsProps;
  events: IcsProps[];
}

const TEXT_PROPS = new Set(['SUMMARY', 'X-WR-CALNAME', 'NAME']);
const CALENDAR_REQUIRED = ['VERSION', 'PRODID', 'CALSCALE', 'METHOD', 'X-WR-CALNAME', 'NAME', 'REFRESH-INTERVAL', 'X-PUBLISHED-TTL'];
const EVENT_REQUIRED = ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'STATUS', 'LAST-MODIFIED'];
const STATUSES = new Set(['CONFIRMED', 'TENTATIVE']);
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const CONTENT_LINE = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^";:,]*)(?:,(?:"[^"]*"|[^";:,]*))*)*):(.*)$/;
const PARAM = /;([A-Za-z0-9-]+)=((?:"[^"]*"|[^";:,]*)(?:,(?:"[^"]*"|[^";:,]*))*)/g;

const fail = (message: string): never => {
  throw new IcsError(message);
};

/** Bytes of the text between the CRLFs. */
function physicalLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d) {
      if (bytes[i + 1] !== 0x0a) fail(`a bare CR at byte ${i}`);
      lines.push(bytes.subarray(start, i));
      i++;
      start = i + 1;
    } else if (b === 0x0a) {
      fail(`a bare LF at byte ${i}`);
    }
  }
  if (start !== bytes.length) fail('the text does not end with CRLF');
  return lines;
}

/** Parse the escaped TEXT value; refuses an unknown escape and a bare semicolon or comma. */
export function unescapeText(value: string, where: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '\\') {
      const next = value[++i];
      if (next === 'n' || next === 'N') out += '\n';
      else if (next === '\\' || next === ';' || next === ',') out += next;
      else fail(`${where}: "\\${next ?? ''}" is not an escape of RFC 5545`);
    } else if (ch === ';' || ch === ',') {
      fail(`${where}: an unescaped "${ch}" in a text value`);
    } else {
      out += ch;
    }
  }
  return out;
}

function dateTime(value: string, where: string): number {
  const m = DATE_TIME.exec(value);
  if (!m) return fail(`${where}: "${value}" is not a UTC date-time (YYYYMMDDTHHMMSSZ)`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) {
    fail(`${where}: "${value}" is not a real moment`);
  }
  return ms;
}

const once = (props: IcsProps, name: string, where: string): IcsProp => {
  const list = props.get(name);
  if (!list || list.length === 0) return fail(`${where}: ${name} is missing`);
  if (list.length > 1) fail(`${where}: ${name} occurs ${list.length} times`);
  return list[0] as IcsProp;
};

export function parseIcs(input: Buffer | string): ParsedIcs {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (b: Buffer, what: string): string => {
    try {
      return decoder.decode(b);
    } catch {
      return fail(`${what} is not valid UTF-8`);
    }
  };
  decode(bytes, 'the text');
  const physical = physicalLines(bytes);
  if (physical.length === 0) fail('empty');

  // Octet length and UTF-8 of every physical line, then unfold.
  const logical: string[] = [];
  physical.forEach((line, index) => {
    if (line.length > 75) fail(`line ${index + 1} is ${line.length} octets (the limit is 75)`);
    if (line.length === 0) fail(`line ${index + 1} is empty`);
    const text = decode(line, `line ${index + 1}`); // a fold in the middle of a character fails here
    if (text.startsWith(' ') || text.startsWith('\t')) {
      if (logical.length === 0) fail('the first line is a continuation');
      logical[logical.length - 1] += text.slice(1);
    } else {
      logical.push(text);
    }
  });

  const stack: Array<'VCALENDAR' | 'VEVENT'> = [];
  let calendar: IcsProps | undefined;
  let event: IcsProps | undefined;
  const events: IcsProps[] = [];
  let finished = false;

  logical.forEach((line, index) => {
    const where = `content line ${index + 1}`;
    if (finished) fail(`${where}: content after END:VCALENDAR`);
    const m = CONTENT_LINE.exec(line);
    if (!m) return fail(`${where}: not a content line: ${line.slice(0, 40)}`);
    const name = m[1] as string;
    const rawParams = m[2] as string;
    const value = m[3] as string;
    if (name !== name.toUpperCase()) fail(`${where}: property names are upper case here (${name})`);
    if (/[^\P{Cc}\t]/u.test(value)) fail(`${where}: a control character in the value`);
    const params: Record<string, string> = {};
    for (const p of rawParams.matchAll(PARAM)) params[(p[1] as string).toUpperCase()] = p[2] as string;

    if (name === 'BEGIN') {
      if (value === 'VCALENDAR') {
        if (stack.length > 0 || calendar) fail(`${where}: a second or nested VCALENDAR`);
        stack.push('VCALENDAR');
        calendar = new Map();
      } else if (value === 'VEVENT') {
        if (stack.length !== 1) fail(`${where}: VEVENT outside VCALENDAR`);
        stack.push('VEVENT');
        event = new Map();
      } else fail(`${where}: unknown component ${value}`);
      return;
    }
    if (name === 'END') {
      const top = stack.pop();
      if (top !== value) fail(`${where}: END:${value} closes ${top ?? 'nothing'}`);
      if (value === 'VEVENT') {
        events.push(event as IcsProps);
        event = undefined;
      } else finished = true;
      return;
    }
    const target = stack.length === 2 ? event : stack.length === 1 ? calendar : undefined;
    if (!target) return fail(`${where}: ${name} outside a component`);
    if (index === 0) fail('the first line must be BEGIN:VCALENDAR');
    const prop: IcsProp = { params, value, text: TEXT_PROPS.has(name) ? unescapeText(value, `${where} (${name})`) : value };
    const list = target.get(name) ?? [];
    list.push(prop);
    target.set(name, list);
  });

  if (!calendar || !finished || stack.length > 0) fail('VCALENDAR is not closed');
  if (logical[0] !== 'BEGIN:VCALENDAR' || logical[logical.length - 1] !== 'END:VCALENDAR') fail('the text is not one VCALENDAR from first line to last');
  const cal = calendar as IcsProps;

  // The calendar.
  const exactly = (name: string, expected: string): void => {
    const p = once(cal, name, 'VCALENDAR');
    if (p.value !== expected) fail(`VCALENDAR: ${name} is "${p.value}", expected "${expected}"`);
  };
  for (const name of CALENDAR_REQUIRED) once(cal, name, 'VCALENDAR');
  exactly('VERSION', '2.0');
  exactly('CALSCALE', 'GREGORIAN');
  exactly('METHOD', 'PUBLISH');
  if (!/^-\/\/[^/]+\/\/[^/]+\/\/[A-Z]{2}$/.test(once(cal, 'PRODID', 'VCALENDAR').value)) fail('VCALENDAR: PRODID is not a formal public identifier');
  const refresh = once(cal, 'REFRESH-INTERVAL', 'VCALENDAR');
  if (refresh.params['VALUE'] !== 'DURATION' || !/^PT\d+H$/.test(refresh.value)) fail('VCALENDAR: REFRESH-INTERVAL must be a DURATION in hours');
  if (!/^PT\d+H$/.test(once(cal, 'X-PUBLISHED-TTL', 'VCALENDAR').value)) fail('VCALENDAR: X-PUBLISHED-TTL must be a duration in hours');
  for (const name of cal.keys()) if (!CALENDAR_REQUIRED.includes(name)) fail(`VCALENDAR: unexpected property ${name}`);
  if (once(cal, 'X-WR-CALNAME', 'VCALENDAR').text !== once(cal, 'NAME', 'VCALENDAR').text) fail('VCALENDAR: the two calendar names differ');

  // The events.
  const uids = new Set<string>();
  events.forEach((e, i) => {
    const where = `VEVENT ${i + 1}`;
    for (const name of EVENT_REQUIRED) once(e, name, where);
    for (const name of e.keys()) if (!EVENT_REQUIRED.includes(name)) fail(`${where}: unexpected property ${name}`);
    const uid = once(e, 'UID', where).value;
    if (/\s/.test(uid) || uid === '') fail(`${where}: UID "${uid}"`);
    if (uids.has(uid)) fail(`${where}: UID ${uid} is not unique`);
    uids.add(uid);
    for (const name of ['DTSTAMP', 'DTSTART', 'DTEND', 'LAST-MODIFIED']) {
      const p = once(e, name, where);
      if (Object.keys(p.params).length > 0) fail(`${where}: ${name} has parameters (${Object.keys(p.params).join(',')}): UTC only, no TZID, no VALUE`);
      dateTime(p.value, `${where} ${name}`);
    }
    if (dateTime(once(e, 'DTEND', where).value, where) <= dateTime(once(e, 'DTSTART', where).value, where)) fail(`${where}: DTEND is not after DTSTART`);
    if (!STATUSES.has(once(e, 'STATUS', where).value)) fail(`${where}: STATUS ${once(e, 'STATUS', where).value}`);
    if (once(e, 'SUMMARY', where).text.trim() === '') fail(`${where}: SUMMARY is empty`);
  });
  return { calendar: cal, events };
}

/** The first value (unescaped for text) of a property, for assertions. */
export const valueOf = (props: IcsProps, name: string): string => (props.get(name)?.[0] as IcsProp).text;
