// The control loop on a fake box: what a pass does to the estimate and the ceiling, how a credit
// limit is found, held and left, and what survives requests, restarts and upgrades.
import { assert, assertAlmostEquals, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  compareReadings,
  controlPass,
  creditCap,
  Governor,
  legacySettings,
  openGovernor,
  type PublicState,
  startLine,
  validateConfig,
} from "../src/governor.ts";
import { allowedCores, LAW, recoveryCeiling, sliceCeiling } from "../src/credits.ts";
import { ESTIMATE, margin, maxDrain } from "../src/estimate.ts";
import { FEED, fixture, p, start } from "./governor-fixture.ts";
import { testDirectory } from "./temp.ts";

const FLOOR = LAW.floor * p.capacity;
const M = { mul: 1.05, add: 0.04 };
// Half-hourly readings ending `ago` half hours before `at`, in cores.
const readings = (at: number, ...cores: number[]) =>
  cores.map((c, i) => ({ at: at - (cores.length - 1 - i) * 1_800_000, v: c / p.vcpus * 100 }));
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
};
const test = (name: string, run: () => Promise<void>) => Deno.test(name, () => quiet(run));

test("a first start knows nothing: the estimate is empty and the slice gets a cautious ceiling", async () => {
  const f = fixture();
  await f.advance();
  const state = f.g.publicState(f.at);
  assertEquals(state.credits.balance, 0);
  assertEquals(state.credits.rebuilding?.reason, "first-start");
  // Under the floor the allowance refills it over an hour: (4.8 - 0.96 - 0.04) / 1.05 cores,
  // less the 0.4 assumed outside the slice before anything is measured.
  assertEquals(f.cap, 320);
  assertEquals(state.ceiling, 320);
  assertEquals(state.accepting, true);
  assertEquals(state.schemaVersion, 1);
});

test("initial_balance states the bank a first start begins with", async () => {
  const f = fixture({ initial_balance: 10_000 });
  await f.advance();
  assertEquals(f.g.s.balance, 10_000);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: 10_000 });
  assertEquals(f.g.s.estimate.known, { at: f.at, slack: 0 });
  assertEquals(f.g.publicState(f.at).credits.rebuilding, null);
  assertEquals(fixture({ initial_balance: 1e9 }).g.s.balance, p.capacity);
});

test("each pass earns the baseline and charges what ran, at the margin", async () => {
  const f = fixture({ initial_balance: 10_000 });
  await f.advance();
  await f.advance(30, 0.5);
  assertAlmostEquals(f.g.s.balance, 10_000 + (p.baseline - (1.05 * 4 + 0.04)) * 30);
  await f.advance(30, 1);
  assertAlmostEquals(f.g.s.balance, 10_000 + (4.8 - 4.24) * 30 + (4.8 - 8.44) * 30);
  // Neighbours' steal is charged whole while the VM delivers more than a limit could.
  const before = f.g.s.balance;
  await f.advance(30, 0.5, 0.125);
  assertAlmostEquals(f.g.s.balance, before + (4.8 - 4.24 - 1) * 30);
  // At or under the limit's 2.4 cores, steal may be a limit's own and is not charged.
  const low = f.g.s.balance;
  await f.advance(30, 0.3, 0.125);
  assertAlmostEquals(f.g.s.balance, low + (4.8 - (1.05 * 2.4 + 0.04)) * 30);
  assertEquals(f.g.s.balance <= p.capacity, true);
});

test("the ceiling spends what the estimate holds above the floor, and holds the baseline at it", async () => {
  const f = fixture({ initial_balance: FLOOR });
  await f.advance();
  for (const balance of [0, FLOOR, FLOOR + 1800, FLOOR + 3600, p.capacity]) {
    f.g.s.balance = balance;
    // A pass at the baseline's cost leaves the estimate where it is.
    await f.advance(30, (p.baseline - M.add) / M.mul / p.vcpus);
    assertAlmostEquals(f.g.s.balance, balance, 1e-6);
    assertEquals(f.cap, sliceCeiling(p, allowedCores(p, balance, M), 0), `at ${balance}`);
  }
  // At the floor: the baseline. An hour's credits above it buy two more cores for half an hour.
  assertEquals(sliceCeiling(p, allowedCores(p, FLOOR, M), 0), 450);
  assertEquals(sliceCeiling(p, allowedCores(p, FLOOR + 3600, M), 0), 640);
  assertEquals(sliceCeiling(p, allowedCores(p, p.capacity, M), 0), 800);
  assertEquals(sliceCeiling(p, allowedCores(p, 0, M), 0), 360);
});

test("work outside the slice comes out of the slice's ceiling", async () => {
  const f = fixture({ initial_balance: FLOOR });
  await f.advance();
  // Two cores busy, 1.05 of them outside the slice.
  await f.advance(30, 0.25, 0, 0.95);
  assertEquals(f.cap, sliceCeiling(p, allowedCores(p, f.g.s.balance, M), 1.05));
  assertEquals(f.cap, 350);
  assertAlmostEquals(f.g.publicState(f.at).coverage.outsideCores, 1.05);
});

test("on four vCPUs and more a ceiling rise under 20 points waits", async () => {
  const f = fixture({ initial_balance: FLOOR + 1800 });
  await f.advance();
  await f.advance(30, 0.5);
  const cap = f.cap;
  f.g.s.balance += 150;
  await f.advance(30, (p.baseline - M.add) / M.mul / p.vcpus);
  assertEquals(f.cap, cap);
  // A cut is never delayed.
  f.g.s.balance -= 600;
  await f.advance(30, (p.baseline - M.add) / M.mul / p.vcpus);
  assert(f.cap < cap);
});

test("readings replace the own count once they settle, in both directions", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  // The daemon's first pass, where a reading has just closed. It fetches every half hour.
  const t1 = start + 30_000, half = 1_800_000;
  const cores = (c: number) => c / p.vcpus * 100;
  f.world.readings = [{ at: t1 - half, v: 0 }, { at: t1, v: 0 }];
  await f.advance();
  await f.run(59, 0.5);
  // Hostinger's reading for the first half hour says 4.5 cores. It is settled once a newer one
  // exists.
  f.world.readings.push({ at: t1 + half, v: cores(4.5) }, { at: t1 + half + 60_000, v: 0 });
  await f.advance(30, 0.5);
  // Until the fetch lands, the estimate is the guest's own count of that half hour at 4 cores.
  const own = 20_000 + (4.8 - 4.24) * 1800;
  assertAlmostEquals(f.g.s.balance, own, 1e-6);
  await f.advance(30, 0.5);
  const settled = 20_000 + (4.8 - 4.5 - ESTIMATE.pad) * 1800;
  assertEquals(f.g.s.estimate.anchor!.at, t1 + half);
  assertAlmostEquals(f.g.s.estimate.anchor!.balance, settled, 1e-6);
  // The estimate is that anchor and the pass counted since: under what the own count had.
  assertAlmostEquals(f.g.s.balance, settled + (4.8 - 4.24) * 30, 1e-6);
  assert(f.g.s.balance < own);
  assertEquals(f.g.publicState(f.at).credits.anchor?.applied, true);
  // The next reading says 4.1 cores where the own count charged 4.24: the estimate rises.
  await f.run(58, 0.5);
  f.world.readings.pop();
  f.world.readings.push({ at: t1 + 2 * half, v: cores(4.1) }, { at: t1 + 2 * half + 60_000, v: 0 });
  await f.run(2, 0.5);
  assertEquals(f.g.s.estimate.anchor!.at, t1 + 2 * half);
  assertAlmostEquals(
    f.g.s.estimate.anchor!.balance,
    settled + (4.8 - 4.1 - ESTIMATE.pad) * 1800,
    1e-6,
  );
  assert(f.g.s.balance > settled + (4.8 - 4.24) * 1830);
  // One that says 3 cores, less than the guest counted itself, is not a bill: the own count
  // stands, and the estimate does not rise on it.
  await f.run(58, 0.5);
  const before = f.g.s.balance;
  f.world.readings.pop();
  f.world.readings.push({ at: t1 + 3 * half, v: cores(3) }, { at: t1 + 3 * half + 60_000, v: 0 });
  await f.run(2, 0.5);
  assertEquals(f.g.s.estimate.anchor!.at, t1 + 3 * half);
  assertAlmostEquals(f.g.s.balance, before + (4.8 - 4.24) * 60, 1e-6);
});

