// The credit estimate's arithmetic: what a reading does to the anchor, what the own count does to
// the tail, and what a credit limit teaches.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  billedSteal,
  billingGap,
  ESTIMATE,
  type Estimate,
  learnedPad,
  margin,
  maxDrain,
  mostAdded,
  ownCharge,
  type Sample,
  settle,
  stale,
  tail,
} from "../src/estimate.ts";
import { plan } from "../src/plans.ts";

const p = plan(8);
const T0 = Date.parse("2026-11-01T00:00:00Z");
const HALF = 1_800_000;
const fresh = (balance?: number, at = T0): Estimate => ({
  ...(balance === undefined ? {} : { anchor: { at, balance } }),
  pad: ESTIMATE.pad,
  excess: [],
  known: { at: T0, slack: 0 },
});
// Readings every half hour from T0, in cores.
const readings = (...cores: number[]) =>
  [0, ...cores].map((c, i) => ({ at: T0 + i * HALF, v: c / p.vcpus * 100 }));
// 30-second samples covering [from, to) at `cores` busy.
const samples = (from: number, to: number, cores: number, steal = 0): Sample[] =>
  Array.from({ length: (to - from) / 30_000 }, (_, i) => ({
    at: from + (i + 1) * 30_000,
    seconds: 30,
    busy: cores / p.vcpus,
    steal: steal / p.vcpus,
    outside: 0,
    earning: true,
  }));

Deno.test("the own count charges 1.05 times busy CPU plus 0.04, and what readings showed above that", () => {
  assertEquals(margin(p, fresh()), { mul: 1.05, add: 0.04 });
  // Seven readings are too few to move the addition.
  assertEquals(margin(p, { pad: ESTIMATE.pad, excess: Array(7).fill(0.3) }).add, 0.04);
  // Eight: their mean plus two deviations.
  assertAlmostEquals(margin(p, { pad: ESTIMATE.pad, excess: Array(8).fill(0.3) }).add, 0.3);
  const spread = [0.1, 0.3, 0.1, 0.3, 0.1, 0.3, 0.1, 0.3];
  assertAlmostEquals(margin(p, { pad: ESTIMATE.pad, excess: spread }).add, 0.2 + 2 * 0.1);
  // Readings under the own count never take the addition below the fixed one.
  assertEquals(margin(p, { pad: ESTIMATE.pad, excess: Array(8).fill(-0.5) }).add, 0.04);
  // A pad a limit raised is billed by the own count too.
  assertAlmostEquals(margin(p, { pad: ESTIMATE.pad + 0.1, excess: [] }).add, 0.14);
  // The addition stops where the allowance at the floor would fall under what the VM is left
  // while a limit recovers, 0.2 cores under the plan's limit: 4.8 - 1.05 x 2.2 cores on KVM 8,
  // 0.6 - 1.05 x 0.2 on KVM 1.
  assertAlmostEquals(mostAdded(p), 2.49);
  assertAlmostEquals(margin(p, { pad: 9, excess: [] }).add, 2.49);
  assertAlmostEquals(margin(p, { pad: ESTIMATE.pad, excess: Array(8).fill(5) }).add, 2.49);
  assertAlmostEquals(mostAdded(plan(1)), 0.39);
  // A baseline configured at 25% is under the plan's limit: the fixed addition still stands.
  assertEquals(mostAdded(plan(8, undefined, 0.25)), ESTIMATE.add);
  assertEquals(margin(plan(8, undefined, 0.25), fresh()).add, 0.04);
  assertAlmostEquals(margin(plan(1), { pad: 1, excess: [] }).add, 0.39);
});

