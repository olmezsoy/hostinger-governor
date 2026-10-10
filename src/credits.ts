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
  const delta = (p.baseline - charged(busyCores, m)) * seconds;
  return clamp(balance + (earning ? delta : Math.min(delta, 0)), 0, p.capacity);
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
// core-seconds since it was last known. Widen the margin by that drift and a quarter more, so it
// cannot repeat; under a core-hour of evidence there is nothing to learn.
export function widen(m: Margin, err: number, used: number): Margin {
  if (used < 3600) return m;
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    mul: Math.min(r4(m.mul + clamp((1.25 * err) / used, 0.02, 0.1)), 1.5),
    add: Math.min(r4(m.add + 0.02), 0.5),
  };
}

// Steal as a share of demand (busy + steal). A limit refuses most of what is asked; neighbours take a
// share of whatever runs. Cutting demand under the limit makes a limit's steal vanish and neighbours'
// stay; restoring it brings a limit's steal back.
export const LIMIT_EVIDENT = 0.6;
export const limitConfirmed = (sf0: number, sfCut: number, sfRestore: number) =>
  sfCut <= 0.75 * sf0 && sfRestore >= Math.max(0.6 * sf0, 1.5 * sfCut);

// Hostinger's CPU readings (percent of the plan, each averaging the time since the one before)
// replayed through the rules from an empty balance: a lower bound, exact once it reaches capacity.
export type Reading = { at: number; v: number };
export type Anchor = { at: number; balance: number; exact: boolean };
export function replay(p: Plan, readings: Reading[], since = RULES_SINCE): Anchor | null {
  const rs = readings.filter((r) => r.at >= since).sort((a, b) => a.at - b.at);
  if (rs.length < 2) return null;
  let balance = 0;
  let exact = false;
  for (let i = 1; i < rs.length; i++) {
    const seconds = (rs[i].at - rs[i - 1].at) / 1000;
    balance += (p.baseline - (rs[i].v / 100) * p.vcpus) * seconds;
    if (balance >= p.capacity) [balance, exact] = [p.capacity, true];
    else if (balance < 0) balance = 0;
  }
  return { at: rs.at(-1)!.at, balance, exact };
}