test("a first start follows the readings from its first pass, and replays none from before", async () => {
  const f = fixture(FEED);
  // Two days at 0.8 cores: the real bank is full. But readings cannot say whether a limit
  // stopped it earning in that time, so the estimate starts empty, as a lower bound.
  f.world.readings = readings(start, ...Array(96).fill(0.8));
  await f.advance();
  await f.advance();
  assertAlmostEquals(f.g.s.balance, (4.8 - 0.04) * 30, 1e-6);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: f.g.s.balance });
  assertEquals(f.g.publicState(f.at).credits.rebuilding?.reason, "first-start");
  // From there the readings move it. Half an hour on, one says the VM idled.
  await f.run(58);
  f.world.readings = [
    ...f.world.readings,
    { at: f.at + 30_000, v: 0.3 / p.vcpus * 100 },
    { at: f.at + 60_000, v: 0 },
  ];
  await f.run(2);
  assertEquals(f.g.s.estimate.anchor!.at, f.at - 30_000);
  assert(f.g.s.balance > (4.8 - 0.4) * 1800);
});

test("readings from another VM, or without a feed, change nothing", async () => {
  const f = fixture();
  f.world.readings = readings(start, 1, 1, 1);
  await f.run(3);
  assertEquals(f.world.fetches, 0);
  assertEquals(f.g.publicState(f.at).credits.anchor, null);
  const fed = fixture({ ...FEED, initial_balance: 5000 });
  fed.world.readings = readings(start, 1, 1, 1);
  await fed.run(3);
  assertEquals(fed.g.s.readings.length, 2);
  const other = fed.restart({ hostinger: { ...FEED.hostinger, vm_id: 2 } });
  assertEquals(other.s.readings, []);
  assertEquals(other.s.balance, 0);
  assertEquals(other.s.estimate.anchor, undefined);
});

test("a reading that cannot be Hostinger's is refused with the whole fetch", async () => {
  const f = fixture({ ...FEED, initial_balance: 5000 });
  f.world.readings = [...readings(start, 1, 1), { at: start + 1, v: 250 }];
  await f.run(3);
  assertEquals(f.g.s.readings, []);
  assertEquals(f.g.s.fetchedAt, undefined);
});

test("steal that is most of the demand is a limit at once", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  // 1.6 cores delivered of 4.8 asked for.
  await f.run(2, 0.2, 0.4);
  assertEquals(f.g.s.limit, undefined);
  await f.advance(30, 0.2, 0.4);
  const limit = f.g.s.limit!;
  assertEquals(f.world.events, ["limit-start"]);
  assertEquals(f.g.s.balance, 0);
  // The estimate rose for those 90 seconds, as it does under a limit nobody has recognised yet.
  // What the limit found is what it read before that.
  assertEquals(limit.entry!.balance, 20_000);
  assertAlmostEquals(f.g.s.samples.at(-1)!.balance!, 20_000 + 2 * (4.8 - 1.72) * 30, 1e-6);
  // Held under the 2.4-core limit with room to spare.
  assertEquals(f.cap, recoveryCeiling(p, 0));
  assertEquals(f.cap, 210);
  const state = f.g.publicState(f.at);
  assertEquals(state.accepting, false);
  assertEquals(state.limit?.since, limit.since);
  assertEquals("cap" in state.limit!, false);
});

test("what a limit found is looked for in the 20 minutes before it, and no further back", async () => {
  const f = fixture({ initial_balance: 1000 });
  await f.advance();
  // Fifty idle minutes: the estimate was at 1,000 once, and that says nothing about this limit.
  await f.run(100);
  await f.run(3, 0.2, 0.4);
  const limit = f.g.s.limit!;
  // The window holds the 41 passes that ended in those 20 minutes; the first began one earlier.
  const rise = (4.8 - 0.04) * 30;
  assertAlmostEquals(limit.entry!.balance, 1000 + (100 + 3 - 41) * rise, 1e-6);
  // A bank that filled is a point to measure from.
  const full = fixture({ initial_balance: p.capacity - 100 });
  await full.advance();
  await full.advance();
  assertEquals(full.g.s.balance, p.capacity);
  assertEquals(full.g.s.estimate.known, { at: full.at, slack: 0 });
  await full.advance(30, 1);
  assertEquals(full.g.s.estimate.known.at, full.at - 30_000);
});

test("lesser steal is tested: a limit's steal goes when the slice is cut and comes back after", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  f.world.probe = [0.01, 0.16];
  // Two samples are too few to test on.
  await f.run(2, 0.5, 0.1);
  assertEquals(f.world.probe.length, 2);
  await f.advance(30, 0.5, 0.1);
  assert(f.g.s.limit);
  // The slice was cut to 20% of a core, restored, and then held under the limit.
  assertEquals(f.world.caps.slice(-3), [20, 800, 210]);
});

test("neighbours' steal stays when the slice is cut, and the next test waits", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  f.world.probe = [0.16, 0.16];
  await f.run(3, 0.5, 0.1);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.probe.backoffMs, 1_200_000);
  assertAlmostEquals(f.g.s.probe.failedSf!, 0.1 / 0.6);
  const until = f.g.s.probe.cooldownUntil;
  assertEquals(until, f.uptime + 600_000);
  // Nine and a half minutes on, the same steal is not tested again.
  f.world.probe = [0.01, 0.16];
  await f.run(19, 0.5, 0.1);
  assertEquals(f.world.probe.length, 2);
  // Once the cooldown is over it is.
  await f.run(2, 0.5, 0.1);
  assert(f.g.s.limit);
});

test("during a cooldown, steal well above what the failed test saw is tested at once", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  f.world.probe = [0.16, 0.16];
  await f.run(3, 0.5, 0.1);
  assertEquals(f.g.s.limit, undefined);
  // A sixth of demand failed the test. A third of it, over the whole window, earns another.
  f.world.probe = [0.02, 0.33];
  await f.run(9, 0.5, 0.26);
  assertEquals(f.world.probe.length, 2);
  await f.run(2, 0.5, 0.26);
  assert(f.g.s.limit);
  assert(f.uptime < 100_000 + 600_000);
});

test("work outside an idle slice pinned at the limit is confirmed with burners first", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  // 2.3 cores delivered, none of them the slice's: no cut of the slice can test it.
  f.world.burn = { busy: 2.4 / p.vcpus, steal: 0.5, seconds: 25 };
  await f.run(3, 2.3 / p.vcpus, 0.1, 0);
  assert(f.g.s.limit);
  assertEquals(f.cap, 20);
  // The same sight on a box whose burners all run is neighbours, and waits like a failed test.
  const free = fixture({ initial_balance: 20_000 });
  await free.advance();
  await free.run(3, 2.3 / p.vcpus, 0.1, 0);
  assertEquals(free.g.s.limit, undefined);
  assertEquals(free.g.s.probe.cooldownUntil, free.uptime + 600_000);
});