Deno.test("stolen CPU is charged whole while the VM delivers more than a limit could, and not at or under it", () => {
  const steal = 1 / p.vcpus;
  // 3 cores delivered: more than the 2.4-core limit allows, so the steal is the neighbours'.
  assertAlmostEquals(billedSteal(p, { busy: 3 / p.vcpus, steal }), 1);
  assertAlmostEquals(
    ownCharge(p, { busy: 3 / p.vcpus, steal }, margin(p, fresh())),
    3.15 + 1 + 0.04,
  );
  // At the limit, and a tenth of a core over it, the steal may be a limit's own.
  assertEquals(billedSteal(p, { busy: 2.4 / p.vcpus, steal }), 0);
  assertEquals(billedSteal(p, { busy: 2.5 / p.vcpus, steal }), 0);
  assert(billedSteal(p, { busy: 2.51 / p.vcpus, steal }) > 0);
  // Inside a recognised limit no steal is billed.
  assertEquals(billedSteal(p, { busy: 3 / p.vcpus, steal, limited: true }), 0);
});

Deno.test("readings move the anchor both ways through Hostinger's rules", () => {
  const e = fresh(10_000);
  // Half an hour at 2 cores earns (4.8 - 2.02) a second; half an hour at 7 cores spends.
  const rs = readings(2, 7);
  const own = [...samples(T0, T0 + HALF, 1.9), ...samples(T0 + HALF, T0 + 2 * HALF, 6.6)];
  assert(settle(p, e, rs, own));
  const up = 10_000 + (p.baseline - 2 - ESTIMATE.pad) * 1800;
  assertAlmostEquals(e.anchor!.balance, up + (p.baseline - 7 - ESTIMATE.pad) * 1800);
  assertEquals(e.anchor!.at, rs[2].at);
  assert(up > 10_000 && e.anchor!.balance < up);
  // Nothing new settled: the anchor stays.
  assertEquals(settle(p, e, rs, own), false);
});

Deno.test("readings from before the anchor are never replayed, and without an anchor they move nothing", () => {
  // Two idle days of readings cannot say whether a limit stopped the bank earning then.
  const none = fresh();
  assertEquals(settle(p, none, readings(...Array(96).fill(0.5)), []), false);
  assertEquals(none.anchor, undefined);
  // With an anchor, only what came after it counts. Nobody watched it here, so it earns nothing.
  const late = fresh(5000, T0 + 95 * HALF);
  assert(settle(p, late, readings(...Array(96).fill(0.5)), []));
  assertAlmostEquals(late.anchor!.balance, 5000 - (0.5 + ESTIMATE.pad) * 1800);
  // No reading from at or before the anchor: the time between would count for nothing, so the
  // anchor waits.
  const early = fresh(5000, T0 - 10 * HALF);
  assertEquals(settle(p, early, readings(2), []), false);
  assertEquals(early.anchor, { at: T0 - 10 * HALF, balance: 5000 });
});

Deno.test("a reading under the guest's own count is a broken feed, and one far over it is held", () => {
  const own = samples(T0, T0 + HALF, 4);
  // The guest itself counted 4 cores. No bill for them can be 1: the own count stands in, and
  // nothing is remembered of the reading.
  const low = fresh(10_000);
  settle(p, low, readings(1), own);
  assertAlmostEquals(low.anchor!.balance, 10_000 + (p.baseline - 4.2 - 0.04) * 1800);
  assertEquals(low.excess, []);
  // A feed that reads eight times too high cannot starve the box.
  const high = fresh(20_000);
  settle(p, high, readings(8), own);
  assertAlmostEquals(
    high.anchor!.balance,
    20_000 + (p.baseline - (1.3 * 4 + 0.3) - ESTIMATE.pad) * 1800,
  );
  // The ceiling leaves room for what the neighbours stole, which the readings count.
  const stolen = fresh(20_000);
  settle(p, stolen, readings(8), samples(T0, T0 + HALF, 4, 1));
  assertAlmostEquals(
    stolen.anchor!.balance,
    20_000 + (p.baseline - (1.3 * 4 + 1 + 0.3) - ESTIMATE.pad) * 1800,
  );
  // That steal was charged by the own count already, so it is no part of what the reading
  // showed above it.
  assertAlmostEquals(stolen.excess[0], 1.3 * 4 + 1 + 0.3 - 1.05 * 4 - 1);
  // In between, the reading stands, and its distance from the own count is remembered.
  const mid = fresh(10_000);
  settle(p, mid, readings(4.3), own);
  assertAlmostEquals(mid.anchor!.balance, 10_000 + (p.baseline - 4.3 - ESTIMATE.pad) * 1800);
  assertAlmostEquals(mid.excess[0], 4.3 - 1.05 * 4);
  // A reading that equals the own count is a bill, if a low one.
  const even = fresh(10_000);
  settle(p, even, readings(4), own);
  assertAlmostEquals(even.anchor!.balance, 10_000 + (p.baseline - 4 - ESTIMATE.pad) * 1800);
});

