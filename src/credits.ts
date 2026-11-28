// The law that spends the credit estimate, and the tests that tell a credit limit from neighbours.
// Pure, so the simulation drives the code the daemon runs.
import type { Plan } from "./plans.ts";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// What the guest's own count charges for busy CPU: mul x cores + add (src/estimate.ts).
export type Margin = { mul: number; add: number };

// Spend law: the baseline plus the balance's surplus over the floor, spread across `spendS`; under
// the floor the shortfall is made up over `refillS`. The balance glides onto the floor and stays,
// and every credit above it goes to work that asks for it.
export type Law = { floor: number; spendS: number; refillS: number };
export const LAW: Law = { floor: 0.1, spendS: 1800, refillS: 3600 };
export function allowedCores(p: Plan, balance: number, m: Margin, law = LAW): number {
  const floor = law.floor * p.capacity;
  const billed = p.baseline + (balance - floor) / (balance >= floor ? law.spendS : law.refillS);
  return Math.max(0, (billed - m.add) / m.mul);
}

// The slice ceiling in percent of one vCPU: the allowance less what runs outside the slice.
export const sliceCeiling = (p: Plan, allowed: number, outsideCores: number) =>
  clamp(Math.floor((allowed - outsideCores) * 10) * 10, 20, 100 * p.vcpus);

// Steal as a share of demand (busy + steal). A limit refuses most of what is asked; neighbours take a
// share of whatever runs. Cutting demand under the limit makes a limit's steal vanish and neighbours'
// stay; restoring it brings a limit's steal back.
export const LIMIT_STEAL = 0.1;
export const LIMIT_EVIDENT = 0.6;
export const limitConfirmed = (sf0: number, sfCut: number, sfRestore: number) =>
  sfCut <= 0.75 * sf0 && sfRestore >= Math.max(0.6 * sf0, 1.5 * sfCut);

export const demandSteal = (busy: number, steal: number) =>
  busy + steal > 0 ? steal / (busy + steal) : 0;

// The slice's own demand in cores: its busy CPU plus its share of the steal, in proportion to what it
// runs. Steal on work outside the slice is not the slice's demand, and no cut of the slice removes it.
// `busy` and `steal` are shares of the whole VM; `outside` is busy cores outside the slice.
export function sliceDemand(p: Plan, busy: number, steal: number, outside: number) {
  const sliceBusy = Math.max(0, busy * p.vcpus - outside);
  return busy > 0 ? sliceBusy * (busy + steal) / busy : 0;
}
// A probe cuts the slice to 20% of one core. Below twice that (0.4 cores on KVM 4+, or 0.3 on
// smaller plans whose own limit is 0.4-0.6 cores), the cut removes too little of the slice's
// demand to tell a limit's steal from neighbours': the test would score noise.
export const PROBE_CEILING = 20;
export const PROBE_MIN_DEMAND = 2 * PROBE_CEILING / 100;
export const probeMinDemand = (p: Plan) =>
  Math.min(PROBE_MIN_DEMAND, Math.max(1.5 * PROBE_CEILING / 100, 0.5 * p.limit));
// Steal as a share of demand says nothing on its own when demand is tiny. Evident steal must also be
// steal a limit could cause: a real cap reaches a 60% share only with demand of 2.5 times the cap,
// and a per-vCPU cap on one busy thread steals most of a core.
export const EVIDENT_LIMIT_SHARE = 0.25;
export const evidentSteal = (p: Plan, steal: number) =>
  steal * p.vcpus >= EVIDENT_LIMIT_SHARE * p.limit;