test("steal under a tenth of demand, or on a slice with nothing to cut, is never tested", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  f.world.probe = [0, 0.5];
  // A third of a core stolen from four busy ones: 7% of demand.
  await f.run(12, 0.5, 0.04);
  assertEquals(f.world.probe.length, 2);
  // An idle box: a tenth of a core's demand, a sixth of it stolen, and far from any limit.
  const idle = fixture({ initial_balance: 20_000 });
  await idle.advance();
  idle.world.probe = [0, 0.5];
  await idle.run(20, 0.0125, 0.0025);
  assertEquals(idle.world.probe.length, 2);
  assertEquals(idle.world.burners, 0);
  assertEquals(idle.g.s.limit, undefined);
});

test("after a failed test the wait doubles to an hour, and a calm day brings it back to ten minutes", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  f.world.probe = [0.16, 0.16];
  await f.run(3, 0.5, 0.1);
  assertEquals(f.g.s.probe.backoffMs, 1_200_000);
  // Each later failure doubles it, up to an hour.
  for (const wait of [2_400_000, 3_600_000, 3_600_000]) {
    f.g.s.probe.cooldownUntil = 0;
    f.world.probe = [0.16, 0.16];
    await f.advance(30, 0.5, 0.1);
    assertEquals(f.g.s.probe.backoffMs, wait);
  }
  const until = f.g.s.probe.cooldownUntil;
  assertEquals(until, f.uptime + 3_600_000);
  // Twenty-three calm hours past the cooldown change nothing.
  await f.advance(3600 + 23 * 3600);
  assertEquals(f.g.s.probe.backoffMs, 3_600_000);
  await f.advance(3600);
  assertEquals(f.g.s.probe, { cooldownUntil: until, backoffMs: 600_000, failedSf: undefined });
});

test("in the quiet window after a credit lift, the burner check waits too", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  f.g.s.probe.quietUntil = f.uptime + 600_000;
  f.world.burn = STILL;
  await f.run(6, 2.3 / p.vcpus, 0.1, 0);
  assertEquals(f.world.burners, 0);
  assertEquals(f.g.s.limit, undefined);
  // Steal that is most of the demand is still a limit at once.
  await f.run(10, 0.2, 0.4);
  assert(f.g.s.limit);
});

test("a recovery ceiling gives way to a spike outside the slice at once, and comes back when it has left the window", async () => {
  const f = await limited();
  assertEquals(f.cap, 210);
  // One core outside the slice for one pass.
  await f.advance(30, 0.125, 0, 0);
  assertEquals(f.cap, recoveryCeiling(p, 1));
  assert(f.cap < 210);
  const low = f.cap;
  // It stays there while the spike is one of the last five minutes' samples.
  await f.run(10);
  assertEquals(f.cap, low);
  await f.advance();
  assertEquals(f.cap, 210);
});

test("after a wall-clock step the estimate carries on from the own count, and no earlier sample stands beside a reading", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  await f.advance();
  await f.run(3, 0.5);
  // Half a minute of drift is not a step.
  await f.advance(30, 0.5, 0, 4, 60);
  assertEquals(f.g.s.samples.some((x) => x.clockValid === false), false);
  assertEquals(f.g.s.estimate.anchor, { at: start + 30_000, balance: 20_000 });
  // An hour on the wall clock in thirty seconds of uptime.
  await f.advance(30, 0.5, 0, 4, 3630);
  assertEquals(f.g.s.samples.length, 5);
  assertEquals(f.g.s.samples.every((x) => x.clockValid === false), true);
  // The estimate is what the own count made it, and stands there from now.
  assertAlmostEquals(f.g.s.balance, 20_000 + 5 * (4.8 - 4.24) * 30, 1e-6);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: f.g.s.balance });
  await f.advance(30, 0.5);
  assertEquals(f.g.s.samples.at(-1)!.clockValid, undefined);
  // Five minutes back is a step as well. Readings the new clock places in the future were
  // settled under the old one, and go.
  const t = f.at;
  f.g.s.readings = [{ at: t - 3_600_000, v: 1 }, { at: t - 200_000, v: 1 }, { at: t, v: 1 }];
  await f.advance(30, 0.5, 0, 4, -270);
  assertEquals(f.g.s.samples.every((x) => x.clockValid === false), true);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: f.g.s.balance });
  assertEquals(f.g.s.readings.map((r) => r.at), [t - 3_600_000]);
});

test("a clock step during a limit leaves the estimate's anchor alone", async () => {
  const f = await limited();
  const anchor = { ...f.g.s.estimate.anchor! };
  await f.advance(30, 0, 0, 0, 3630);
  assertEquals(f.g.s.samples.at(-1)!.clockValid, false);
  assertEquals(f.g.s.estimate.anchor, anchor);
});

test("an anchor older than the samples kept is dropped for the own count", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  const t1 = start + 30_000, hour = 3_600_000;
  f.world.readings = [{ at: t1 - 1_800_000, v: 0 }, { at: t1, v: 0 }];
  await f.advance();
  // Four hours without a new reading: the feed is stale, and the own count runs alone.
  await f.run(480, 0.5);
  assertEquals(f.g.s.estimate.anchor, { at: t1, balance: 20_000 });
  const own = f.g.s.balance;
  // The readings come back, and say the VM idled all along. No sample reaches back far enough
  // to stand beside the oldest of them, so the hours they cover stay with the own count.
  f.world.readings = Array.from(
    { length: 10 },
    (_, i) => ({ at: t1 - 1_800_000 + i * 1_800_000, v: 0 }),
  );
  f.world.readings.push({ at: f.at + 30_000, v: 0 });
  // Within half an hour the next fetch brings them.
  await f.run(61, 0.5);
  assertEquals(f.g.stale, false);
  assert(f.g.s.estimate.anchor!.at > t1 + 4 * hour);
  assertAlmostEquals(f.g.s.balance, own + 61 * (4.8 - 4.24) * 30, 1e-6);
});

test("counters that stand still make no sample", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  await f.advance(30, 0.5);
  // Thirty seconds in which the kernel counted nothing: no sample, and nothing charged.
  const balance = f.g.s.balance;
  f.elapse(30, 0, 0, 0, 30, 0);
  await f.g.tick();
  assertEquals(f.g.s.samples.length, 1);
  assertEquals(f.g.s.balance, balance);
});

test("samples are kept three hours and readings three days", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  const hour = 3_600_000;
  f.world.readings = [
    { at: start - 80 * hour, v: 5 },
    { at: start - 71 * hour, v: 5 },
    { at: start - hour, v: 5 },
    { at: start, v: 5 },
  ];
  await f.advance();
  await f.advance();
  // The reading from 80 hours before the fetch is gone; the newest was never settled.
  assertEquals(f.g.s.readings.map((r) => r.at), [start - 71 * hour, start - hour]);
  await f.run(400);
  assertEquals(f.g.s.samples.length, 361);
  assertEquals(f.g.s.samples[0].at, f.at - 3 * hour);
  // Three hours on, the next has aged out as well.
  assertEquals(f.g.s.readings.map((r) => r.at), [start - hour]);
});

test("with every vCPU allowed, the ceiling ignores jitter of ten points either way", async () => {
  const f = fixture({ initial_balance: p.capacity });
  await f.advance();
  await f.advance(30, 0.05, 0, 0.35);
  assertEquals(f.cap, 790);
  // A tenth of a core more outside the slice would move it by ten points.
  await f.advance(30, 0.05, 0, 0.25);
  assertEquals(f.cap, 790);
  await f.advance(30, 0.1, 0, 0.3);
  assertEquals(f.cap, 750);
});