Deno.test("samples must cover nine tenths of a reading's interval to stand beside it", () => {
  // 27 of 30 minutes: covered, so the feed that reads low is caught.
  const most = fresh(10_000);
  settle(p, most, readings(1), samples(T0, T0 + 1_620_000, 4));
  // The three minutes without samples have no usable reading either: they count at the most
  // the VM could have spent.
  const drain = maxDrain(p, margin(p, most));
  assertAlmostEquals(most.anchor!.balance, 10_000 + (p.baseline - 4.24) * 1620 - drain * 180);
  // A reading that stands over those 27 minutes is checked by them, and counts toward the
  // addition.
  const checked = fresh(10_000);
  settle(p, checked, readings(4.3), samples(T0, T0 + 1_620_000, 4));
  assertEquals(checked.excess.length, 1);
  // 26 minutes: too few to check the reading's mean by. It stands if it covers at least the
  // core-seconds those minutes counted: 4 cores over 26 of 30 minutes is 3.47 on average. The
  // watched minutes earn, and the four that nobody watched pay the reading and earn nothing.
  const less = fresh(10_000);
  settle(p, less, readings(3.5), samples(T0, T0 + 1_560_000, 4));
  const bill = 3.5 + ESTIMATE.pad;
  assertAlmostEquals(less.anchor!.balance, 10_000 + (p.baseline - bill) * 1560 - bill * 240);
  assertEquals(less.excess, []);
  // A reading under that cannot be the bill, whatever ran in the four minutes: the feed is
  // broken. The own count stands in for the watched minutes, and the rest counts at the most.
  const low = fresh(10_000);
  settle(p, low, readings(3.4), samples(T0, T0 + 1_560_000, 4));
  assertAlmostEquals(low.anchor!.balance, 10_000 + (p.baseline - 4.24) * 1560 - drain * 240);
});

Deno.test("the readings remembered for the addition are the last 48", () => {
  const e = fresh(10_000);
  const n = 60;
  settle(p, e, readings(...Array(n).fill(4.3)), samples(T0, T0 + n * HALF, 4));
  assertEquals(e.excess.length, ESTIMATE.excessKept);
  assertEquals(ESTIMATE.excessKept, 48);
});

Deno.test("a bank that fills inside a reading's interval forgets what it earned there", () => {
  // Twenty idle minutes, then ten at every core: 2.67 cores on average.
  const own = [
    ...samples(T0, T0 + 1_200_000, 0),
    ...samples(T0 + 1_200_000, T0 + HALF, 8),
  ];
  const mean = 8 / 3, reading = 2.8;
  const e = fresh(p.capacity - 1000);
  settle(p, e, readings(reading), own);
  // The bank was full within four minutes, earned nothing more, and then spent for ten.
  const bill = reading + ESTIMATE.pad;
  const spent = (bill * 8 / mean - p.baseline) * 600;
  assertAlmostEquals(e.anchor!.balance, p.capacity - spent, 1);
  // Averaged over the interval, the same reading would have left the bank full.
  assert(p.capacity - 1000 + (p.baseline - bill) * 1800 > p.capacity);
});

Deno.test("an idle interval the daemon watched earns the baseline", () => {
  const e = fresh(5000);
  settle(p, e, readings(0), samples(T0, T0 + HALF, 0));
  assertAlmostEquals(e.anchor!.balance, 5000 + (p.baseline - ESTIMATE.pad) * 1800);
});

