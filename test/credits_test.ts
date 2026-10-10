import { assertEquals } from "@std/assert";
import {
  allowedCores,
  charged,
  creditStep,
  LAW,
  limitConfirmed,
  MARGIN,
  replay,
  sliceCeiling,
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
  const h = 1_800_000;
  const at = (i: number) => RULES_SINCE + i * h;
  assertEquals(replay(kvm8, [{ at: RULES_SINCE - h, v: 0 }, { at: at(0), v: 0 }]), null);
  const quiet = replay(kvm8, Array.from({ length: 30 }, (_, i) => ({ at: at(i), v: 20 })))!;
  assertEquals([quiet.balance, quiet.exact], [kvm8.capacity, true]);
  const busy = replay(kvm8, Array.from({ length: 5 }, (_, i) => ({ at: at(i), v: 70 })))!;
  assertEquals([busy.balance, busy.exact], [0, false]);
});

Deno.test("a stopped VPS or unknown API gap cannot certify a full bank", () => {
  const at = RULES_SINCE;
  const r = replay(kvm8, [{ at, v: 0 }, { at: at + 10_800_000, v: 0 }])!;
  assertEquals(r.exact, false);
  assertEquals(r.balance, 0);
});

Deno.test("a gap invalidates certainty even after an earlier full bank", () => {
  const quiet = Array.from({ length: 10 }, (_, i) => ({ at: RULES_SINCE + i * 1_800_000, v: 0 }));
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