test("requests are taken in the order they were sent", async () => {
  const dir = await testDirectory("governor-requests-");
  const paths = { run: dir, lib: dir };
  await Deno.mkdir(`${dir}/requests`);
  try {
    const f = fixture({ initial_balance: 5000 }, undefined, paths);
    f.g.io.requestBody = Deno.readTextFile;
    await f.advance();
    // Written out of order, and with a file still being written beside them.
    const write = (name: string, body: Record<string, unknown>) =>
      Deno.writeTextFile(`${dir}/requests/${name}`, JSON.stringify(body));
    await write("2-on.json", { action: "limit-on" });
    await write("3-seed.json", { action: "seed", balance: 2000 });
    await write("1-seed.json", { action: "seed", balance: 1000 });
    await write(".4-partial.json", { action: "limit-off" });
    await f.g.takeRequests({ at: f.at, uptime: f.uptime, bootId: "boot-a" });
    // Seeded to 1,000, limited there, then seeded to 2,000: any other order ends elsewhere.
    assertEquals(f.g.s.limit?.entry, { balance: 1000, learn: false });
    assertEquals(f.g.s.balance, 2000);
    const left = (await Array.fromAsync(Deno.readDir(`${dir}/requests`))).map((e) => e.name);
    assertEquals(left, [".4-partial.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A limit entered through evident steal, as far as its first lift test.
async function limited(config = {}) {
  const f = fixture({ initial_balance: 20_000, ...config });
  await f.advance();
  await f.run(3, 0.2, 0.4);
  assert(f.g.s.limit);
  return f;
}
const STILL = { busy: 2.4 / p.vcpus, steal: 0.5, seconds: 25 };
const GONE = { busy: 4.7 / p.vcpus, steal: 0.06, seconds: 25 };

test("while limited the estimate rebuilds from empty, stops at the lift point, and then tests the host", async () => {
  const f = await limited();
  f.world.burn = STILL;
  // Idle recovery: 6,912 core-seconds at the baseline's 4.8 a second is 24 minutes.
  await f.run(47);
  assertAlmostEquals(f.g.s.balance, 47 * 30 * (4.8 - 0.04), 1e-6);
  assertEquals(f.g.s.limit!.confirmed, false);
  // After those 24 minutes the host is tested, whatever the estimate says. The test ran into
  // the limit: that confirms it, and the next test waits two minutes.
  await f.advance();
  assertEquals(f.g.s.limit!.confirmed, true);
  assertEquals(f.g.s.limit!.testEvery, 120_000);
  assertEquals(f.g.s.limit!.testAt, f.uptime + 120_000);
  assertEquals(f.world.events, ["limit-start"]);
  // The estimate never passes the lift point while the limit lasts.
  await f.run(10);
  assertEquals(f.g.s.balance, p.recovered);
  assert(f.g.s.limit);
});

test("pressing on the limit earns nothing and tightens the ceiling", async () => {
  const f = await limited();
  // Still asking for more than the limit gives. The first half minute may be work winding down.
  await f.advance(30, 0.25, 0.1);
  assertEquals(f.cap, 210);
  await f.advance(30, 0.25, 0.1);
  assertEquals(f.g.s.balance, 0);
  assert(f.cap < 210);
  assertEquals(f.g.publicState(f.at).credits.rate < 0, true);
});

test("a confirmed credit limit teaches the billing the estimate missed, and restarts it at the lift", async () => {
  const f = await limited();
  // The estimate showed 400 core-seconds when the bank was empty, within the hour of the start.
  f.g.s.limit!.entry!.balance = 400;
  f.world.burn = STILL;
  await f.run(49);
  f.world.burn = GONE;
  await f.run(3);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.world.events, ["limit-start", "calibration", "limit-end"]);
  assertAlmostEquals(f.g.s.estimate.pad, ESTIMATE.pad + 1.25 * 400 / 3600);
  assertAlmostEquals(f.g.margin.add, 0.04 + 1.25 * 400 / 3600);
  // The own count had nearly reached Hostinger's lift point, and the estimate stands on it.
  assert(f.g.s.balance > p.recovered - 300 && f.g.s.balance <= p.recovered);
  assertEquals(f.g.s.estimate.anchor!.balance, f.g.s.balance);
  assertAlmostEquals(f.g.s.estimate.known.slack, p.recovered - f.g.s.balance);
  // A gap this small is a billing gap, and no sign the rules are wrong.
  assertEquals(f.g.s.suspectAt, undefined);
  // No credit limit can follow for as long as full use takes to spend what a lift leaves,
  // counted from the last test that still found the limit, two minutes before this one.
  const lastFailed = f.uptime - 120_000;
  assertAlmostEquals(
    f.g.s.probe.quietUntil!,
    lastFailed + p.recovered / (8.4 + f.g.margin.add - p.baseline) * 1000,
    1e-6,
  );
  // Inside the quiet window, steal a test would have taken is left alone.
  f.world.probe = [0.01, 0.16];
  await f.run(4, 0.5, 0.1);
  assertEquals(f.world.probe.length, 2);
  assertEquals(f.g.s.limit, undefined);
});

test("the estimate after a lift stands from the end of the test that found it", async () => {
  const f = await limited();
  f.g.s.limit!.entry!.balance = 400;
  f.world.burn = STILL;
  await f.run(49);
  f.world.burn = GONE;
  // The burners run for half a minute before the pass ends.
  f.world.burnSeconds = 30;
  await f.run(3);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.estimate.anchor!.at, f.at);
  assert(f.g.s.probe.quietUntil);
});

test("a limit no test confirmed teaches nothing and gives back at most what it found", async () => {
  const f = await limited();
  // Even where the estimate was off by little enough to be a billing gap.
  f.g.s.limit!.entry!.balance = 400;
  await f.run(48);
  // The first lift test passed: neighbours, or a limit already over.
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.world.events, ["limit-start", "limit-end"]);
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
  // The own count had earned more than the 400 the limit found, and keeps it.
  assertAlmostEquals(f.g.s.balance, 48 * 30 * (4.8 - 0.04), 1e-6);
  assertEquals(f.g.s.probe.quietUntil, undefined);
  // One that found more than Hostinger's lift point gets the lift point.
  const high = await limited();
  await high.run(48);
  assertEquals(high.g.s.balance, p.recovered);
});

test("a limit that pressed throughout restarts at the spending floor, and keeps what Hostinger's lift adds", async () => {
  const f = await limited();
  f.g.s.limit!.entry!.balance = 400;
  f.world.burn = STILL;
  // Two cores delivered of 2.8 asked for, all the way: nothing is earned.
  await f.run(49, 0.25, 0.1);
  assertEquals(f.g.s.balance, 0);
  f.world.burn = GONE;
  await f.run(3, 0.25, 0.1);
  assertEquals(f.g.s.limit, undefined);
  // Hostinger lifts at 20%. The estimate restarts at the 10% floor, and the difference counts
  // toward what the next limit teaches.
  assertEquals(f.g.s.balance, FLOOR);
  assertEquals(f.g.s.estimate.anchor!.balance, FLOOR);
  assertEquals(f.g.s.estimate.known.slack, p.recovered - FLOOR);
  assert(f.g.s.estimate.pad > ESTIMATE.pad);
  // That difference stops counting once the estimate runs empty: from there the bank goes on
  // falling and the estimate cannot.
  await f.run(40, 1, 0, 0);
  assertEquals(f.g.s.balance, 0);
  assertEquals(f.g.s.estimate.known, { at: f.at, slack: 0 });
});

test("a limit that found the estimate already empty teaches nothing", async () => {
  // Work the governor cannot cap, such as services outside the slice, spends the bank. The
  // estimate saw it coming: no billing was missed.
  const f = fixture({ initial_balance: 200 });
  await f.advance();
  await f.run(2, 1, 0, 0);
  assertEquals(f.g.s.balance, 0);
  assertEquals(f.g.s.estimate.known, { at: f.at, slack: 0 });
  // The limit follows. By the time it is recognised the estimate has risen again.
  await f.run(12, 0.2, 0.4);
  assert(f.g.s.limit);
  assertEquals(f.g.s.limit.entry!.balance, 0);
  f.world.burn = STILL;
  await f.run(49);
  assertEquals(f.g.s.limit!.confirmed, true);
  f.world.burn = GONE;
  await f.run(3);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
  assertEquals(f.world.events, ["limit-start", "limit-end"]);
});

test("the lift logs how long recovery took against what the baseline predicts", async () => {
  const lines: string[] = [];
  const f = await limited();
  f.world.burn = STILL;
  await f.run(49);
  f.world.burn = GONE;
  const log = console.log;
  console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  try {
    await f.run(3);
  } finally {
    console.log = log;
  }
  const line = lines.find((l) => l.startsWith("recovery observation: "))!;
  const seen = JSON.parse(line.slice("recovery observation: ".length));
  assertEquals(seen.idleMinimumSeconds, 1440);
  assertEquals(seen.baselineShare, 0.6);
  assertEquals(seen.confirmed, true);
  assertEquals(seen.elapsedSeconds, 52 * 30);
  // Idle throughout, so the estimate's own recovery matches the idle minimum to the margin.
  assert(seen.estimatedRecoverySeconds >= 1440 && seen.estimatedRecoverySeconds < 1500);
});

test("a limit root declared, or whose estimate root replaced, teaches nothing", async () => {
  const f = fixture({ initial_balance: 400 });
  await f.advance();
  await f.run(3, 0.25);
  await f.request({ action: "limit-on" });
  f.world.burn = STILL;
  await f.run(49);
  assertEquals(f.g.s.limit!.confirmed, true);
  f.world.burn = GONE;
  await f.run(5);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
  assertEquals(f.world.events, ["limit-end"]);
  // A seed during a detected limit replaces the estimate the limit found.
  const seeded = await limited();
  seeded.g.s.limit!.entry!.balance = 400;
  await seeded.request({ action: "seed", balance: 300 });
  seeded.world.burn = STILL;
  await seeded.run(49);
  seeded.world.burn = GONE;
  await seeded.run(5);
  assertEquals(seeded.g.s.limit, undefined);
  assertEquals(seeded.g.s.estimate.pad, ESTIMATE.pad);
});

test("while a limit lasts, readings do not move the estimate", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  const t1 = start + 30_000, half = 1_800_000;
  f.world.readings = [{ at: t1 - half, v: 0 }, { at: t1, v: 0 }];
  await f.advance();
  await f.run(3, 0.2, 0.4);
  assert(f.g.s.limit);
  const anchor = { ...f.g.s.estimate.anchor! };
  f.world.burn = STILL;
  // A reading settles that says the VM idled: replayed, it would fill the bank.
  await f.run(56);
  f.world.readings.push({ at: t1 + half, v: 0 }, { at: t1 + half + 60_000, v: 0 });
  await f.run(3);
  assertEquals(f.g.s.readings.length, 3);
  assertEquals(f.g.s.estimate.anchor, anchor);
  assert(f.g.s.balance <= p.recovered);
});

test("a credit limit no billing gap explains restarts the estimate at the lift, and teaches only when another follows within a day", async () => {
  const f = await limited();
  // Half a core's worth an hour: more than a billing gap can be.
  f.g.s.limit!.entry!.balance = 1800;
  f.world.burn = STILL;
  await f.run(49);
  f.world.burn = GONE;
  await f.run(3);
  // Nothing is learned. The bank was empty all the same, so the estimate restarts at the lift
  // and not where it stood before, and no limit can follow at once.
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
  assertEquals(f.world.events, ["limit-start", "limit-end"]);
  assert(f.g.s.suspectAt);
  assertEquals(f.g.s.balance, p.recovered);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: p.recovered });
  assert(f.g.s.probe.quietUntil! > f.uptime);
  const again = async () => {
    f.g.s.probe.quietUntil = undefined;
    await f.run(10, 0.2, 0.4);
    assert(f.g.s.limit);
    f.g.s.limit.entry!.balance = 1800;
  };
  const lift = async () => {
    f.world.burn = STILL;
    await f.run(49);
    f.world.burn = GONE;
    await f.run(5);
    assertEquals(f.g.s.limit, undefined);
  };
  // The same again within the day shows the rules themselves are off, and teaches.
  await again();
  await lift();
  assertAlmostEquals(f.g.s.estimate.pad, ESTIMATE.pad + 1.25 * 0.5);
  assertEquals(f.world.events.at(-2), "calibration");
  // A third, more than a day after the last such limit, is the first of its kind again.
  await again();
  f.g.s.suspectAt = f.at - 2 * 86_400_000;
  await lift();
  assertAlmostEquals(f.g.s.estimate.pad, ESTIMATE.pad + 1.25 * 0.5);
});

