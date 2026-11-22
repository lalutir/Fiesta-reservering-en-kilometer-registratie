// fetch wrapper for the JSON API plus the shared shapes of its responses.

/** @typedef {{ id: number, username: string, displayName: string }} UserRef */
/** @typedef {{ id: number, username: string, displayName: string, role: 'admin' | 'member', active: boolean, createdAt: string }} User */
/** @typedef {{ user: User, timeZone: string, windowMonths: number, serverTime: string }} Session */
/** @typedef {{ edit: boolean, cancel: boolean, approve: boolean, decline: boolean }} ReservationCan */
/**
 * @typedef {object} Reservation
 * @property {number} id
 * @property {number} userId
 * @property {string} userName
 * @property {number} createdBy
 * @property {string} createdByName
 * @property {'confirmed' | 'pending' | 'declined' | 'expired'} status
 * @property {boolean} suggestion
 * @property {string} start
 * @property {string} end
 * @property {string} note
 * @property {ReservationCan} can
 * @property {ReservationDrive | null} drive the drive that registers it (or the draft / older drive linked to it)
 * @property {KmState} kmState registered implies drive is not null
 */
/** @typedef {'registered' | 'draft' | 'missing'} KmState */
/**
 * @typedef {object} ReservationDrive
 * @property {number} id
 * @property {number} userId
 * @property {string} userName
 * @property {'draft' | 'completed'} status
 * @property {number | null} odometerStart
 * @property {number | null} odometerEnd
 * @property {number | null} distanceKm
 * @property {boolean} linked false when it only overlaps the reservation in time
 * @property {'self' | 'person' | 'together'} [kmFor] whose kilometres these are (the driver's own when absent)
 * @property {number | null} [kmUserId]
 * @property {string | null} [kmUserName]
 */
/**
 * @typedef {object} Usage
 * @property {number} id
 * @property {number} userId
 * @property {string} userName
 * @property {'draft' | 'completed'} status a draft is a drive that has started but not ended
 * @property {string} start
 * @property {string | null} end null for a draft
 * @property {number | null} odometerStart
 * @property {number | null} odometerEnd
 * @property {number | null} distanceKm
 * @property {number | null} reservationId
 * @property {'self' | 'person' | 'together'} [kmFor] whose kilometres these are: the driver's own, another person's or the shared pool (the driver stays the driver)
 * @property {number | null} [kmUserId] the person, when kmFor is 'person'
 * @property {string | null} [kmUserName]
 * @property {string} note
 * @property {{ edit: boolean, delete: boolean }} can
 * @property {boolean} fuelLocked a payment request depends on this drive: only an admin can change it
 */
/**
 * Kilometres still to register for one person.
 * @typedef {object} PendingItem
 * @property {number} userId
 * @property {string} userName
 * @property {Reservation[]} reservations ended reservations without a completed registration
 * @property {Usage[]} drafts
 */
/** @typedef {{ items: PendingItem[], count: number }} Pending */

/**
 * @typedef {object} FuelRequest
 * @property {number} id
 * @property {number} amountCents
 * @property {'manual' | 'tikkie'} provider
 * @property {string} message
 * @property {string} link
 * @property {string | null} paidAt
 * @property {boolean} changed the live share differs from the amount that was asked
 * @property {number} [currentCents] what a request for this share would ask right now
 */
/**
 * @typedef {object} FuelShare
 * @property {number} userId
 * @property {string} userName
 * @property {number} km
 * @property {number} cents
 * @property {boolean} owes owes the fueler: more than zero, or a request was made for them
 * @property {number} [carriedCents] net of the earlier open shares between the fueler and this person (below zero: the fueler owes them)
 * @property {number} [dueCents] the share plus carriedCents, never below zero: what a request asks
 * @property {{ fuelId: number, at: string } | null} [settledBy] a payment on a later fill-up settled this share
 * @property {FuelRequest | null} request
 * @property {{ request: boolean, markPaid: boolean, selfPaid?: boolean }} can selfPaid: this person can say "I have paid this" for their own share
 */
/**
 * @typedef {object} Fuel
 * @property {number} id
 * @property {number} userId
 * @property {string} userName
 * @property {string} at
 * @property {number} millilitres
 * @property {number} totalCents
 * @property {number} pricePerLitreMillis thousandths of a euro
 * @property {number | null} [odometer] the reading at the pump (km); null for a fill-up made before the kilometre check existed
 * @property {string} note
 * @property {{ from: string | null, to: string }} period
 * @property {number} totalKm
 * @property {number} [unaccountedKm] km in unexplained odometer gaps that end in this period (display only: the split is unchanged)
 * @property {number} [togetherKm] of totalKm: driven together, split in the same ratio as the personal kilometres
 * @property {boolean} equalSplit
 * @property {boolean} firstInData
 * @property {FuelShare[]} shares
 * @property {boolean} hasPaidRequests
 * @property {boolean} [settledByLater] a later payment settled a share of this fill-up
 * @property {{ edit: boolean, delete: boolean }} can
 * @property {boolean} [canOdometer] the fueler or an admin can correct the reading, also while everything else is locked
 */
