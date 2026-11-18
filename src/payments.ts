// Payment requests for a fuel share, behind a small provider seam.
//
// The default (and the only thing tested against real behaviour) is the manual
// provider: it writes the text of the request, and the person owed sends it to
// the other person themselves (share sheet, SMS, WhatsApp, copy and paste).
//
// The Tikkie adapter is OPTIONAL, OFF unless TIKKIE_PAYMENT_REQUEST_URL,
// TIKKIE_API_KEY and TIKKIE_ACCESS_TOKEN are all set, and UNVERIFIED: it was
// written from the shape of a typical payment-request API and exercised only
// against a local stub. Tikkie's own API is offered to Tikkie business
// customers, with short-lived OAuth tokens; a private household most likely
// has no access, and a static bearer token will not outlive its expiry. It
// never changes the outcome of a request: on any problem (no network, a non-2xx
// answer, an unexpected body, a link that is not on tikkie.me) it falls back to
// the manual text. It never logs or returns the API key or the token.
import type { TikkieConfig } from './config.ts';
import type { Logger } from './http.ts';

export interface PaymentInput {
  amountCents: number;
  creditorName: string;
  debtorName: string;
  /** Litres as shown to people, for example "40.0". */
  litres: string;
  /** The fill-up date as shown to people, for example "Sat 14 Nov". */
  date: string;
  /** Kilometres the debtor drove in the period and kilometres everyone drove. */
  km: number;
  kmTotal: number;
  /** Equal split because nobody drove in the period. */
  equalSplit: boolean;
  /** Identifies the fill-up and the debtor to the provider; contains no personal data. */
  reference: string;
}

export interface PaymentResult {
  provider: 'manual' | 'tikkie';
  message: string;
  /** A payment link the provider created, if any. */
  link?: string;
}

export interface PaymentProvider {
  name: 'manual' | 'tikkie';
  create(input: PaymentInput): Promise<PaymentResult>;
}

/** 1234 -> "12.34" (money is integer cents everywhere; no floats). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The text of the request, in English like the rest of the interface. */
export function requestMessage(input: PaymentInput): string {
  const why = input.equalSplit
    ? 'nobody drove in that period, so the cost is split equally'
    : `${input.km} of ${input.kmTotal} km driven`;
  return (
    `Hi ${input.debtorName}, ${input.creditorName} fuelled the shared car on ${input.date} (${input.litres} L). ` +
    `Your share is EUR ${formatCents(input.amountCents)} (${why}). Please pay ${input.creditorName}.`
  );
}

export const manualProvider: PaymentProvider = {
  name: 'manual',
  create: async (input) => ({ provider: 'manual', message: requestMessage(input) }),
};

/** An https link without credentials: the only kind of link that is stored or shown as one. */
export function isHttpsLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** A link a provider hands back must be https on tikkie.me (or below it): nothing else is ever shown as a link. */
export function isTikkieLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500 || !isHttpsLink(value)) return false;
  const host = new URL(value).hostname;
  return host === 'tikkie.me' || host.endsWith('.tikkie.me');
}

/** Optional and unverified, see the top of this file. `fetchFn` is injected so tests never touch the network. */
export function tikkieProvider(config: TikkieConfig, fetchFn: typeof fetch, log: Logger): PaymentProvider {
  return {
    name: 'tikkie',
    async create(input) {
      const manual = (): PaymentResult => ({ provider: 'manual', message: requestMessage(input) });
      try {
        const res = await fetchFn(config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'API-Key': config.apiKey, Authorization: `Bearer ${config.accessToken}` },
          body: JSON.stringify({
            amountInCents: input.amountCents,
            currency: 'EUR',
            description: `Fuel ${input.date}`,
            referenceId: input.reference,
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) {
          // Status only: never headers, body or tokens. The body is not read, so give the connection back.
          void res.body?.cancel().catch(() => undefined);
          log({ event: 'payment.tikkie_failed', status: res.status });
          return manual();
        }
        const data = (await res.json()) as Record<string, unknown> | null;
        const link = data?.['url'] ?? data?.['paymentRequestUrl'];
        if (!isTikkieLink(link)) {
          log({ event: 'payment.tikkie_failed', status: res.status });
          return manual();
        }
        return { provider: 'tikkie', message: requestMessage(input), link };
      } catch {
        log({ event: 'payment.tikkie_failed', status: 0 });
        return manual();
      }
    },
  };
}
