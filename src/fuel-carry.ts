// Carry-over between fill-ups: what a person still owes the same fueler from earlier
// fill-ups rides along with the next share, and what the fueler owes them in return is
// taken off. Pure integer maths over data the caller loads, so it can be tested without a
// database. Nothing here is stored: it is derived from the live shares, the paid state of
// the requests and, for requests made from migration v3 on, `coversFuelId`.
//
// A payment request on fill-up F for debtor D (fueler C) asks for D's share of F plus the
// net of the earlier shares between the same two people that are still open. When it is
// marked paid it settles exactly those earlier shares: the ones on fill-ups before F (in
// date order) that existed when the request was made (fuel id up to `coversFuelId`, ids
// are creation order) and that are not paid or settled already. A request made before v3
// has no `coversFuelId` and settles nothing but its own share. Marking it unpaid again
// re-opens what it settled, because settlement is derived from the one paid flag.
//
// Settled shares keep counting inside the request that settled them (so that request's
// amount does not look "changed" the moment it is paid) and drop out of everything else:
// balances, later carry-overs, later requests.

export interface CarryFuel {
  id: number;
  /** The fueler: who is owed. */
  userId: number;
  atUtc: string;
}

/** The live share of a debtor (anybody but the fueler) in one fill-up. */
export interface CarryShare {
  fuelId: number;
  debtorId: number;
  cents: number;
}

export interface CarryRequest {
  fuelId: number;
  debtorId: number;
  paid: boolean;
  /** Highest fill-up id that existed when the request was made; null for requests made before v3. */
  coversFuelId: number | null;
}

export interface Carry {
  /**
   * Net of the earlier open shares between the same two people: more than zero is still owed to the
   * fueler, less than zero is what the fueler owes this person in return. Zero when there is no share.
   */
  carriedCents: number;
  /** What the request for this share asks: the share plus what is carried, never below zero; zero when there is no share. */
  dueCents: number;
  /** The paid request, on a later fill-up, that settled this share; null when it is not settled. */
  settledBy: { fuelId: number; debtorId: number } | null;
}

export const carryKey = (fuelId: number, debtorId: number): string => `${fuelId}:${debtorId}`;

export function carryOver(fuels: CarryFuel[], shares: CarryShare[], requests: CarryRequest[]): Map<string, Carry> {
  const sorted = [...fuels].sort((a, b) => (a.atUtc < b.atUtc ? -1 : a.atUtc > b.atUtc ? 1 : a.id - b.id));
  const position = new Map(sorted.map((f, i) => [f.id, i]));
  const fueler = new Map(sorted.map((f) => [f.id, f.userId]));
  /** Where a fill-up comes in date order, and who fuelled it; only asked for fill-ups that are in `fuels`. */
  const orderOf = (fuelId: number): number => position.get(fuelId) as number;
  const fuelerOf = (fuelId: number): number => fueler.get(fuelId) as number;
  /** +1: the share is owed to `creditor` by `debtor`; -1: the other way round; 0: it belongs to another pair. */
  const direction = (share: CarryShare, creditor: number, debtor: number): 1 | -1 | 0 => {
    if (fuelerOf(share.fuelId) === creditor && share.debtorId === debtor) return 1;
    if (fuelerOf(share.fuelId) === debtor && share.debtorId === creditor) return -1;
    return 0;
  };
  const known = shares.filter((s) => position.has(s.fuelId));
  const paid = new Set(requests.filter((r) => r.paid).map((r) => carryKey(r.fuelId, r.debtorId)));

  // Which shares a paid request settled. Requests are taken in date order of their fill-up, so when two
  // paid requests both reach the same earlier share the earlier one gets it and the other one's amount
  // then differs from what is still due (its card says so).
  const settledBy = new Map<string, { fuelId: number; debtorId: number }>();
  const settlers = requests
    .filter((r) => r.paid && r.coversFuelId !== null && position.has(r.fuelId))
    .sort((a, b) => orderOf(a.fuelId) - orderOf(b.fuelId) || a.debtorId - b.debtorId);
  for (const r of settlers) {
    const creditor = fuelerOf(r.fuelId);
    for (const s of known) {
      const k = carryKey(s.fuelId, s.debtorId);
      if (s.cents <= 0 || paid.has(k) || settledBy.has(k)) continue;
      if (orderOf(s.fuelId) >= orderOf(r.fuelId) || s.fuelId > (r.coversFuelId as number)) continue;
      if (direction(s, creditor, r.debtorId) !== 0) settledBy.set(k, { fuelId: r.fuelId, debtorId: r.debtorId });
    }
  }

  const out = new Map<string, Carry>();
  for (const s of known) {
    const k = carryKey(s.fuelId, s.debtorId);
    let carried = 0;
    if (s.cents > 0) {
      const creditor = fuelerOf(s.fuelId);
      for (const e of known) {
        const ek = carryKey(e.fuelId, e.debtorId);
        if (e.cents <= 0 || paid.has(ek) || orderOf(e.fuelId) >= orderOf(s.fuelId)) continue;
        // Open, or settled by this very request (it keeps counting there, see the top of the file).
        const by = settledBy.get(ek);
        if (by !== undefined && !(by.fuelId === s.fuelId && by.debtorId === s.debtorId)) continue;
        carried += direction(e, creditor, s.debtorId) * e.cents;
      }
    }
    out.set(k, { carriedCents: carried, dueCents: s.cents > 0 ? Math.max(0, s.cents + carried) : 0, settledBy: settledBy.get(k) ?? null });
  }
  return out;
}