Deno.test("a gap in the samples costs the earnings of the gap, not of the half hour", () => {
  // An idle half hour with three and a half minutes unwatched in the middle, as after a slow
  // restart. 88% is too little to check the reading by, and enough to earn for.
  const own = [...samples(T0, T0 + 600_000, 0), ...samples(T0 + 810_000, T0 + HALF, 0)];
  const e = fresh(5000);
  settle(p, e, readings(0), own);
  assertAlmostEquals(
    e.anchor!.balance,
    5000 + (p.baseline - ESTIMATE.pad) * 1590 - ESTIMATE.pad * 210,
  );
  // With no usable reading, as in the first interval after a lift, the watched seconds go by
  // the own count and the gap counts at the most the VM could have spent.
  const late = fresh(5000, T0 + 30_000);
  settle(p, late, readings(0), own);
  const m = margin(p, late);
  assertAlmostEquals(
    late.anchor!.balance,
    5000 + (p.baseline - m.add) * 1560 - maxDrain(p, m) * 210,
  );
});

Deno.test("across a gap, a reading is checked only against CPU that certainly ran inside it", () => {
  // Ten idle minutes watched, then nothing, then one sample that straddles the end of the
  // interval: a job that started just after it gives that sample 3.75 cores on average, and
  // every one of its core-seconds may lie outside.
  const straddling: Sample = {
    at: T0 + HALF + 15_000,
    seconds: 30,
    busy: 3.75 / p.vcpus,
    steal: 0,
    outside: 0,
    earning: true,
  };
  const e = fresh(5000);
  settle(p, e, readings(0.01), [...samples(T0, T0 + 600_000, 0), straddling]);
  // The reading stands: 615 watched seconds earn and pay it in the shape of what they counted,
  // all of it in the 15 busy seconds, and the rest pay it and earn nothing.
  const bill = 0.01 + ESTIMATE.pad;
  const watched = 615 * p.baseline - bill * 615;
  assertAlmostEquals(e.anchor!.balance, 5000 + watched - bill * 1185, 1e-6);
  // A reading that exactly matches what the samples counted is no broken feed: three cores for
  // three minutes is 0.3 cores over the half hour, to the last digit or not.
  const exact = fresh(5000);
  settle(p, exact, readings(0.3), samples(T0 + 600_000, T0 + 780_000, 3));
  assertAlmostEquals(
    exact.anchor!.balance,
    5000 + (p.baseline - 0.32) * 180 - 0.32 * 1620,
    1e-6,
  );
});

Deno.test("time no sample watched is billed and earns nothing", () => {
  // A limit may have come and gone unseen, and one pauses earning while work presses on it.
  const mean = 8 / 3, bill = mean + ESTIMATE.pad;
  const e = fresh(p.capacity - 1000);
  settle(p, e, readings(mean), []);
  assertAlmostEquals(e.anchor!.balance, p.capacity - 1000 - bill * 1800);
  // Even an idle half hour earns nothing unwatched: the estimate stays a lower bound.
  const idle = fresh(5000);
  settle(p, idle, readings(0), []);
  assertAlmostEquals(idle.anchor!.balance, 5000 - ESTIMATE.pad * 1800);
  assertEquals(idle.known, { at: T0, slack: 0 });
});

Deno.test("a full bank is known, and a replay never leaves the bank's bounds", () => {
  const e = fresh(p.capacity - 100);
  const rs = readings(0.2);
  settle(p, e, rs, samples(T0, T0 + HALF, 0.2));
  assertEquals(e.anchor!.balance, p.capacity);
  assertEquals(e.known, { at: rs[1].at, slack: 0 });
  // A point already known later is the better one to measure from, and stays.
  const later = { ...fresh(p.capacity - 100), known: { at: rs[1].at + 1, slack: 5 } };
  settle(p, later, rs, samples(T0, T0 + HALF, 0.2));
  assertEquals(later.known, { at: rs[1].at + 1, slack: 5 });
  // Uptime and the wall clock drift apart by a little. Samples that cover a hair less than the
  // interval, or a hair more, leave a full bank full and make no credits.
  for (const seconds of [29.99, 30.01]) {
    const drift = samples(T0, T0 + HALF, 0.2).map((x) => ({ ...x, seconds }));
    const full = fresh(p.capacity);
    settle(p, full, rs, drift);
    assertEquals(full.anchor!.balance, p.capacity);
    assertEquals(full.known.at, rs[1].at);
    const spent = fresh(0);
    settle(p, spent, readings(8), samples(T0, T0 + HALF, 8).map((x) => ({ ...x, seconds })));
    assertEquals(spent.anchor!.balance, 0);
  }
  const empty = fresh(100);
  settle(p, empty, readings(8), samples(T0, T0 + HALF, 8));
  assertEquals(empty.anchor!.balance, 0);
});