test("a cap above the plan's limit is not a credit limit: the estimate from before it returns", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  f.world.readings = readings(start, 1, 1);
  await f.advance();
  // Four cores delivered under the cap: Hostinger's sustained-use limit, not the credit one.
  f.world.probe = [0.01, 0.16];
  await f.run(3, 0.5, 0.1);
  assert(f.g.s.limit);
  assertEquals(creditCap(p, f.g.s.limit.cap), false);
  // Off by little enough to be a billing gap: only the cap's shape says it is not one.
  f.g.s.limit.entry!.balance = 400;
  f.world.burn = STILL;
  await f.run(49);
  f.world.burn = GONE;
  await f.run(3);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
  assertEquals(f.world.events, ["limit-start", "limit-end"]);
  // The anchor from before the limit stands again, and the estimate is what the limit found.
  assertEquals(f.g.s.estimate.anchor!.balance, 20_000);
  assertEquals(f.g.s.balance, 400);
  assertEquals(f.g.s.probe.quietUntil, undefined);
  // One that found more than Hostinger's lift point gets the lift point until readings say
  // more, and however far off the estimate looked, it is no sign the rules are wrong.
  const high = fixture({ initial_balance: 20_000 });
  await high.advance();
  high.world.probe = [0.01, 0.16];
  await high.run(3, 0.5, 0.1);
  high.world.burn = STILL;
  await high.run(49);
  high.world.burn = GONE;
  await high.run(3);
  assertEquals(high.g.s.limit, undefined);
  assertEquals(high.g.s.balance, p.recovered);
  assertEquals(high.g.s.suspectAt, undefined);
});

test("a credit limit delivers no more than the plan's limit when it is found", () => {
  assertEquals(creditCap(p, 2.4), true);
  assertEquals(creditCap(p, 0.3), true);
  assertEquals(creditCap(p, 2.69), true);
  assertEquals(creditCap(p, 2.75), false);
  assertEquals(creditCap(p, 6), false);
  assertEquals(creditCap(p, undefined), false);
  return Promise.resolve();
});

