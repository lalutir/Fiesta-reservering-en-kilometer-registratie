// Tells everybody who owes money when a fill-up is registered: one push per device of each
// person with a live share above zero. It runs after the fill-up is saved and answered, never
// inside the request: a slow or broken push service can neither delay nor fail the save, and a
// failure is logged without endpoints or keys (push.ts never logs them either). Nothing is
// sent when push is switched off or a person has no device signed up.
import { many, type PushSubscriptionRow } from './db.ts';
import type { FuelDto, FuelShareDto } from './fuel.ts';
import type { Ctx } from './http.ts';
import { formatCents } from './payments.ts';
import type { PushMessage, PushService } from './push.ts';

/** Names come from users and are shown in a notification of at most about a kilobyte: keep them short. */
const MAX_NAME = 40;
const short = (name: string): string => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name);

/** A failure as the log may say it: the error's name only, since a message could carry more than a log should. */
const reasonOf = (err: unknown): string => (err instanceof Error ? err.name : 'error');

/** The notification for one debtor: who fuelled, what is due (and what of it is carried), and that it can still change. */
export function fuelMessage(fuel: Pick<FuelDto, 'id' | 'userName'>, share: Pick<FuelShareDto, 'cents' | 'carriedCents' | 'dueCents'>): PushMessage {
  const fueler = short(fuel.userName);
  const parts =
    share.carriedCents > 0
      ? ` (EUR ${formatCents(share.cents)} now plus EUR ${formatCents(share.carriedCents)} still open from earlier)`
      : share.carriedCents < 0
        ? ` (EUR ${formatCents(share.cents)} now, minus EUR ${formatCents(-share.carriedCents)} that ${fueler} owes you from earlier)`
        : '';
  return {
    title: `${fueler} fuelled the car`,
    body: `You owe ${fueler} EUR ${formatCents(share.dueCents)}${parts}. This can still change when more drives are registered.`,
    url: '/#/history',
    tag: `fuel-${fuel.id}`,
  };
}

export interface FuelNotifier {
  /** Start telling the debtors of a new fill-up. Returns at once and never throws. */
  fuelCreated(fuel: FuelDto): void;
  /** Resolves when the sends that are running have finished (shutdown, tests). */
  idle(): Promise<void>;
}

export function createFuelNotifier(ctx: Ctx, push: PushService): FuelNotifier {
  const running = new Set<Promise<void>>();
  // Fire and forget must stay that way: a job that rejects (nothing here should) is logged and dropped,
  // never left as an unhandled rejection, which would take the whole server down.
  const track = (job: Promise<void>, fuelId: number): void => {
    running.add(job);
    const done = (): void => void running.delete(job);
    job.then(done, (err: unknown) => {
      done();
      try {
        ctx.log({ event: 'fuel.push_error', fuelId, reason: reasonOf(err) });
      } catch {
        // A broken logger must not turn into the rejection this guards against.
      }
    });
  };

  /** All devices of one person, in parallel; a failure of one device does not stop the others. */
  async function deliver(fuelId: number, userId: number, devices: PushSubscriptionRow[], message: PushMessage): Promise<void> {
    const outcomes = await Promise.all(
      devices.map(async (subscription) => {
        try {
          return await push.send(subscription, message);
        } catch (err) {
          ctx.log({ event: 'fuel.push_error', fuelId, userId, reason: reasonOf(err) });
          return 'rejected' as const;
        }
      }),
    );
    ctx.log({ event: 'fuel.push', fuelId, userId, sent: outcomes.filter((o) => o === 'ok').length, failed: outcomes.filter((o) => o !== 'ok').length });
  }

  return {
    fuelCreated(fuel) {
      if (!push.enabled) return;
      try {
        const active = new Set(many<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE active = 1').map((u) => u.id));
        for (const share of fuel.shares) {
          if (share.userId === fuel.userId || !share.owes || share.cents <= 0 || share.dueCents <= 0 || !active.has(share.userId)) continue;
          const devices = push.subscriptionsOf(share.userId);
          if (devices.length === 0) continue;
          track(deliver(fuel.id, share.userId, devices, fuelMessage(fuel, share)), fuel.id);
        }
      } catch (err) {
        ctx.log({ event: 'fuel.push_error', fuelId: fuel.id, reason: reasonOf(err) });
      }
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}