Deno.test("an interval too long to trust runs on the own count, or counts at the most the VM could spend", () => {
  const long = [{ at: T0, v: 0 }, { at: T0 + 2 * HALF, v: 100 }];
  const covered = fresh(10_000);
  settle(p, covered, long, samples(T0, T0 + 2 * HALF, 3));
  assertAlmostEquals(covered.anchor!.balance, 10_000 + (p.baseline - 3.15 - 0.04) * 3600);
  // The own count charges the neighbours' steal there too.
  const stolen = fresh(20_000);
  settle(p, stolen, long, samples(T0, T0 + 2 * HALF, 3, 1));
  assertAlmostEquals(stolen.anchor!.balance, 20_000 + (p.baseline - 3.15 - 1 - 0.04) * 3600);
  // With no sample either, nobody watched that hour: every vCPU may have been busy.
  const bare = fresh(30_000);
  settle(p, bare, long, []);
  assertAlmostEquals(bare.anchor!.balance, 30_000 - maxDrain(p, margin(p, bare)) * 3600);
  const low = fresh(10_000);
  settle(p, low, long, []);
  assertEquals(low.anchor!.balance, 0);
});

Deno.test("a reading that began before the anchor counts only the time after it", () => {
  // A lift or a seed put the anchor ten minutes into the interval.
  const at = T0 + 600_000;
  const e = fresh(7000, at);
  settle(p, e, readings(6), samples(T0, T0 + HALF, 3));
  // The reading averages time the anchor already settled, so the own count stands in.
  assertAlmostEquals(e.anchor!.balance, 7000 + (p.baseline - 3.15 - 0.04) * 1200);
  // Without samples nobody watched that time, and the reading cannot say how much of its CPU
  // ran after the anchor: it counts at the most the VM could have spent.
  const bare = fresh(7000, at);
  settle(p, bare, readings(6), []);
  assertAlmostEquals(bare.anchor!.balance, 7000 - maxDrain(p, margin(p, bare)) * 1200);
});

Deno.test("a sample whose place in time is unknown covers no reading", () => {
  const own = samples(T0, T0 + HALF, 4).map((x) => ({ ...x, clockValid: false }));
  const e = fresh(10_000);
  settle(p, e, readings(1), own);
  // Uncovered, so the reading stands unguarded, and earns nothing.
  assertAlmostEquals(e.anchor!.balance, 10_000 - (1 + ESTIMATE.pad) * 1800);
  assertEquals(e.excess, []);
});

Deno.test("a sample over time the daemon was stopped covers no reading", () => {
  // Two hours stopped: one idle, one with every core busy outside the slice. The one sample the
  // restart makes knows only the mean, four cores.
  const stopped: Sample = {
    at: T0 + 4 * HALF,
    seconds: 7200,
    busy: 0.5,
    steal: 0,
    outside: 4,
    earning: false,
    unobserved: true,
  };
  const e = fresh(p.capacity);
  settle(p, e, readings(0, 0, 8, 8), [stopped]);
  // Laid beside the readings, that mean would pass the idle hour for a broken feed and hold the
  // busy hour's 8 cores to 5.5. The readings stand as they are, and the two hours earn nothing:
  // the bank may have run empty in the busy hour, with a limit that paused it.
  assertAlmostEquals(
    e.anchor!.balance,
    p.capacity - ESTIMATE.pad * 3600 - (8 + ESTIMATE.pad) * 3600,
  );
  assertEquals(e.excess, []);
  // The estimate still charges the stop from that sample, and earns nothing for it.
  const m = margin(p, fresh());
  assertAlmostEquals(
    tail(p, { at: T0, balance: p.capacity }, [stopped], m, T0 + 4 * HALF),
    p.capacity - (1.05 * 4 + 0.04) * 7200,
  );
});

