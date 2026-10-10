// Hostinger's CPU credit rules per VPS plan, from its support article "How CPU credits work on
// Hostinger VPS" (revised 2026-10-09). Every plan earns its baseline in core-seconds each second,
// spends what it uses, holds at most 10,800 x (vCPUs - baseline) (three hours at 100%), and at zero is
// limited to a share of the plan until the balance is back at 20%; while demand still presses on that
// limit in a third of scheduling periods, nothing is earned.
export type Plan = {
  name: string;
  vcpus: number;
  // Core-seconds earned per second.
  baseline: number;
  // Most core-seconds the balance holds.
  capacity: number;
  // vCPUs available while the balance is empty.
  limit: number;
  // The balance at which a limit lifts.
  recovered: number;
};

const LIMIT_SHARE: Record<number, number> = { 1: 0.4, 2: 0.3, 4: 0.3, 8: 0.3 };
const BASELINE_SHARE = 0.6;

export function plan(vcpus: number, name = `KVM ${vcpus}`, baselineShare = BASELINE_SHARE): Plan {
  if (!Number.isSafeInteger(vcpus) || vcpus < 1 || vcpus > 128) {
    throw new Error("vcpus must be an integer from 1 to 128");
  }
  if (!Number.isFinite(baselineShare) || baselineShare < 0.1 || baselineShare > 0.9) {
    throw new Error("baseline_share must be from 0.1 to 0.9");
  }
  const baseline = baselineShare * vcpus;
  const capacity = 10_800 * (vcpus - baseline);
  return {
    name,
    vcpus,
    baseline,
    capacity,
    limit: (LIMIT_SHARE[vcpus] ?? 0.3) * vcpus,
    recovered: 0.2 * capacity,
  };
}

// While limited, a period in which demand is throttled in this share of scheduling periods or more
// earns nothing. The guest cannot observe it; the simulator models it and the rules watch checks it.
export const EARNING_PAUSE_SHARE = 0.33;

// Readings before this ran under the previous rules (a 30% baseline on KVM 8), so replays start here.
export const RULES_SINCE = Date.parse("2026-10-09T15:00:00Z");