test("what a limit delivers later, under the governor's own recovery ceiling, does not change what it was", async () => {
  // Neighbours keep stealing a little while the slice is held far under the limit. Samples that
  // show 0.4 cores delivered say nothing about the cap.
  const f = await limited();
  f.g.s.limit!.entry!.balance = 400;
  assertAlmostEquals(f.g.s.limit!.cap!, 1.6);
  f.world.burn = STILL;
  await f.run(49, 0.05, 0.002);
  assertAlmostEquals(f.g.s.limit!.cap!, 1.6);
  f.world.burn = GONE;
  await f.run(70, 0.05, 0.002);
  assertEquals(f.g.s.limit, undefined);
  // It was a credit limit, and taught as one.
  assert(f.g.s.estimate.pad > ESTIMATE.pad);
  assertEquals(f.world.events, ["limit-start", "calibration", "limit-end"]);
});

test("root's requests set the limit and the estimate by hand", async () => {
  const f = fixture({ initial_balance: 5000 });
  await f.advance();
  await f.request({ action: "limit-on" });
  assert(f.g.s.limit);
  assertEquals(f.g.s.limit.entry, { balance: 5000, learn: false });
  assertEquals(f.g.s.limit.cap, p.limit);
  // Root says it is a credit limit, whatever the VM delivers at that moment.
  const busy = fixture({ initial_balance: 5000 });
  await busy.run(3, 0.5);
  await busy.request({ action: "limit-on" });
  assertEquals(busy.g.s.limit?.cap, p.limit);
  assertEquals(f.g.s.balance, 0);
  f.g.s.estimate.known = { at: 1, slack: 99 };
  await f.request({ action: "limit-off" });
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.balance, p.recovered);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: p.recovered });
  assertEquals(f.g.s.estimate.known, { at: f.at, slack: 0 });
  f.g.s.estimate.known = { at: 1, slack: 99 };
  await f.request({ action: "seed", balance: 12_345 });
  assertEquals(f.g.s.balance, 12_345);
  assertEquals(f.g.s.estimate.known, { at: f.at, slack: 0 });
  await f.request({ action: "seed", balance: 1e9 });
  assertEquals(f.g.s.balance, p.capacity);
  f.g.s.estimate.pad = 0.5;
  f.g.s.estimate.excess = [1, 2, 3];
  f.g.s.suspectAt = f.at;
  await f.request({ action: "calibration-reset" });
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
  assertEquals(f.g.s.estimate.excess, []);
  assertEquals(f.g.s.suspectAt, undefined);
  assertEquals(f.g.s.balance, p.capacity);
  // The request reaches the ceiling in the pass that follows: every vCPU, less the 0.4 cores
  // assumed outside the slice before anything is measured.
  await f.advance(1);
  assertEquals(f.cap, 760);
});

test("a request file must be root's own, a regular file, and not writable by others", async () => {
  const f = fixture({ initial_balance: 5000 });
  await f.advance();
  await assertRejects(() => f.request({ action: "seed", balance: 1 }, 1000));
  await assertRejects(() => f.request({ action: "seed", balance: 1 }, 0, 0o666));
  await assertRejects(() => f.request({ action: "seed", balance: 1 }, 0, 0o644, true));
  assertEquals(f.g.s.balance, 5000);
  await f.request({ action: "nonsense" });
  assertEquals(f.g.s.balance, 5000);
});

test("a pass moments after the last one reuses its measurements", async () => {
  const f = fixture({ initial_balance: 5000 });
  await f.advance();
  await f.advance(30, 0.5);
  const samples = f.g.s.samples.length, balance = f.g.s.balance;
  await f.advance(2, 1);
  assertEquals(f.g.s.samples.length, samples);
  assertEquals(f.g.s.balance, balance);
  // The CPU those two seconds used is in the next full sample.
  await f.advance(28, 0.5);
  assertEquals(f.g.s.samples.at(-1)!.seconds, 30);
  assertAlmostEquals(f.g.s.samples.at(-1)!.busy, (2 * 1 + 28 * 0.5) / 30);
});

test("a sample longer than two passes is time the daemon did not watch", async () => {
  const f = fixture({ initial_balance: 10_000 });
  await f.advance();
  await f.advance(60, 0.5);
  assertEquals(f.g.s.samples.at(-1)!.unobserved, undefined);
  assertEquals(f.g.s.samples.at(-1)!.earning, true);
  await f.advance(90, 0.5);
  assertEquals(f.g.s.samples.at(-1)!.unobserved, true);
  assertEquals(f.g.s.samples.at(-1)!.earning, false);
});

test("a daemon restart in the same boot counts the time it missed, and earns nothing for it", async () => {
  const f = fixture({ initial_balance: 10_000 });
  await f.advance();
  await f.advance(30, 0.5);
  const before = f.g.s.balance;
  const g = f.restart();
  f.elapse(600, 0.25);
  await g.tick();
  const sample = g.s.samples.at(-1)!;
  assertEquals(sample.unobserved, true);
  assertEquals(sample.earning, false);
  assertAlmostEquals(g.s.balance, before - (1.05 * 2 + 0.04) * 600);
});

test("a reboot keeps the estimate the readings stand behind, less what the time down could have cost", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000 });
  f.world.readings = readings(start, 1, 1);
  await f.advance();
  await f.run(60, 0.5);
  f.world.readings = readings(f.at + 1_800_000, 1, 1, 4.2, 4.2);
  await f.run(2, 0.5);
  const before = f.g.s.balance;
  assert(f.g.s.estimate.anchor!.at > start);
  f.g.s.probe = { cooldownUntil: f.uptime + 3_000_000, backoffMs: 3_600_000, failedSf: 0.2 };
  const fetches = f.world.fetches;
  f.reboot(600);
  const g = f.restart();
  await g.tick();
  assertAlmostEquals(g.s.balance, before - maxDrain(p, margin(p, g.s.estimate)) * 600, 1e-6);
  assertEquals(g.s.rebuilding, null);
  // A cooldown counted in the last boot's uptime means nothing now, and the readings are
  // fetched at once.
  assertEquals(g.s.probe, { cooldownUntil: 0, backoffMs: 600_000 });
  assertEquals(f.world.fetches, fetches + 1);
  // The samples of the last boot keep their place in time, and nothing else.
  assertEquals(g.s.samples.length, 62);
  assertEquals(g.s.samples.every((x) => x.uptime === undefined), true);
  assertEquals(g.controlSamples(Infinity).length, 0);
  // They stay while a reading can still settle over them.
  f.elapse(30, 0.5);
  await g.tick();
  assertEquals(g.s.samples.length, 63);
  assertEquals(g.controlSamples(Infinity).length, 1);
});

test("a reboot with nothing recent to stand on starts the estimate empty", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  await f.run(3, 0.5);
  f.reboot(600);
  const g = f.restart();
  await g.tick();
  assertEquals(g.s.balance, 0);
  assertEquals(g.publicState(f.at).credits.rebuilding?.reason, "reboot");
  // Counters that start over without a reboot do the same, and the readings are fetched at
  // once, whatever the half-hourly schedule said.
  const c = fixture({ ...FEED, initial_balance: 20_000 });
  await c.advance();
  await c.advance(30, 0.5);
  assertEquals(c.world.fetches, 1);
  c.resetCounters();
  await c.advance(30, 0.5);
  assertEquals(c.g.s.balance, 0);
  assertEquals(c.g.publicState(c.at).credits.rebuilding?.reason, "counter-reset");
  assertEquals(c.world.fetches, 2);
});

