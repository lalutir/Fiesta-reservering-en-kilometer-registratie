// The reminder scheduler. A tick every minute looks at the confirmed
// reservations around "now" and sends a push notification when one of three
// moments has just passed for a reservation that still needs its kilometres:
//
//   start   30 minutes before the reservation starts  (save the start reading)
//   end     when the reservation ends                 (register the kilometres)
//   repeat  60 minutes after it ended                 (once more, if still not done)
//
// Each moment is sent at most once per reservation, also across restarts: the
// "claim" is a row in reminders_sent whose primary key is (reservation, kind,
// scheduled time), inserted before sending. A moment that was missed by more
// than the grace period (the server was down) is skipped, not sent late. A
// claim is released again when every attempt failed for a transient reason, so
// the next tick retries inside the grace period.
//
// "Still needs its kilometres" is the same REGISTERED_SQL the reservation card
// and the pending list use, so the banner and the notification never disagree.
import { many, run, tx } from './db.ts';
import type { Ctx } from './http.ts';
import type { PushMessage, PushService } from './push.ts';
import { REGISTERED_SQL } from './reservations.ts';
import { formatLocal } from '../shared/time.js';

const MINUTE = 60_000;
export const START_LEAD_MS = 30 * MINUTE;
export const REPEAT_AFTER_END_MS = 60 * MINUTE;
export const GRACE_MS = 15 * MINUTE;
export const TICK_MS = 60_000;

type Kind = 'start' | 'end' | 'repeat';

interface Candidate {
  id: number;
  user_id: number;
  start_utc: string;
  end_utc: string;
  has_draft: number;
}

export interface ReminderResult {
  /** Reminders whose moment had come and that were claimed by this tick. */
  claimed: number;
  /** Of those, how many reached at least one device. */
  sent: number;
  /** Claims given back because every device failed for a transient reason (retried on the next tick). */
  released: number;
}

/** The text of a reminder. English, composed here: the service worker cannot reach the client's strings file. */
export function reminderMessage(kind: Kind, reservationId: number, time: string, hasDraft: boolean): PushMessage {
  const url = `/#/usage?res=${reservationId}`;
  const tag = `km-${reservationId}`;
  if (kind === 'start') {
    return { title: 'Your car reservation starts soon', body: `It starts at ${time}. Save your starting odometer reading now.`, url, tag };
  }
  const prefix = kind === 'repeat' ? 'Reminder: ' : '';
  if (hasDraft) {
    return { title: `${prefix}Finish your drive`, body: `Your reservation ended at ${time}. Enter the end odometer reading.`, url, tag };
  }
  return { title: `${prefix}Register your kilometres`, body: `Your reservation ended at ${time}. Register the kilometres you drove.`, url, tag };
}

export interface Reminders {
  tick(): Promise<ReminderResult>;
  start(): { stop(): void };
}

export function createReminders(ctx: Ctx, push: PushService): Reminders {
  const { db, config } = ctx;
  let running = false;

  async function tick(): Promise<ReminderResult> {
    const result: ReminderResult = { claimed: 0, sent: 0, released: 0 };
    if (!push.enabled || running) return result;
    running = true;
    try {
      const nowMs = ctx.clock.now().getTime();
      // Only reservations whose first moment has come (start - 30 min) and whose last has not passed (end + 75 min).
      // has_draft: the owner has an unfinished drive that belongs to this reservation, i.e. linked to it or
      // started inside its own window (from the start lead time to its end). An older forgotten draft is
      // not this reservation's start reading and must not silence its reminders.
      const candidates = many<Candidate>(
        db,
        `SELECT r.id, r.user_id, r.start_utc, r.end_utc,
                EXISTS (SELECT 1 FROM usage d
                         WHERE d.user_id = r.user_id AND d.status = 'draft'
                           AND (d.reservation_id = r.id
                                OR (d.start_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', r.start_utc, ?) AND d.start_utc <= r.end_utc))) AS has_draft
           FROM reservations r
           JOIN users u ON u.id = r.user_id AND u.active = 1
          WHERE r.status = 'confirmed'
            AND r.start_utc <= ? AND r.end_utc >= ?
            AND NOT ${REGISTERED_SQL}
            AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = r.user_id)
          ORDER BY r.start_utc, r.id`,
        `-${START_LEAD_MS / 1000} seconds`,
        new Date(nowMs + START_LEAD_MS).toISOString(),
        new Date(nowMs - REPEAT_AFTER_END_MS - GRACE_MS).toISOString(),
      );
      for (const r of candidates) {
        const startMs = Date.parse(r.start_utc);
        const endMs = Date.parse(r.end_utc);
        const moments: Array<{ kind: Kind; at: number }> = [
          { kind: 'start', at: startMs - START_LEAD_MS },
          { kind: 'end', at: endMs },
          { kind: 'repeat', at: endMs + REPEAT_AFTER_END_MS },
        ];
        for (const { kind, at } of moments) {
          if (!(at <= nowMs && nowMs < at + GRACE_MS)) continue;
          // An open draft means the start reading is already saved: do not ask for it again.
          if (kind === 'start' && r.has_draft === 1) continue;
          const scheduled = new Date(at).toISOString();
          const claimed = tx(
            db,
            () =>
              run(
                db,
                'INSERT OR IGNORE INTO reminders_sent (reservation_id, kind, scheduled_utc, sent_at) VALUES (?, ?, ?, ?)',
                r.id,
                kind,
                scheduled,
                new Date(nowMs).toISOString(),
              ).changes === 1,
          );
          if (!claimed) continue;
          result.claimed++;

          const subs = push.subscriptionsOf(r.user_id);
          const time = formatLocal(kind === 'start' ? r.start_utc : r.end_utc, config.tz, 'time');
          const message = reminderMessage(kind, r.id, time, r.has_draft === 1);
          let ok = 0;
          let retry = 0;
          for (const sub of subs) {
            const outcome = await push.send(sub, message);
            if (outcome === 'ok') ok++;
            else if (outcome === 'retry') retry++;
          }
          if (ok > 0) {
            result.sent++;
            ctx.log({ event: 'reminder.sent', reservationId: r.id, kind, devices: ok });
          } else {
            // Nothing got through. Say so with the reservation, because push.send only logs the push service's host.
            const willRetry = retry > 0 || subs.length === 0;
            ctx.log({ event: 'reminder.undelivered', reservationId: r.id, kind, devices: subs.length, willRetry });
            if (willRetry) {
              // It may work next minute: give the claim back (the grace period ends the retries).
              run(db, 'DELETE FROM reminders_sent WHERE reservation_id = ? AND kind = ? AND scheduled_utc = ?', r.id, kind, scheduled);
              result.released++;
            }
          }
        }
      }
    } finally {
      running = false;
    }
    return result;
  }

  return {
    tick,
    start() {
      const run1 = (): void => {
        tick().catch((err: unknown) => {
          ctx.log({ event: 'reminder.error', message: err instanceof Error ? err.message : String(err) });
        });
      };
      run1();
      const timer = setInterval(run1, TICK_MS);
      timer.unref();
      return { stop: () => clearInterval(timer) };
    },
  };
}