// Under a credit limit the whole VM delivers the cap, whatever work presses on it. A slice that a
// 20% probe cannot meaningfully cut — because its own demand is below the probe floor, its consumed
// CPU (`sliceBusy`) is already at or below the 20% cgroup quota, or outside work alone exceeds the
// host cap — cannot be probed; when busy sits near the cap with steal at LIFT_STEAL or more, the
// governor confirms with burners before entering so noisy neighbours near the cap never trigger a
// false one.
export const pinnedAtCap = (p: Plan, busy: number, steal: number, outside: number) => {
  const busyCores = busy * p.vcpus;
  const sliceBusy = Math.max(0, busyCores - outside);
  const unprobable = sliceDemand(p, busy, steal, outside) < probeMinDemand(p) ||
    sliceBusy <= PROBE_CEILING / 100 ||
    outside >= 0.85 * p.limit;
  return unprobable &&
    busyCores >= 0.85 * p.limit && busyCores <= p.limit + 0.1 &&
    demandSteal(busy, steal) >= LIFT_STEAL;
};
// Probing cuts cgroup CPUQuota to PROBE_CEILING (20% of one core), which only meters consumed CPU
// (`sliceBusy`), not steal. Requiring `sliceBusy > PROBE_CEILING / 100` on every plan ensures the
// cut actually reduces consumed CPU (slices at or below 0.20 busy cores route to `pinnedAtCap` for
// burner confirmation instead of looping futile probes). Deferring to `pinnedAtCap` also prevents
// futile probes when outside load alone pins the VM cap.
export const canProbeSlice = (p: Plan, busy: number, steal: number, outside: number) =>
  !pinnedAtCap(p, busy, steal, outside) &&
  sliceDemand(p, busy, steal, outside) >= probeMinDemand(p) &&
  Math.max(0, busy * p.vcpus - outside) > PROBE_CEILING / 100;
// Hostinger lifts a limit at 20% of capacity, and capacity is three hours of the vCPUs above the
// baseline, so even the most the margin can charge takes this long to spend it: no credit limit can
// come sooner after a lift, on any plan (2,160 seconds at cost; less with the margin).
export const quietAfterLiftSeconds = (p: Plan, m: Margin) =>
  p.recovered / Math.max(0.1, m.mul * p.vcpus + m.add - p.baseline);
// Heuristics for demand, not the host's unobservable count of throttled scheduling periods.
export const LIMIT_PRESSING = 0.02;
export const LIFT_STEAL = 0.15;
// Pressing on a limit needs both steal as a share of demand and total demand / stolen cores that a
// VM-wide or per-vCPU cap could actually cause: on an idle noisy host, 0.005 cores of neighbour
// steal on 0.15 cores busy is over 2% of demand without coming near any cap. Demand counts from
// four fifths of one vCPU's share, not the whole share: a thread's demand varies from one
// scheduling period to the next, so one that averages 0.27 cores under a 0.30 cap is still
// throttled in a third of its periods, which is what stops earning. At the whole share the
// governor never saw that thread pressing and left it paused for six simulated hours.
export const limitPressing = (p: Plan, busy: number, steal: number) =>
  demandSteal(busy, steal) >= LIMIT_PRESSING &&
  (busy + steal) * p.vcpus >= 0.8 * (p.limit / p.vcpus) &&
  steal * p.vcpus >= Math.min(0.01, LIMIT_PRESSING * p.limit);
export const recoveryCeiling = (p: Plan, outside: number) =>
  Math.max(20, Math.floor((p.limit - outside - 0.2) * 10) * 10);
export const tightenCeiling = (ceiling: number, managedDemand: number) =>
  Math.max(20, Math.min(Math.floor(ceiling / 2), Math.floor(managedDemand * 0.7 * 100)));
// A VM that delivers three quarters of what the burners ask is held by no credit limit, whatever
// the neighbours take on top: under one it delivers the plan's limit and no more.
export const liftConfirmed = (p: Plan, burners: number, busyCores: number) =>
  busyCores >= Math.max(burners * 0.75, p.limit + 0.1);

// End-stamped readings cover the interval since the previous reading, in percent of the plan.
export type Reading = { at: number; v: number };
// Valid reading intervals: 900 to 2,700 seconds. Longer ones are gaps.
export const MAX_SPACING_MS = 2_700_000;
export const validSpacing = (start: number, end: number) =>
  end - start >= 900_000 && end - start <= MAX_SPACING_MS;
