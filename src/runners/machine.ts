// What a runner reports of the machine it runs on (t607), sent with every poll
// and kept with its offer beside the memory. Only the known fields are kept,
// each bounded, so a runner cannot store more than a status display shows. A
// reading that fails any bound is dropped whole, never repaired: a display
// would rather show no reading than a guess. The newest reading per host,
// and whether it has gone stale, is machineReadings. Its time is the offer's
// stored time, which an unchanged poll within OFFER_REFRESH_MS does not renew.

export interface MachineReading {
  host: string;                                   // the machine's name, as its runner reads it
  cpus: number;                                   // logical cores
  loadavg: [number, number, number];              // 1, 5 and 15 minute load averages
  memFreePercent: number;                         // free memory, 0 to 100
  testSlots: { capacity: number; inUse: number } | null;  // the host test pool (cli/load.mjs); null when the host has none
}

// A reading older than this at the server's clock no longer says how loaded
// the machine is.
export const MACHINE_STALE_MS = 5 * 60 * 1000;

const HOST_MAX = 255;
const CPUS_MAX = 4096;
const LOAD_MAX = 1_000_000;
const SLOTS_MAX = 10_000;
const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const load = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= LOAD_MAX;

export function parseMachine(raw: unknown): MachineReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.host !== "string" || !r.host || r.host.length > HOST_MAX) return null;
  if (!int(r.cpus, 1, CPUS_MAX)) return null;
  if (!Array.isArray(r.loadavg) || r.loadavg.length !== 3 || !r.loadavg.every(load)) return null;
  if (typeof r.memFreePercent !== "number" || !Number.isFinite(r.memFreePercent) || r.memFreePercent < 0 || r.memFreePercent > 100) return null;
  let testSlots: MachineReading["testSlots"] = null;
  if (r.testSlots !== null && r.testSlots !== undefined) {
    const s = r.testSlots as Record<string, unknown>;
    if (typeof s !== "object" || !int(s.capacity, 1, SLOTS_MAX) || !int(s.inUse, 0, s.capacity)) return null;
    testSlots = { capacity: s.capacity, inUse: s.inUse };
  }
  return { host: r.host, cpus: r.cpus, loadavg: [r.loadavg[0], r.loadavg[1], r.loadavg[2]], memFreePercent: r.memFreePercent, testSlots };
}

export interface HostReading extends MachineReading {
  runner: string;   // the runner whose poll carried it
  at: string;       // when the server received that poll (the offer's `at`)
  stale: boolean;
}

// One reading per host: the newest by received time among the offers that
// carry one. A stale reading is kept and marked, so a display can say the
// host went quiet rather than lose it.
export function machineReadings(offers: readonly { runner: string; at: string; machine?: MachineReading }[], now: number): HostReading[] {
  const newest = new Map<string, { offer: { runner: string; at: string; machine: MachineReading }; time: number }>();
  for (const o of offers) {
    const time = Date.parse(o.at);
    if (!o.machine || !Number.isFinite(time)) continue;
    const key = o.machine.host.toLowerCase(), held = newest.get(key);
    if (!held || time > held.time) newest.set(key, { offer: { ...o, machine: o.machine }, time });
  }
  return [...newest.values()].map(({ offer, time }) => ({ ...offer.machine, runner: offer.runner, at: new Date(time).toISOString(), stale: now - time > MACHINE_STALE_MS }));
}
