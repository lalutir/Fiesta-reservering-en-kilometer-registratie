import { HttpError } from './http.ts';
import { addCalendarMonths, daysInMonth } from '../shared/time.js';

/** 422 with one code per offending field, e.g. { start: 'outside_window' }. */
export class ValidationError extends HttpError {
  constructor(fields: Record<string, string>, code = 'validation_failed') {
    super(422, code, 'Validation failed', { fields });
  }
}

/** Throw a ValidationError when at least one field has an error. */
export function failIfAny(fields: Record<string, string>, code?: string): void {
  if (Object.keys(fields).length > 0) throw new ValidationError(fields, code);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Strict ISO 8601 instant with an explicit zone (Z or +hh:mm), normalised to a
 * UTC string with milliseconds. Returns undefined when it is not valid.
 */
export function parseInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_RE.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (year < 2000 || year > 2100) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const offset = m[8] as string;
  if (offset !== 'Z') {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return undefined;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export interface StringOpts {
  min?: number;
  max?: number;
  optional?: boolean;
  trim?: boolean;
}

export interface IntOpts {
  min?: number;
  max?: number;
  optional?: boolean;
}

/**
 * Collects field errors over one request body so the client sees all of them
 * at once; call done() to throw if there were any.
 */
export class Fields {
  errors: Record<string, string> = {};
  input: Record<string, unknown>;

  constructor(input: Record<string, unknown>) {
    this.input = input;
  }

  has(key: string): boolean {
    return this.input[key] !== undefined;
  }

  fail(key: string, code: string): void {
    this.errors[key] ??= code;
  }

  /** The raw value; absent (undefined) is an error unless the field is optional. */
  private take(key: string, optional: boolean | undefined): unknown {
    const raw = this.input[key];
    if (raw === undefined && !optional) this.fail(key, 'required');
    return raw;
  }

  string(key: string, opts: StringOpts = {}): string | undefined {
    const raw = this.take(key, opts.optional);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
      this.fail(key, 'must_be_string');
      return undefined;
    }
    const value = opts.trim === false ? raw : raw.trim();
    if (value.length < (opts.min ?? 0)) {
      this.fail(key, value.length === 0 ? 'required' : 'too_short');
      return undefined;
    }
    if (value.length > (opts.max ?? 10_000)) {
      this.fail(key, 'too_long');
      return undefined;
    }
    return value;
  }

  int(key: string, opts: IntOpts = {}): number | undefined {
    const raw = this.take(key, opts.optional);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      this.fail(key, 'must_be_integer');
      return undefined;
    }
    if (raw < (opts.min ?? Number.MIN_SAFE_INTEGER)) {
      this.fail(key, 'too_small');
      return undefined;
    }
    if (raw > (opts.max ?? Number.MAX_SAFE_INTEGER)) {
      this.fail(key, 'too_large');
      return undefined;
    }
    return raw;
  }

  /** undefined = absent, null = explicitly cleared. */
  nullableInt(key: string, opts: IntOpts = {}): number | null | undefined {
    if (this.input[key] === null) return null;
    return this.int(key, { ...opts, optional: true });
  }

  instant(key: string, opts: { optional?: boolean } = {}): string | undefined {
    const raw = this.take(key, opts.optional);
    if (raw === undefined) return undefined;
    const parsed = parseInstant(raw);
    if (parsed === undefined) this.fail(key, 'invalid_datetime');
    return parsed;
  }

  bool(key: string, opts: { optional?: boolean } = {}): boolean | undefined {
    const raw = this.take(key, opts.optional);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'boolean') {
      this.fail(key, 'must_be_boolean');
      return undefined;
    }
    return raw;
  }

  oneOf<T extends string>(key: string, values: readonly T[], opts: { optional?: boolean } = {}): T | undefined {
    const raw = this.take(key, opts.optional);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
      this.fail(key, 'invalid_value');
      return undefined;
    }
    return raw as T;
  }

  done(): void {
    failIfAny(this.errors);
  }
}

/**
 * The visibility and retention window around `now`, in calendar months of the
 * household zone. Both bounds are INCLUSIVE for visibility and validation;
 * the purge deletes only rows with end strictly before `from`, so a row that
 * ends exactly at the boundary is both accepted and kept.
 */
export function windowBounds(now: Date, tz: string, months: number): { from: string; to: string } {
  return { from: addCalendarMonths(now, -months, tz), to: addCalendarMonths(now, months, tz) };
}

/** Reject items that start beyond the future edge or end before the past edge. */
export function assertInsideWindow(startIso: string, endIso: string, now: Date, tz: string, months: number): void {
  const { from, to } = windowBounds(now, tz, months);
  const fields: Record<string, string> = {};
  if (startIso > to) fields['start'] = 'outside_window';
  if (endIso < from) fields['end'] = 'outside_window';
  failIfAny(fields, 'outside_window');
}

/** Clamp an optional [from, to] query range to the window. */
export function clampRange(
  fromRaw: string | null,
  toRaw: string | null,
  bounds: { from: string; to: string },
): { from: string; to: string } {
  const fields: Record<string, string> = {};
  let from = bounds.from;
  let to = bounds.to;
  if (fromRaw !== null && fromRaw !== '') {
    const p = parseInstant(fromRaw);
    if (p === undefined) fields['from'] = 'invalid_datetime';
    else if (p > from) from = p;
  }
  if (toRaw !== null && toRaw !== '') {
    const p = parseInstant(toRaw);
    if (p === undefined) fields['to'] = 'invalid_datetime';
    else if (p < to) to = p;
  }
  failIfAny(fields);
  return { from, to };
}

/** The `from` / `to` query parameters, clamped to the visibility window around `now`. */
export function queryRange(query: URLSearchParams, now: Date, tz: string, months: number): { from: string; to: string } {
  return clampRange(query.get('from'), query.get('to'), windowBounds(now, tz, months));
}

/** The optional `userId` query filter; undefined when it is absent or empty. */
export function queryUserId(query: URLSearchParams): number | undefined {
  const raw = query.get('userId');
  if (raw === null || raw === '') return undefined;
  if (!/^[1-9]\d{0,9}$/.test(raw)) throw new ValidationError({ userId: 'must_be_integer' });
  return Number(raw);
}