test("a limit lasts through a reboot, but can no longer teach", async () => {
  const f = await limited();
  f.reboot(600);
  const g = f.restart();
  await g.tick();
  assert(g.s.limit);
  assertEquals(g.s.limit.entry?.learn, false);
  assertEquals(g.s.limit.startedAt, 5000);
  assertEquals(f.cap, 210);
  // Readings from before the limit say nothing about a bank the limit found empty.
  const fed = fixture({ ...FEED, initial_balance: 20_000 });
  fed.world.readings = [{ at: start - 1_770_000, v: 0 }, { at: start + 30_000, v: 0 }];
  await fed.advance();
  await fed.run(3, 0.2, 0.4);
  assert(fed.g.s.limit && fed.g.s.estimate.anchor && !fed.g.stale);
  fed.reboot(600);
  const again = fed.restart();
  await again.tick();
  assertEquals(again.s.balance, 0);
  assertEquals(again.s.rebuilding?.reason, "reboot");
});

test("state a v0.3 release saved carries over: its estimate, samples, readings and learned gap", async () => {
  const sample = {
    at: start - 30_000,
    uptime: 70_000,
    seconds: 30,
    busy: 0.5,
    steal: 0,
    outside: 0.2,
  };
  const saved = {
    schema: 2,
    planKey: "8:4.8:34560",
    bootId: "boot-a",
    uptime: 70_000,
    at: start - 30_000,
    balance: 9000,
    margin: { mul: 1.05, add: 0.08 },
    used: 0,
    probe: { cooldownUntil: 900_000, backoffMs: 2_400_000, failedSf: 0.2, failedAtCap: true },
    vmId: 1,
    samples: [sample, { ...sample, at: start - 60_000, limited: true }, { at: 1 }],
    readings: readings(start - 1_800_000, 1, 1, 1),
    cpuPrev: { busy: 0, steal: 0, total: 1000 },
    calibration: { gap: 0.05, estimates: { open: 9000, acted: 8000, clamp: 8000 } },
    calibrationMode: "apply",
    openSlot: { from: 0 },
  };
  const f = fixture(FEED, saved);
  assertEquals(f.g.s.schema, 3);
  // The lower of the two estimates v0.3 kept.
  assertEquals(f.g.s.balance, 8000);
  assertAlmostEquals(f.g.s.estimate.pad, ESTIMATE.pad + 0.05);
  assertEquals(f.g.s.readings.length, 3);
  assertEquals(f.g.s.samples.map((x) => x.earning), [true, false]);
  assertEquals("calibration" in f.g.s, false);
  assertEquals(f.g.s.rebuilding, null);
  // It stands where v0.3 last saved it, not at this start.
  assertEquals(f.g.s.at, start - 30_000);
  assertEquals(f.g.s.estimate.known, { at: start - 30_000, slack: 0 });
  // A failed test's cooldown carries over, so the upgrade does not start a run of probes.
  assertEquals(f.g.s.probe, { cooldownUntil: 900_000, backoffMs: 2_400_000, failedSf: 0.2 });
  assertEquals(f.g.s.vmId, 1);
  // The same boot goes on: the first pass is an ordinary one.
  f.elapse(30, 0.5);
  await f.g.tick();
  assertEquals(f.g.s.samples.length, 3);
  // State v0.3 saved for another VM says nothing about this one's bank.
  const other = fixture(FEED, { ...saved, vmId: 2 });
  assertEquals(other.g.s.readings, []);
  assertEquals(other.g.s.balance, 0);
  assertEquals(other.g.s.rebuilding?.reason, "state-upgrade");
});

test("a limit in force when an older release stopped stays in force, and lifts as the credit limit it was", async () => {
  const saved = {
    schema: 2,
    planKey: "8:4.8:34560",
    balance: 0,
    at: start,
    limit: { since: start - 60_000 },
    readings: readings(start, ...Array(96).fill(0.5)),
  };
  const f = fixture(FEED, { ...saved, bootId: "boot-a", uptime: 70_000 });
  assertEquals(f.g.s.limit?.since, start - 60_000);
  // Its clocks run from the upgrade, in this boot's uptime.
  assertEquals(f.g.s.limit?.startedAt, 70_000);
  assertEquals(f.g.s.limit?.heldFrom, 70_000);
  assertEquals(f.g.s.limit?.cap, p.limit);
  await f.advance();
  assertEquals(f.cap, f.g.s.limit!.ceiling);
  assertEquals(f.g.publicState(f.at).accepting, false);
  // Its lift restarts the estimate there. Two idle days of readings from before it would say
  // the bank is full, and say nothing about a bank the limit found empty.
  await f.run(48);
  assertEquals(f.g.s.limit, undefined);
  assert(f.g.s.balance <= p.recovered);
  assertEquals(f.g.s.estimate.anchor, { at: f.at, balance: f.g.s.balance });
  assertEquals(f.g.s.estimate.pad, ESTIMATE.pad);
});

test("what v0.3 learned from limits carries over as the pad, from apply's gap or off's wider margin", () => {
  const old = (extra: Record<string, unknown>) =>
    fixture({}, { schema: 2, planKey: "8:4.8:34560", balance: 5000, at: start, ...extra }).g.s
      .estimate.pad;
  assertEquals(old({}), ESTIMATE.pad);
  assertEquals(old({ margin: { mul: 1.05, add: 0.08 } }), ESTIMATE.pad);
  assertAlmostEquals(old({ calibration: { gap: 0.05 } }), ESTIMATE.pad + 0.05);
  // 1.1125x + 0.1 where 1.05x + 0.08 was the start: 0.0625 x 4.8 + 0.02 cores at the baseline.
  assertAlmostEquals(old({ margin: { mul: 1.1125, add: 0.1 } }), ESTIMATE.pad + 0.32);
  // The larger of the two, and never past what the own count may add.
  assertAlmostEquals(
    old({ margin: { mul: 1.1125, add: 0.1 }, calibration: { gap: 0.05 } }),
    ESTIMATE.pad + 0.32,
  );
  assertAlmostEquals(old({ calibration: { gap: 9 } }), 2.49);
  return Promise.resolve();
});

test("an initial balance of zero states nothing", async () => {
  // The installer writes "initial_balance": 0.
  const zero = fixture({ initial_balance: 0 });
  await zero.advance();
  await zero.advance();
  assertEquals(zero.g.s.estimate.anchor, undefined);
  assertEquals(zero.g.publicState(zero.at).credits.rebuilding?.reason, "first-start");
  const some = fixture({ initial_balance: 5 });
  await some.advance();
  assertEquals(some.g.s.estimate.anchor, { at: some.at, balance: 5 });
});

test("readings that end hours before the box's clock move nothing, and the status says since when", async () => {
  // A clock three hours ahead, or a feed that stopped three hours ago: the newest reading the
  // box will settle is that old. Two idle days of them would otherwise fill the estimate.
  const f = fixture(FEED);
  const last = start - 3 * 3_600_000;
  f.world.readings = readings(last + 1_800_000, ...Array(96).fill(0.5));
  await f.advance();
  await f.advance();
  assertEquals(f.g.s.readings.at(-1)!.at, last);
  assertEquals(f.g.s.estimate.anchor, undefined);
  assertAlmostEquals(f.g.s.balance, (4.8 - 0.04) * 30, 1e-6);
  const credits = f.g.publicState(f.at).credits;
  assertEquals(credits.staleSince, last);
  assertEquals(credits.anchor?.applied, false);
  // A feed that has never given a reading is reported from two hours into the run.
  const never = fixture({ ...FEED, initial_balance: 5000 });
  await never.advance();
  await never.advance(7000);
  assertEquals(never.g.publicState(never.at).credits.staleSince, null);
  await never.advance(300);
  assertEquals(never.g.publicState(never.at).credits.staleSince, start + 30_000);
  // Without a feed configured there is nothing to report.
  const bare = fixture({ initial_balance: 5000 });
  await bare.advance();
  await bare.advance(8000);
  assertEquals(bare.g.publicState(bare.at).credits.staleSince, null);
});