Deno.test("the estimate is the anchor plus the own count since", () => {
  const m = margin(p, fresh());
  const own = samples(T0 - 600_000, T0 + 600_000, 6);
  // Only the ten minutes after the anchor count.
  assertAlmostEquals(
    tail(p, { at: T0, balance: 10_000 }, own, m, T0 + 600_000),
    10_000 + (p.baseline - 6.3 - 0.04) * 600,
  );
  // A sample that earned nothing, as while pressing on a limit, only spends.
  const paused = samples(T0, T0 + 600_000, 2).map((x) => ({ ...x, earning: false }));
  assertAlmostEquals(
    tail(p, { at: T0, balance: 10_000 }, paused, m, T0 + 600_000),
    10_000 - (2.1 + 0.04) * 600,
  );
});

Deno.test("time since the anchor that no sample covers counts at the most the VM could spend", () => {
  const m = margin(p, fresh());
  const drain = maxDrain(p, m);
  assertAlmostEquals(drain, 8.4 + 0.04 - p.baseline);
  // Twenty minutes of samples, then forty the daemon did not see.
  const own = samples(T0, T0 + 1_200_000, 0);
  const counted = 10_000 + (p.baseline - 0.04) * 1200;
  assertAlmostEquals(
    tail(p, { at: T0, balance: 10_000 }, own, m, T0 + 3_600_000),
    Math.max(0, counted - drain * 2400),
  );
  // A minute of drift between wall clock and uptime is not a hole.
  assertAlmostEquals(tail(p, { at: T0, balance: 10_000 }, own, m, T0 + 1_260_000), counted);
  // Samples from before a clock step have no place after the anchor: their time is a hole.
  const misplaced = own.map((x) => ({ ...x, clockValid: false }));
  assertAlmostEquals(
    tail(p, { at: T0, balance: 30_000 }, misplaced, m, T0 + 1_200_000),
    30_000 - drain * 1200,
  );
  assertEquals(tail(p, { at: T0, balance: 100 }, [], m, T0 + 3_600_000), 0);
});

Deno.test("readings are stale after two hours without a settled one", () => {
  const rs = readings(1);
  assertEquals(stale(rs, rs[1].at + ESTIMATE.staleMs), false);
  assertEquals(stale(rs, rs[1].at + ESTIMATE.staleMs + 1), true);
  assertEquals(stale([], T0), true);
});

Deno.test("a credit limit teaches the billing its readings missed, with a quarter extra", () => {
  // The bank emptied while the estimate showed 3,600 core-seconds, ten hours after it was full.
  const gap = billingGap(3600, 0, 36_000);
  assertAlmostEquals(gap, 0.1);
  assertAlmostEquals(learnedPad(p, ESTIMATE.pad, gap), ESTIMATE.pad + 0.125);
  // What the estimate held back at a lift counts as well.
  assertAlmostEquals(billingGap(3600, 1800, 36_000), 0.15);
  // Under an hour the rate is mostly noise: an hour counts at least.
  assertAlmostEquals(billingGap(360, 0, 60), 0.1);
  // No gap teaches nothing, no limit teaches more than a core at once, and the pad stops where
  // the own count's addition does.
  assertEquals(learnedPad(p, ESTIMATE.pad, 0), ESTIMATE.pad);
  assertAlmostEquals(learnedPad(p, ESTIMATE.pad, 5), ESTIMATE.pad + 1);
  assertAlmostEquals(learnedPad(p, 2, 5), 2.49);
  assertAlmostEquals(learnedPad(plan(1), ESTIMATE.pad, 5), 0.39);
});
