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