test("state from another plan, or that makes no sense, starts over", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  const other = new Governor({ vcpus: 4 }, (await import("../src/plans.ts")).plan(4), f.g.s, f.io);
  assertEquals(other.s.balance, 0);
  assertEquals(other.s.rebuilding?.reason, "plan-change");
  for (const broken of [{ balance: NaN }, { estimate: undefined }, { samples: "x" }]) {
    const g = new Governor({}, p, { ...f.g.s, ...broken } as never, f.io);
    assertEquals(g.s.balance, 0);
    assertEquals(g.s.rebuilding?.reason, "state-upgrade");
  }
  // An initial balance is for a first start only.
  assertEquals(
    new Governor({ initial_balance: 9000 }, p, { schema: 1 } as never, f.io).s.balance,
    0,
  );
});

test("settings of earlier releases still load, and a misspelt one does not", () => {
  const old = {
    calibration: { mode: "apply", fit: { min_cores: 3 } },
    readings: { use_newest: true },
    recovery: { quota_period_ms: 10 },
  };
  assertEquals(validateConfig({ ...FEED, ...old }).hostinger?.vm_id, 1);
  assertEquals(legacySettings({ ...old }), ["calibration", "readings", "recovery"]);
  assertEquals(legacySettings(FEED), []);
  assertThrows(() => validateConfig({ calibrations: {} } as never), Error, "is not a setting");
  assertThrows(
    () => validateConfig({ hostinger: { vmid: 1 } } as never),
    Error,
    "is not a setting",
  );
  assertThrows(() => validateConfig({ tick_seconds: 0 }), Error, "tick_seconds");
  assertThrows(() => validateConfig({ initial_balance: -1 }), Error, "initial_balance");
  assertThrows(() => validateConfig({ slice: "system.slice" }), Error, "slice");
  assertThrows(() => validateConfig({ vcpus: 0 }), Error, "vcpus");
  assertThrows(
    () => validateConfig({ hostinger: { request_command: ["/x"] } }),
    Error,
    "requires hostinger.vm_id",
  );
  return Promise.resolve();
});

test("a ceiling that cannot be set stops new work and fails the pass", async () => {
  const dir = await testDirectory("governor-cap-");
  const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
  await Deno.mkdir(paths.run);
  await Deno.mkdir(paths.lib);
  try {
    const f = fixture({ initial_balance: FLOOR }, undefined, paths);
    await f.advance();
    f.capFails();
    f.g.s.balance = p.capacity;
    await f.advance(30, 0.5);
    const state = f.g.publicState(f.at);
    assertEquals(state.capFailed, true);
    assertEquals(state.accepting, false);
    f.elapse(30, 0.5);
    await assertRejects(() => controlPass(f.g), Error, "ceiling");
    // The pass still saved what it measured.
    assertEquals(JSON.parse(await Deno.readTextFile(`${paths.run}/state.json`)).capFailed, true);
    f.capFails(false);
    f.elapse(30, 0.5);
    await controlPass(f.g);
    assertEquals(f.g.publicState(f.at).accepting, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("what consumers read: the estimate, the ceiling, the limit and whether to start work", async () => {
  const f = fixture({ ...FEED, initial_balance: 20_000, timezone: "Europe/Istanbul" });
  f.world.readings = readings(start, 1, 1, 1);
  await f.advance();
  await f.run(3, 0.5, 0, 3);
  const s: PublicState = f.g.publicState(f.at);
  assertEquals(Object.keys(s).sort(), [
    "accepting",
    "bootId",
    "capFailed",
    "ceiling",
    "coverage",
    "cpu",
    "credits",
    "limit",
    "plan",
    "readings",
    "schemaVersion",
    "slice",
    "timezone",
    "updatedAt",
    "uptime",
  ]);
  assertEquals(s.credits.percent, Math.round(100 * s.credits.balance / p.capacity));
  assertEquals(s.credits.margin, M);
  assertEquals(s.credits.law, LAW);
  assertEquals(s.credits.staleSince, null);
  assertEquals(s.credits.anchor?.checkedAt, start + 30_000);
  assertAlmostEquals(s.credits.rate, 4.8 - 4.24, 0.05);
  assertAlmostEquals(s.cpu.busy5, 0.5);
  assertEquals(s.cpu.observedSeconds, 90);
  assertEquals(s.readings.length, 2);
  assertEquals(s.timezone, "Europe/Istanbul");
  assertEquals(s.limit, null);
  // Two hours without a settled reading: the status says since when.
  await f.run(240);
  assertEquals(f.g.publicState(f.at).credits.staleSince, s.readings.at(-1)!.at);
  assertEquals(f.g.publicState(f.at).credits.anchor?.applied, false);
});

test("the daemon's state is saved private and its public state readable, and a start reads it back", async () => {
  const dir = await testDirectory("governor-save-");
  const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
  await Deno.mkdir(paths.run);
  await Deno.mkdir(paths.lib);
  try {
    const f = fixture({ initial_balance: 7000 }, undefined, paths);
    await f.advance();
    await f.advance(30, 0.5);
    await f.g.save(f.at);
    assertEquals((await Deno.stat(`${paths.lib}/persist.json`)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(`${paths.run}/state.json`)).mode! & 0o777, 0o644);
    const state = JSON.parse(await Deno.readTextFile(`${paths.run}/state.json`));
    assertEquals(state.credits.balance, Math.round(f.g.s.balance));
    const again = await openGovernor({ initial_balance: 7000 }, p, f.io, paths);
    assertEquals(again.s.balance, f.g.s.balance);
    assertEquals(again.s.samples.length, 1);
    // A file that does not parse is set aside, and the estimate starts over. That is lost
    // state, not a first start: the configured initial balance is for a new install only.
    await Deno.writeTextFile(`${paths.lib}/persist.json`, "{broken");
    const lost = await openGovernor({ initial_balance: 7000 }, p, f.io, paths);
    assertEquals(lost.s.balance, 0);
    assertEquals(lost.s.estimate.anchor, undefined);
    assertEquals(lost.s.rebuilding?.reason, "state-upgrade");
    const names = (await Array.fromAsync(Deno.readDir(paths.lib))).map((e) => e.name);
    assertEquals(names.filter((n) => n.startsWith("persist.json.bad-")).length, 1);
    // One this run cannot read stays where it is, unwritten.
    await f.g.save(f.at);
    await Deno.chmod(`${paths.lib}/persist.json`, 0o000);
    const blind = await openGovernor({}, p, f.io, paths);
    assertEquals(blind.persistWritable, false);
    await blind.save(f.at);
    await Deno.chmod(`${paths.lib}/persist.json`, 0o600);
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${paths.lib}/persist.json`)).balance,
      f.g.s.balance,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a hot or stolen moment is photographed at most every five minutes", async () => {
  const f = fixture({ initial_balance: 20_000 });
  await f.advance();
  await f.run(4, 0.7);
  assertEquals(f.world.snapshots, 1);
  await f.run(10, 0.7);
  assertEquals(f.world.snapshots, 2);
});

test("the API's readings and the guest's own count are compared over whole intervals", () => {
  const rs = readings(start, 0, 50 / 100 * p.vcpus);
  const own = Array.from({ length: 60 }, (_, i) => ({
    at: start - 1_800_000 + (i + 1) * 30_000,
    seconds: 30,
    busy: 0.45,
    steal: 0,
    outside: 0,
    earning: true,
  }));
  assertAlmostEquals(compareReadings(rs, own)!, 5);
  assertEquals(compareReadings(rs, own.slice(0, 30)), null);
  assertEquals(startLine(p, 17_280).includes("50% credits"), true);
  return Promise.resolve();
});