/** @typedef {{ fromUserId: number, fromName: string, toUserId: number, toName: string, cents: number }} Balance */

/**
 * One odometer reading in the chain (the odometer check): the start or end of a drive, the start of a drive
 * that has not ended, or a fill-up.
 * @typedef {object} OdometerReading
 * @property {'drive-start' | 'drive-end' | 'draft-start' | 'fuel'} source
 * @property {number} id the usage row or the fill-up
 * @property {number} km
 * @property {string} at
 * @property {number} userId the driver, or the fueler
 * @property {string} userName
 * @property {boolean} draft the start reading of a drive that has not ended yet
 */
/** @typedef {{ id: number, note: string, byId: number, byName: string, at: string }} OdometerExplained */
/**
 * Two neighbouring readings that do not fit: a gap (the later one is higher) or a mismatch (it is lower).
 * @typedef {object} OdometerItem
 * @property {string} key names both readings; an explanation is stored under it
 * @property {'gap' | 'mismatch'} kind
 * @property {number} km how many
 * @property {OdometerReading} prev
 * @property {OdometerReading} next
 * @property {OdometerExplained | null} explained
 * @property {{ explain: boolean, unexplain: boolean }} can
 */
/** @typedef {{ window: { from: string, to: string }, readings: OdometerReading[], items: OdometerItem[], latest: OdometerReading | null }} OdometerChain */

/**
 * A traffic ticket. `driver` and `basis` are worked out by the server on every read.
 * @typedef {object} Ticket
 * @property {number} id
 * @property {string} at the moment of the offence (UTC ISO)
 * @property {number | null} amountCents
 * @property {string} reason '' when there is none
 * @property {number} createdBy
 * @property {string} createdByName
 * @property {{ id: number, name: string } | null} driver who was driving at `at`; null when nobody is on record
 * @property {'drive' | 'draft' | 'reservation' | 'none'} basis
 * @property {{ edit: boolean, delete: boolean }} can
 */

/**
 * A damage report on the car. `hint` is worked out by the server on every read and is information, not blame.
 * @typedef {object} DamageReport
 * @property {number} id
 * @property {string} noticedOn the day it was first noticed ('YYYY-MM-DD', a calendar day, not an instant)
 * @property {{ id: number, name: string } | null} noticedBy null means unknown
 * @property {{ id: number, name: string }} reportedBy
 * @property {string} description
 * @property {'front' | 'rear' | 'left' | 'right' | 'roof' | 'interior' | 'wheels_tyres' | 'windows' | 'mechanical' | 'other'} location
 * @property {'open' | 'repaired'} status
 * @property {string | null} repairedOn the day it was repaired; null while open
 * @property {string} repairNote '' when there is none
 * @property {{ driver: { id: number, name: string } | null, basis: 'drive' | 'draft' | 'reservation' | 'last_drive' | 'none' }} hint who was driving before the noticed day
 * @property {{ edit: boolean, delete: boolean, repair: boolean }} can
 */

/**
 * The APK record of the car: one expiry date, who entered it and when. All null until somebody enters it.
 * @typedef {object} Apk
 * @property {string | null} expiresOn 'YYYY-MM-DD'
 * @property {number | null} daysLeft calendar days from today to the expiry (negative: expired)
 * @property {{ id: number, name: string } | null} updatedBy
 * @property {string | null} updatedAt UTC ISO
 */

/**
 * What every view gets: the signed-in session, the user list and a few actions.
 * @typedef {object} App
 * @property {Session} session
 * @property {string} tz household time zone
 * @property {UserRef[]} users active users (for pickers)
 * @property {(hash: string) => void} navigate
 * @property {() => Promise<void>} refresh re-render the current view
 * @property {(message: string, isError?: boolean) => void} toast
 * @property {(quiet?: boolean) => Promise<void>} signedOut show the sign-in screen (quiet = no "session ended" notice)
 */

export class ApiError extends Error {
  /** @type {number} */
  status;
  /** @type {string} */
  code;
  /** @type {Record<string, string>} */
  fields;
  /** @type {Record<string, any>} */
  body;

  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [fields]
   * @param {Record<string, any>} [body]
   */
  constructor(status, code, message, fields = {}, body = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.body = body;
  }
}

/** @type {() => void} */
let onUnauthorized = () => {};

/** Called when a request other than login comes back 401 (session ended). */
export function setUnauthorizedHandler(/** @type {() => void} */ fn) {
  onUnauthorized = fn;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>} parsed JSON, or null for 204
 */
export async function api(method, path, body) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
  if (res.status === 204) return null;
  /** @type {any} */
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && path !== '/api/auth/login') onUnauthorized();
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.fields ?? {}, e);
  }
  return data;
}

/** @param {string} path */
export const get = (path) => api('GET', path);
/**
 * @param {string} path
 * @param {unknown} [body]
 */
export const post = (path, body = {}) => api('POST', path, body);
/**
 * @param {string} path
 * @param {unknown} body
 */
export const patch = (path, body) => api('PATCH', path, body);
/** @param {string} path */
export const del = (path) => api('DELETE', path);
