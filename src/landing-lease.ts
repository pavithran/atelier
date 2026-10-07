// The project's landing lease (atelier land): who holds it for which task,
// when it was taken and when the holder last renewed it. The server and the
// CLI share this module, so both read the same expiry: a lease not renewed
// for LANDING_LEASE_EXPIRY_MS is treated as free, which is how a landing
// killed without releasing it stops blocking the project (t214).
export interface LandingLease { item: string; holder: string; at: string; renewedAt?: string }
export const LANDING_LEASE_EXPIRY_MS = 15 * 60_000;

// Whether the lease has lapsed at `now` (milliseconds since the epoch).
export function landingLeaseLapsed(lease: LandingLease, now: number): boolean {
  return now - Date.parse(lease.renewedAt ?? lease.at) >= LANDING_LEASE_EXPIRY_MS;
}

// A landing queued with --wait for the lease (t249): which task's landing
// waits, which session asked for it, when it queued and when it last asked
// again. The server keeps these rows in the order the landings queued and
// hands a freed lease to the first of them, so landings start in the order
// their owners queued them rather than the order their polls happen to land.
export interface WaitingLanding { item: string; holder: string; at: string; renewedAt?: string }

// Whether a waiting landing still counts at `now`: one that has not asked
// again for the expiry's span may have been killed while it queued, and the
// landings behind it must not wait for a peer that is gone. A landing that
// keeps asking, one ask per poll, never lapses, exactly as a holder that
// keeps renewing never loses the lease.
export function waitingLandingGone(waiting: WaitingLanding, now: number): boolean {
  return now - Date.parse(waiting.renewedAt ?? waiting.at) >= LANDING_LEASE_EXPIRY_MS;
}
