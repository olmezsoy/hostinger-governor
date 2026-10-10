// The credit mirror and the law that spends it. Pure, so the simulation drives the code the daemon
// runs.
import { type Plan, RULES_SINCE } from "./plans.ts";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// Hostinger's API reports no balance, so the governor keeps a lower bound of it: Hostinger is assumed
// to bill more CPU than the guest sees. A limit that comes anyway proves the margin too small and
// widens it (widen).
export type Margin = { mul: number; add: number };
export const MARGIN: Margin = { mul: 1.05, add: 0.08 };
export const charged = (busyCores: number, m: Margin) => m.mul * busyCores + m.add;

// The balance after `seconds` at `busyCores`. While limited and still pressing on the limit nothing is
// earned, so the balance cannot rise.
export function creditStep(
  p: Plan,
  balance: number,
  busyCores: number,
  seconds: number,
  m: Margin,
  earning = true,
): number {
  const delta = ((earning ? p.baseline : 0) - charged(busyCores, m)) * seconds;
  return clamp(balance + delta, 0, p.capacity);
}

// Spend law: the baseline plus the balance's surplus over the floor, spread across `spendS`; under
// the floor the shortfall is made up over `refillS`. The balance glides onto the floor and stays,
// and every credit above it goes to work that asks for it.
export type Law = { floor: number; spendS: number; refillS: number };
export const LAW: Law = { floor: 0.2, spendS: 1800, refillS: 3600 };
export function allowedCores(p: Plan, balance: number, m: Margin, law = LAW): number {
  const floor = law.floor * p.capacity;
  const billed = p.baseline + (balance - floor) / (balance >= floor ? law.spendS : law.refillS);
  return clamp((billed - m.add) / m.mul, 0, p.vcpus);
}

// The slice ceiling in percent of one vCPU: the allowance less what runs outside the slice.
export const sliceCeiling = (p: Plan, allowed: number, outsideCores: number) =>
  clamp(Math.floor((allowed - outsideCores) * 10) * 10, 20, 100 * p.vcpus);

// A limit means the balance was empty while the mirror said `err` was left, after `used` billed
// core-seconds since it was last known. Widen the margin toward that drift with a quarter extra.
// Large differences may need several updates; under a core-hour there is too little evidence.
export function widen(m: Margin, err: number, used: number): Margin {
  if (used < 3600) return m;
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    mul: r4(m.mul + clamp((1.25 * err) / used, 0.02, 0.1)),
    add: r4(m.add + 0.02),
  };
}

// Steal as a share of demand (busy + steal). A limit refuses most of what is asked; neighbours take a
// share of whatever runs. Cutting demand under the limit makes a limit's steal vanish and neighbours'
// stay; restoring it brings a limit's steal back.
export const LIMIT_EVIDENT = 0.6;
export const limitConfirmed = (sf0: number, sfCut: number, sfRestore: number) =>
  sfCut <= 0.75 * sf0 && sfRestore >= Math.max(0.6 * sf0, 1.5 * sfCut);

export const demandSteal = (busy: number, steal: number) =>
  busy + steal > 0 ? steal / (busy + steal) : 0;
// Heuristics for demand, not the host's unobservable count of throttled scheduling periods.
export const LIMIT_PRESSING = 0.02;
export const LIFT_STEAL = 0.15;
export const recoveryCeiling = (p: Plan, outside: number) =>
  Math.max(20, Math.floor((p.limit - outside - 0.2) * 10) * 10);
export const tightenCeiling = (ceiling: number, managedDemand: number) =>
  Math.max(20, Math.min(Math.floor(ceiling / 2), Math.floor(managedDemand * 0.7 * 100)));
export const liftConfirmed = (p: Plan, burners: number, busyCores: number, steal: number) =>
  steal < LIFT_STEAL && busyCores >= Math.max(burners * 0.75, p.limit + 0.1);

// A model of complete, end-stamped, 30-minute readings. Those semantics are not established by the
// API, so the daemon uses this only as a diagnostic. Unknown intervals invalidate the model balance.
export type Reading = { at: number; v: number };
export type Anchor = { at: number; balance: number; exact: boolean };
export function replay(p: Plan, readings: Reading[], since = RULES_SINCE): Anchor | null {
  const rs = readings.filter((r) => r.at >= since).sort((a, b) => a.at - b.at);
  if (rs.length < 2) return null;
  let balance = 0;
  let exact = false;
  for (let i = 1; i < rs.length; i++) {
    const seconds = (rs[i].at - rs[i - 1].at) / 1000;
    if (
      seconds !== 1800 || !Number.isFinite(rs[i].v) || rs[i].v < 0 || rs[i].v > 100
    ) {
      [balance, exact] = [0, false];
      continue;
    }
    balance += (p.baseline - (rs[i].v / 100) * p.vcpus) * seconds;
    if (balance >= p.capacity) [balance, exact] = [p.capacity, true];
    else if (balance < 0) balance = 0;
  }
  return { at: rs.at(-1)!.at, balance, exact };
}
