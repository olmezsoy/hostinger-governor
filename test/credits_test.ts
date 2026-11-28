import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  allowedCores,
  canProbeSlice,
  evidentSteal,
  LAW,
  limitConfirmed,
  limitPressing,
  pinnedAtCap,
  PROBE_MIN_DEMAND,
  probeMinDemand,
  quietAfterLiftSeconds,
  sliceCeiling,
  sliceDemand,
} from "../src/credits.ts";
import { plan } from "../src/plans.ts";
import { parseSadf, sparkline } from "../src/report.ts";
import { cpuCounters, shares } from "../src/sample.ts";

const kvm8 = plan(8);

Deno.test("plans follow Hostinger's published table", () => {
  assertEquals([kvm8.baseline, kvm8.capacity, kvm8.limit, kvm8.recovered], [
    4.8,
    34_560,
    2.4,
    6_912,
  ]);
  assertEquals([plan(4).capacity, plan(2).capacity, plan(1).capacity], [17_280, 8_640, 4_320]);
  assertEquals(plan(1).limit, 0.4);
});

// What the guest's own count charges before any reading says otherwise (src/estimate.ts).
const MARGIN = { mul: 1.05, add: 0.04 };

Deno.test("the spend law glides onto the floor and spends every core above it", () => {
  // A full bank's allowance is not cut to the plan's vCPUs; sliceCeiling caps the slice instead.
  assertEquals(
    allowedCores(kvm8, kvm8.capacity, MARGIN).toFixed(3),
    ((4.8 + (34_560 - 3_456) / 1800 - 0.04) / 1.05).toFixed(3),
  );
  assertEquals(
    allowedCores(kvm8, LAW.floor * kvm8.capacity, MARGIN).toFixed(3),
    ((4.8 - 0.04) / 1.05).toFixed(3),
  );
  assertEquals(allowedCores(kvm8, 0, MARGIN) < allowedCores(kvm8, 6_912, MARGIN), true);
  assertEquals(sliceCeiling(kvm8, 8, 0.3), 770);
  assertEquals(sliceCeiling(kvm8, 0.1, 0.3), 20);
});

Deno.test("a cut-and-restore test tells a limit from noisy neighbours", () => {
  assertEquals(limitConfirmed(0.4, 0.02, 0.38), true);
  assertEquals(limitConfirmed(0.4, 0.38, 0.41), false);
  assertEquals(limitConfirmed(0.4, 0.05, 0.06), false);
});

// Hostinger's bucket second by second against the governor ticking every 30 seconds through a week
// of endless work. Hostinger bills 3% more than the guest sees plus 0.05 vCPU (inside the margin);
// services outside the slice use 0.3 vCPU with a spike of a quarter of the vCPUs for ten minutes every
// four hours (they are not governed, so a bigger spike on an empty balance would drain it anyway); the
// mirror starts empty whatever the real balance.
function week(p = kvm8, realStart = p.capacity, tick = 30) {
  let real = realStart;
  let mirror = 0;
  let ceilingCores = 0;
  let emptied = 0;
  let billed = 0;
  let tickBusy = 0;
  const seconds = 7 * 86_400;
  for (let t = 0; t < seconds; t++) {
    const outside = 0.3 + (t % 14_400 < 600 ? p.vcpus / 4 : 0);
    if (t % tick === 0) {
      if (t > 0) {
        const charge = MARGIN.mul * tickBusy / tick + MARGIN.add;
        mirror = Math.min(p.capacity, Math.max(0, mirror + (p.baseline - charge) * tick));
      }
      tickBusy = 0;
      ceilingCores = sliceCeiling(p, allowedCores(p, mirror, MARGIN), outside) / 100;
    }
    const busy = Math.min(p.vcpus, outside + ceilingCores);
    tickBusy += busy;
    const cost = 1.03 * busy + 0.05;
    billed += cost;
    real = Math.min(p.capacity, real + p.baseline - cost);
    if (real <= 0) [real, emptied] = [0, emptied + 1];
  }
  return { emptied, used: billed / (p.baseline * seconds) };
}

Deno.test("a week of endless work never empties the balance and spends what it earns", () => {
  for (
    const [p, start] of [[kvm8, kvm8.capacity], [kvm8, 0], [plan(4), 0], [plan(2), 0]] as const
  ) {
    const { emptied, used } = week(p, start);
    assertEquals(emptied, 0, `${p.name} from ${start} emptied`);
    assertEquals(used >= 0.95, true, `${p.name} used only ${(used * 100).toFixed(1)}%`);
  }
});

Deno.test("machine readings parse", () => {
  assertEquals(
    cpuCounters("cpu  100 0 50 800 20 3 2 25 0 0\ncpu0 1 2 3"),
    { busy: 155, steal: 25, total: 1000 },
  );
  assertEquals(
    shares({ at: 0, usage: { a: 0, b: 0 } }, { at: 1_000, usage: { a: 4_000_000, b: 10 } }, 8),
    { a: 0.5 },
  );
  const rows = parseSadf(
    "# hostname;interval;timestamp;CPU;%idle\nh;600;2026-10-09 10:00:00 UTC;-1;40.00\n",
  );
  assertEquals(rows, [{ at: Date.parse("2026-10-09T10:00:00Z"), CPU: -1, "%idle": 40 }]);
  assertEquals(sparkline([{ at: 0, v: 100 }, { at: 23, v: 0 }], 0, 24, 100, 1).length, 24);
});

