import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  allowedCores,
  canProbeSlice,
  charged,
  creditStep,
  evidentSteal,
  LAW,
  limitConfirmed,
  limitOnsetSample,
  limitPressing,
  MARGIN,
  pinnedAtCap,
  PROBE_MIN_DEMAND,
  probeMinDemand,
  quietAfterLiftSeconds,
  replay,
  sliceCeiling,
  sliceDemand,
  widen,
} from "../src/credits.ts";
import { plan, RULES_SINCE } from "../src/plans.ts";
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

Deno.test("the mirror follows the rules with a conservative margin", () => {
  assertEquals(creditStep(kvm8, 34_560, 8, 10_800, { mul: 1, add: 0 }), 0);
  const level = (4.8 - MARGIN.add) / MARGIN.mul;
  assertEquals(Math.round(creditStep(kvm8, 20_000, level, 3_600, MARGIN)), 20_000);
  assertEquals(charged(2, MARGIN), 2.18);
  assertEquals(creditStep(kvm8, 1_000, 0.2, 60, MARGIN, false), 982.6);
});

Deno.test("the spend law glides onto the floor and spends every core above it", () => {
  assertEquals(allowedCores(kvm8, kvm8.capacity, MARGIN), 8);
  assertEquals(
    allowedCores(kvm8, LAW.floor * kvm8.capacity, MARGIN).toFixed(3),
    ((4.8 - 0.08) / 1.05).toFixed(3),
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

Deno.test("a limit widens the margin by the drift it proves", () => {
  assertEquals(widen(MARGIN, 5_000, 100_000), { mul: 1.1125, add: 0.1 });
  assertEquals(widen(MARGIN, 5_000, 1_000), MARGIN);
});

Deno.test("Hostinger's readings replay to a lower bound, exact once full", () => {
  const h = 1_798_000;
  const times = [RULES_SINCE];
  const spacings = [1798, 1520, 2101, 1911, 1670, 2300, 1807];
  for (let i = 1; i < 30; i++) {
    times.push(times[i - 1] + spacings[(i - 1) % spacings.length] * 1000);
  }
  const at = (i: number) => times[i];
  assertEquals(replay(kvm8, [{ at: RULES_SINCE - h, v: 0 }, { at: at(0), v: 0 }]), null);
  const quiet = replay(kvm8, Array.from({ length: 30 }, (_, i) => ({ at: at(i), v: 20 })))!;
  assertEquals([quiet.balance, quiet.exact], [kvm8.capacity, true]);
  const busy = replay(kvm8, Array.from({ length: 5 }, (_, i) => ({ at: at(i), v: 70 })))!;
  assertEquals([busy.balance, busy.exact], [0, false]);
});

Deno.test("each reading's charge covers its own interval, not a fixed half hour", () => {
  // KVM 8 earns 4.8 cores: 10% of 8 vCPUs banks 4 cores, 50% banks 0.8.
  assertEquals(kvm8.baseline, 4.8);
  const at = RULES_SINCE;
  const r = replay(kvm8, [
    { at, v: 10 },
    { at: at + 900_000, v: 10 },
    { at: at + 3_600_000, v: 10 },
    { at: at + 4_800_000, v: 50 },
  ])!;
  assertAlmostEquals(r.balance, 4 * 900 + 4 * 2700 + 0.8 * 1200, 1e-6);
  assertEquals(r.at, at + 4_800_000);
});

Deno.test("a stopped VPS or unknown API gap cannot certify a full bank", () => {
  const at = RULES_SINCE;
  const r = replay(kvm8, [{ at, v: 0 }, { at: at + 10_800_000, v: 0 }])!;
  assertEquals(r.exact, false);
  assertEquals(r.balance, 0);
});

Deno.test("a gap invalidates certainty even after an earlier full bank", () => {
  const quiet = Array.from({ length: 10 }, (_, i) => ({ at: RULES_SINCE + i * 1_798_000, v: 0 }));
  quiet.push({ at: RULES_SINCE + 30 * 1_800_000, v: 0 });
  assertEquals(replay(kvm8, quiet)!.exact, false);
});

Deno.test("learning can compensate for a baseline that is twice the real one", () => {
  let m = MARGIN;
  for (let i = 0; i < 30; i++) m = widen(m, 10_000, 100_000);
  assertEquals(allowedCores(kvm8, kvm8.recovered, m) <= 2.4, true);
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
      if (t > 0) mirror = creditStep(p, mirror, tickBusy / tick, tick, MARGIN);
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

Deno.test("limitPressing and limitOnsetSample reject idle neighbour steal and above-cap delivery while keeping per-vCPU caps", () => {
  const p = plan(8);
  // Idle box with 0.15 busy + 0.005 steal (3.2% of demand): neither pressing nor limit onset.
  assertEquals(limitPressing(p, 0.15 / 8, 0.005 / 8), false);
  assertEquals(limitOnsetSample(p, 0.15 / 8, 0.03 / 8), false);
  // Healthy busy box delivering more than p.limit (3.0 > 2.4 + 0.1) cannot be a credit limit onset.
  assertEquals(limitOnsetSample(p, 3.0 / 8, 0.4 / 8), false);
  // Single thread under KVM 8 per-vCPU 0.30-core cap at 28% ceiling (0.28 demand, 0.012 steal).
  assertEquals(limitPressing(p, 0.268 / 8, 0.012 / 8), true);
  // Single thread clearly hitting KVM 8 per-vCPU cap (0.30 busy, 0.20 steal).
  assertEquals(limitOnsetSample(p, 0.30 / 8, 0.20 / 8), true);
  // Smaller plan (KVM 1, limit 0.4): proportional thresholds still fire.
  assertEquals(limitPressing(plan(1), 0.35, 0.02), true);
  assertEquals(limitOnsetSample(plan(1), 0.35, 0.15), true);
});