Deno.test("the slice's demand excludes steal on work outside it", () => {
  const p = plan(8);
  // A live KVM 8 box at a false limit: 0.17 cores busy, 0.13 of them outside the slice.
  assertAlmostEquals(sliceDemand(p, 0.17 / 8, 0.02 / 8, 0.13), 0.04 * 0.19 / 0.17, 1e-9);
  // Three cores outside under the 2.4-core cap: their 0.6 cores of steal are not the slice's.
  assertAlmostEquals(sliceDemand(p, 2.4 / 8, 0.6 / 8, 2.36), 0.05, 1e-9);
  // A busy slice keeps its share of the steal.
  assertAlmostEquals(sliceDemand(p, 2.4 / 8, 0.6 / 8, 0.4), 2.5, 1e-9);
  assertEquals(sliceDemand(p, 0, 0.01, 0), 0);
  assertEquals(PROBE_MIN_DEMAND, 0.4);
  assertEquals(probeMinDemand(plan(1)), 0.3);
  assertEquals(probeMinDemand(plan(2)), 0.3);
  assertEquals(probeMinDemand(plan(4)), 0.4);
  assertEquals(probeMinDemand(plan(8)), 0.4);
});

Deno.test("evident steal needs steal a limit could cause, not only a high share", () => {
  const p = plan(8);
  // 60% of 0.05 cores is noise; 60% of 8 cores against a 2.4-core cap is not.
  assertEquals(evidentSteal(p, 0.03 / 8), false);
  assertEquals(evidentSteal(p, 0.6 / 8), true);
  assertEquals(evidentSteal(p, 5.6 / 8), true);
});

Deno.test("pinnedAtCap flags an idle slice near the host limit, including under modest neighbour steal", () => {
  const p = plan(8);
  assertEquals(pinnedAtCap(p, 2.38 / 8, 0.62 / 8, 2.34), true);
  // Real 2.4-core cap with 10% neighbour steal delivers 2.16 cores, still inside 0.85 * limit.
  assertEquals(pinnedAtCap(p, 2.16 / 8, 1.34 / 8, 2.12), true);
  // The slice is busy: a probe can tell, so this entry stays out of it.
  assertEquals(pinnedAtCap(p, 2.38 / 8, 0.62 / 8, 0.5), false);
  // Busy well under or over the cap, or too little steal.
  assertEquals(pinnedAtCap(p, 1.5 / 8, 0.5 / 8, 1.46), false);
  assertEquals(pinnedAtCap(p, 3.2 / 8, 0.8 / 8, 3.16), false);
  assertEquals(pinnedAtCap(p, 2.4 / 8, 0.1 / 8, 2.36), false);
  // On KVM 1 (limit 0.4), a slice running 0.26 cores alone with 16% steal is below 0.85 * limit
  // and above probeMinDemand, so it goes to normal probing rather than pinnedAtCap.
  assertEquals(pinnedAtCap(plan(1), 0.26, 0.26 * 0.16 / 0.84, 0), false);
  assertEquals(pinnedAtCap(plan(1), 0.38, 0.12, 0.36), true);
});

Deno.test("no credit limit can follow a lift sooner than its bank takes to spend, on any plan", () => {
  for (const vcpus of [1, 2, 4, 8]) {
    // At cost, 20% of three hours of the vCPUs above the baseline takes 36 minutes at full use.
    assertAlmostEquals(quietAfterLiftSeconds(plan(vcpus), { mul: 1, add: 0 }), 2160, 1e-6);
  }
  // The margin charges more, so the window is shorter.
  assertAlmostEquals(
    quietAfterLiftSeconds(plan(8), { mul: 1.05, add: 0.0567 }),
    6912 / (1.05 * 8 + 0.0567 - 4.8),
    1e-6,
  );
});

Deno.test("canProbeSlice and pinnedAtCap handle low sliceBusy and outside-pinned caps", () => {
  const p = plan(8);
  // 2.2 cores outside pins the 2.4-core cap even while sliceDemand is 0.45: defer to pinnedAtCap.
  assertEquals(pinnedAtCap(p, 2.38 / 8, 1.0 / 8, 2.2), true);
  assertEquals(canProbeSlice(p, 2.38 / 8, 1.0 / 8, 2.2), false);
  // Slice busy at or below the 0.20-core probe floor cannot be cut by a 20% cgroup quota on any
  // plan (including KVM 1 and 2); cap-shaped VMs route to pinnedAtCap burner confirmation instead.
  assertEquals(canProbeSlice(p, 0.20 / 8, 0.30 / 8, 0), false);
  assertEquals(canProbeSlice(p, 0.25 / 8, 0.30 / 8, 0), true);
  assertEquals(canProbeSlice(plan(1), 0.40, 0.40, 0.225), false);
  assertEquals(pinnedAtCap(plan(1), 0.40, 0.40, 0.225), true);
  assertEquals(canProbeSlice(plan(2), 0.30, 0.30, 0.425), false);
  assertEquals(pinnedAtCap(plan(2), 0.30, 0.30, 0.425), true);
  // Above 0.20 busy cores on KVM 1 and 2, the 20% probe quota does cut consumed CPU.
  assertEquals(canProbeSlice(plan(1), 0.40, 0.40, 0.15), true);
  assertEquals(canProbeSlice(plan(2), 0.30, 0.30, 0.35), true);
});

Deno.test("limitPressing rejects idle neighbour steal while keeping per-vCPU caps", () => {
  const p = plan(8);
  // Idle box with 0.15 busy + 0.005 steal (3.2% of demand): not pressing.
  assertEquals(limitPressing(p, 0.15 / 8, 0.005 / 8), false);
  // Single thread under KVM 8 per-vCPU 0.30-core cap at 28% ceiling (0.28 demand, 0.012 steal).
  assertEquals(limitPressing(p, 0.268 / 8, 0.012 / 8), true);
  // Smaller plan (KVM 1, limit 0.4): proportional thresholds still fire.
  assertEquals(limitPressing(plan(1), 0.35, 0.02), true);
});
