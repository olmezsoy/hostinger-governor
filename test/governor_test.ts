import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { compareReadings, Governor, type GovernorIO, validateConfig } from "../src/governor.ts";
import { plan, RULES_SINCE } from "../src/plans.ts";
import { liftConfirmed } from "../src/credits.ts";

const p = plan(8);
const start = RULES_SINCE + 10_800_000;
function fixture(config = {}) {
  let at = start;
  let uptime = 100_000;
  let bootId = "boot-a";
  let counters = { busy: 0, steal: 0, total: 1000 };
  let usage = 0;
  let cap = 200;
  let attempts = 0;
  let failAPI = false;
  let failCap = false;
  let owner = 0;
  let mode = 0o644;
  let symlink = false;
  let request = { action: "seed", balance: p.capacity };
  const io: GovernorIO = {
    clock: () => Promise.resolve({ at, uptime, bootId }),
    counters: () => Promise.resolve({ ...counters }),
    usage: (_slice, at) => Promise.resolve({ at, total: usage, usage: {} }),
    cap: (_slice, n) => {
      if (!failCap) cap = n;
      return Promise.resolve(!failCap);
    },
    ceiling: () => Promise.resolve(cap),
    readings: () => {
      attempts++;
      if (failAPI) return Promise.reject(new Error("API outage"));
      return Promise.resolve([{ at: start - 10_800_000, v: 0 }, { at: start, v: 0 }]);
    },
    hooks: () => Promise.resolve(),
    snapshot: () => Promise.resolve(),
    requestInfo: () =>
      Promise.resolve({ uid: owner, mode, isFile: !symlink, isSymlink: symlink, size: 100 }),
    requestBody: () => Promise.resolve(JSON.stringify(request)),
    pause: () => Promise.resolve(),
    steal: () => Promise.resolve(0),
    demand: () => Promise.resolve({ busy: 4.7 / p.vcpus, steal: 0.06, seconds: 25 }),
    burner: () => ({
      status: Promise.resolve({ success: false, code: 124, signal: null }),
      kill: () => {},
    }),
  };
  const g = new Governor(config, p, undefined, io);
  return {
    g,
    io,
    get cap() {
      return cap;
    },
    get attempts() {
      return attempts;
    },
    apiFails() {
      failAPI = true;
    },
    capFails() {
      failCap = true;
    },
    request(action: string, uid = 0, permissions = 0o644, link = false) {
      owner = uid;
      mode = permissions;
      symlink = link;
      request = { action, balance: p.capacity };
      return g.request("/fixture/request", at);
    },
    advance(seconds = 30, busy = 0, steal = 0, managed = busy * p.vcpus, wallSeconds = seconds) {
      at += wallSeconds * 1000;
      uptime += seconds * 1000;
      counters.total += 1000;
      counters.busy += busy * 1000;
      counters.steal += steal * 1000;
      usage += managed * seconds * 1_000_000;
      return g.tick();
    },
    reboot() {
      at += 10_800_000;
      uptime = 5000;
      bootId = "boot-b";
      counters = { busy: 0, steal: 0, total: 1000 };
      usage = 0;
    },
    resetCounters() {
      counters = { busy: 0, steal: 0, total: 1000 };
    },
  };
}

Deno.test("rebuilding reserve is visible without claiming a Hostinger limit", async () => {
  const f = fixture();
  await f.g.tick();
  const s = f.g.publicState(start);
  assertEquals(s.credits.rebuilding, { reason: "first-start", since: start });
  assertEquals(s.cpu.observedSeconds, 0);
  assertEquals(s.accepting, true);
  assertEquals(s.limit, null);
  await f.advance();
  assertEquals(f.g.publicState(start).cpu.observedSeconds, 30);
  for (let i = 0; i < 50; i++) await f.advance();
  assertEquals(f.g.publicState(start).credits.rebuilding, null);
  f.g.s.balance = 0;
  assertEquals(f.g.publicState(start).credits.rebuilding, null);
});

Deno.test("compatible upgrades preserve the balance and rebuilding progress", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance();
  const restored = new Governor({}, p, f.g.s, f.io);
  assertEquals(restored.s.balance, f.g.s.balance);
  assertEquals(restored.publicState(start).credits.rebuilding, f.g.s.rebuilding);
  const old = { ...f.g.s, rebuilding: undefined, balance: 12000 };
  assertEquals(new Governor({}, p, old, f.io).s.balance, 12000);
});

Deno.test("reset reasons explain legacy state, changed plans and reboots", async () => {
  const f = fixture();
  const legacy = new Governor({}, p, { ...f.g.s, schema: 1 }, f.io);
  assertEquals(legacy.publicState(start).credits.rebuilding?.reason, "state-upgrade");
  const smaller = plan(8, undefined, 0.3);
  assertEquals(
    new Governor({ baseline_share: 0.3 }, smaller, f.g.s, f.io).publicState(start)
      .credits.rebuilding?.reason,
    "plan-change",
  );
  await f.g.tick();
  f.reboot();
  await f.g.tick();
  assertEquals(f.g.publicState(start).credits.rebuilding?.reason, "reboot");
  await f.request("seed");
  assertEquals(f.g.publicState(start).credits.rebuilding, null);
});

Deno.test("a three-hour stop cannot earn a full bank or request eight cores", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = 5000;
  f.reboot();
  await f.g.tick();
  await f.advance();
  assert(f.g.s.balance < 5200);
  assert(f.cap < 800);
});

Deno.test("same-boot daemon restart accounts the actual cumulative CPU interval", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = 5000;
  const saved = structuredClone(f.g.s);
  await f.advance(1800, 0.9);
  const restarted = new Governor({}, p, saved, f.io);
  await restarted.tick();
  assertEquals(restarted.s.balance, 0);
});

Deno.test("an unobserved same-boot interval cannot earn credits from an idle endpoint", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = 5000;
  await f.advance(10_800, 0);
  assert(f.g.s.balance <= 5000);
});

Deno.test("counter reset rebaselines time and keeps the estimate conservative", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance();
  f.g.s.balance = 5000;
  f.resetCounters();
  await f.advance(10_800);
  await f.advance();
  assert(f.g.s.balance < 5200);
});

for (const jump of [-10_800, 10_800]) {
  Deno.test(`wall-clock jump of ${jump}s does not change CPU credit duration`, async () => {
    const f = fixture();
    await f.g.tick();
    f.g.s.balance = 5000;
    await f.advance(30, 0, 0, 0, jump);
    assertEquals(f.g.s.balance, 5141.6);
    assertEquals(f.g.s.samples[0].clockValid, false);
  });
}

Deno.test("legacy inflated state is discarded during upgrade", () => {
  const f = fixture();
  f.g.enterLimit(start, false);
  const saved = {
    ...f.g.s,
    schema: undefined,
    balance: p.capacity,
    margin: { mul: 1.4, add: 0.2 },
  };
  const migrated = new Governor({ initial_balance: p.capacity }, p, saved, f.io);
  assertEquals(migrated.s.balance, 0);
  assert(migrated.s.limit);
  assertEquals(migrated.s.margin, saved.margin);
});

Deno.test("changing baseline invalidates a persisted estimate", () => {
  const f = fixture();
  f.g.s.balance = p.capacity;
  const smaller = plan(8, undefined, 0.3);
  assertEquals(new Governor({ baseline_share: 0.3 }, smaller, f.g.s, f.io).s.balance, 0);
});

Deno.test("API history cannot increase a bank or claim an exact anchor", async () => {
  const f = fixture({ hostinger: { vm_id: 123 } });
  f.g.s.balance = 5000;
  await f.g.anchorNow(start);
  assertEquals(f.g.s.balance, 5000);
  assertEquals(f.g.publicState(start).credits.anchor?.exact, false);
  assertEquals(f.g.publicState(start).credits.anchor?.applied, false);
});

Deno.test("failed anchors use exponential backoff", async () => {
  const f = fixture({ hostinger: { vm_id: 123 } });
  f.apiFails();
  await f.g.tick();
  await f.advance();
  assertEquals(f.attempts, 1);
  await f.advance();
  assertEquals(f.attempts, 1);
  await f.advance();
  assertEquals(f.attempts, 2);
  await f.advance(60);
  assertEquals(f.attempts, 2);
});

Deno.test("3% whole-machine steal tightens recovery every minute instead of stalling", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  const original = f.g.s.limit!.ceiling;
  await f.advance(30, 0.25, 0.03);
  await f.advance(30, 0.25, 0.03);
  assert(f.g.s.limit!.ceiling < original);
  assertEquals(f.g.s.balance, 0);
  await f.advance(60, 0.25, 0.03);
  assert(f.g.s.limit!.ceiling < original / 2);
});

Deno.test("tightening follows measured demand down to the 20% quota floor", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance(60, 0.02, 0.01);
  assertEquals(f.g.s.limit!.ceiling, 20);
});

Deno.test("relative steal triggers a probe even below 10% whole-machine steal", async () => {
  const f = fixture();
  await f.g.tick();
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(true);
  };
  for (let i = 0; i < 3; i++) await f.advance(30, 0.25, 0.03);
  assertEquals(probes, 1);
  assert(f.g.s.limit);
});

Deno.test("neighbour steal backs probes off without marking a limit", async () => {
  const f = fixture();
  await f.g.tick();
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(false);
  };
  for (let i = 0; i < 20; i++) await f.advance(30, 0.25, 0.03);
  assertEquals(probes, 1);
  assertEquals(f.g.s.limit, undefined);
});

Deno.test("normal neighbour steal passes the lift test; a real limit or failed burners does not", () => {
  assertEquals(liftConfirmed(p, 5, 4.7, 0.06), true);
  assertEquals(liftConfirmed(p, 5, 2.4, 0.52), false);
  assertEquals(liftConfirmed(p, 5, 0.2, 0), false);
  assertEquals(liftConfirmed(plan(1), 1, 0.9, 0.1), true);
});

Deno.test("the actual burn-test method tolerates normal steal and rejects failed burners", async () => {
  const f = fixture();
  assertEquals(await f.g.limitGone(), true);
  const failed = new Governor({}, p, undefined, {
    ...f.io,
    burner: () => ({
      status: Promise.resolve({ success: false, code: 1, signal: null }),
      kill: () => {},
    }),
  });
  assertEquals(await failed.limitGone(), false);
  const limited = new Governor({}, p, undefined, {
    ...f.io,
    demand: () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 }),
  });
  assertEquals(await limited.limitGone(), false);
});

Deno.test("partially started burners are cleaned up if a later spawn fails", async () => {
  const f = fixture();
  let started = 0;
  let killed = 0;
  const g = new Governor({}, p, undefined, {
    ...f.io,
    burner: () => {
      if (started === 2) throw new Error("spawn failed");
      started++;
      return {
        status: Promise.resolve({ success: false, code: 124, signal: null }),
        kill: () => {
          killed++;
        },
      };
    },
  });
  await assertRejects(() => g.limitGone());
  assertEquals(killed, started);
});

Deno.test("a lifted limit resumes accepting and failed tests retry after two minutes", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  let tests = 0;
  f.g.limitGone = () => {
    tests++;
    return Promise.resolve(tests > 1);
  };
  f.g.s.balance = p.recovered;
  await f.advance();
  assertEquals(f.g.publicState(start).accepting, false);
  await f.advance(60);
  assertEquals(tests, 1);
  await f.advance(60);
  assertEquals(tests, 2);
  assertEquals(f.g.publicState(start).accepting, true);
});

for (const action of ["seed", "limit-off", "limit-on"]) {
  Deno.test(`${action} rejects consumers, writable files, and symlinks`, async () => {
    const f = fixture();
    await assertRejects(() => f.request(action, 1000));
    await assertRejects(() => f.request(action, 0, 0o664));
    await assertRejects(() => f.request(action, 0, 0o644, true));
    assertEquals(f.g.s.balance, 0);
  });
}

Deno.test("root can seed and explicitly override a limit", async () => {
  const f = fixture();
  await f.request("limit-on");
  assert(f.g.s.limit);
  await f.request("limit-off");
  assertEquals(f.g.s.limit, undefined);
  await f.request("seed");
  assertEquals(f.g.s.balance, p.capacity);
});

Deno.test("the whole managed slice counts Docker and services without per-user cgroups", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance(30, 0.5, 0, 3.5);
  assertEquals(f.g.s.samples[0].outside, 0.5);
  assertEquals(f.g.s.samples[0].users, {});
});

Deno.test("outside workloads constrain recovery and report when they alone exceed the limit", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance(30, 0.4, 0, 0.2);
  assertEquals(f.g.s.limit!.ceiling, 20);
  assertEquals(f.g.publicState(start).coverage.recoveryBlocked, true);
});

Deno.test("failed quota application reports not accepting", async () => {
  const f = fixture();
  f.capFails();
  await assertRejects(() => f.g.tick());
  assertEquals(f.g.publicState(start).accepting, false);
});

Deno.test("CPU comparison requires complete guest coverage and rejects clock-jump samples", () => {
  const readings = [{ at: start, v: 0 }, { at: start + 1_800_000, v: 25 }];
  const samples = [{ at: start + 1_800_000, seconds: 1800, busy: 0.2, steal: 0 }];
  assertEquals(compareReadings(readings, samples), 5);
  assertEquals(compareReadings(readings, [{ ...samples[0], seconds: 30 }]), null);
  assertEquals(compareReadings(readings, [{ ...samples[0], clockValid: false }]), null);
});

Deno.test("configuration rejects invalid VM ids, quotas, clocks, and baselines", () => {
  for (const id of [0, -1, 1.5, NaN]) {
    assertThrows(() => validateConfig({ hostinger: { vm_id: id } }));
  }
  assertThrows(() => validateConfig({ slice: "system.slice" }));
  assertThrows(() => validateConfig({ tick_seconds: -30 }));
  assertThrows(() => validateConfig({ initial_balance: Infinity }));
  assertThrows(() => validateConfig({ baseline_share: 1 }));
  assertEquals(plan(8, undefined, 0.3).baseline, 2.4);
});

Deno.test("recovery completes under a host limit with background demand and neighbour steal", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  let real = 0;
  let limited = true;
  f.g.limitGone = () => Promise.resolve(!limited);
  for (let i = 0; i < 240; i++) {
    const demand = f.cap / 100 + 0.6;
    const busy = Math.min(demand, limited ? p.limit : p.vcpus) * 0.94;
    const steal = demand - busy;
    const pressing = limited && demand > p.limit;
    real = Math.min(
      p.capacity,
      real + (pressing ? Math.min(0, p.baseline - busy) : p.baseline - busy) * 30,
    );
    if (real >= p.recovered) limited = false;
    await f.advance(30, busy / p.vcpus, steal / p.vcpus, Math.max(0, busy - 0.6));
    if (!f.g.s.limit) break;
  }
  assertEquals(limited, false);
  assertEquals(f.g.s.limit, undefined);
});

// A lift test drives several cores into the limit on purpose. The interval that contains it shows
// that steal and that CPU; neither is the slice pressing on the limit.
Deno.test("a failed lift test's own steal and CPU do not tighten the limit", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  f.g.s.balance = p.recovered;
  await f.advance(60, 0.25, 0);
  const held = f.g.s.limit!.ceiling;
  assert(held > 20);
  await f.advance(30, 0.6, 0.35, 0.2);
  assertEquals(f.g.s.limit!.ceiling, held);
});

Deno.test("evident steal enters a limit even while neighbour probes are cooling down", async () => {
  const f = fixture();
  await f.g.tick();
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(false);
  };
  for (let i = 0; i < 4; i++) await f.advance(30, 0.25, 0.03);
  assertEquals(probes, 1);
  for (let i = 0; i < 12 && !f.g.s.limit; i++) await f.advance(30, 0.2, 0.4);
  assert(f.g.s.limit);
});

Deno.test("steal well above what a failed probe saw is probed again inside the cooldown", async () => {
  const f = fixture();
  await f.g.tick();
  let probes = 0;
  let confirm = false;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(confirm);
  };
  for (let i = 0; i < 4; i++) await f.advance(30, 0.25, 0.03);
  assertEquals(probes, 1);
  confirm = true;
  for (let i = 0; i < 10 && !f.g.s.limit; i++) await f.advance(30, 0.25, 0.15);
  assertEquals(probes, 2);
  assert(f.g.s.limit);
});

Deno.test("failed lift tests back off from two minutes to fifteen", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  const at: number[] = [];
  f.g.limitGone = () => {
    at.push(f.g.s.uptime!);
    return Promise.resolve(false);
  };
  f.g.s.balance = p.recovered;
  for (let i = 0; i < 120; i++) await f.advance(30);
  const gaps = at.slice(1).map((t, i) => Math.round((t - at[i]) / 60_000));
  assertEquals(gaps.slice(0, 5), [2, 4, 8, 15, 15]);
});

Deno.test("a limit teaches the margin only once a lift test fails", async () => {
  const f = fixture();
  await f.g.tick();
  [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
  const margin = { ...f.g.s.margin };
  f.g.enterLimit(start, true);
  assertEquals(f.g.s.margin, margin);
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  for (let i = 0; i < 60; i++) await f.advance(30, 0.3, 0);
  assert(f.g.s.margin.mul > margin.mul);
});

Deno.test("a first lift test that passes leaves margin and conservative credits intact", async () => {
  const f = fixture();
  await f.g.tick();
  [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
  const margin = { ...f.g.s.margin };
  f.g.enterLimit(start, true);
  assertEquals(f.g.s.balance, 0);
  f.g.limitGone = () => Promise.resolve(true);
  // Delivery above the limit proves that it is gone, not that the bank is at the recovery point.
  // The alarm may have been false while an ungoverned workload keeps spending the real bank.
  for (let i = 0; i < 60 && f.g.s.limit; i++) await f.advance(30, 0.6, 0);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.s.margin, margin);
  assertEquals(f.g.s.balance, 0);
});

Deno.test("test CPU stays billed but cannot report outside demand blocking recovery", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.s.balance = p.recovered;
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  await f.advance(60, 0.25, 0);
  const balance = f.g.s.balance;
  await f.advance(30, 0.6, 0.35, 0.2);
  assert(f.g.s.balance < balance);
  assertEquals(f.g.publicState(start).coverage.recoveryBlocked, false);
  assertEquals(f.g.publicState(start).coverage.outsideCores, 0);
  await f.advance(30, 0.25, 0);
  assert(f.g.publicState(start).credits.rate > 0);
});

Deno.test("root reseeding invalidates pending margin learning", async () => {
  const f = fixture();
  await f.g.tick();
  [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
  f.g.enterLimit(start, true);
  await f.request("seed");
  const margin = { ...f.g.s.margin };
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  await f.advance(30, 0.3, 0);
  assertEquals(f.g.s.margin, margin);
});

Deno.test("entering another limit ignores recent probe and burner outside CPU", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance(30, 0.1);
  await f.g.limitGone();
  await f.advance(30, 0.6, 0, 0.2);
  f.g.enterLimit(start, false);
  assert(f.g.s.limit!.ceiling > 20);
});

Deno.test("a reboot discards pending limit learning and test intervals", async () => {
  const f = fixture();
  await f.g.tick();
  [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
  f.g.enterLimit(start, true);
  const margin = { ...f.g.s.margin };
  await f.g.limitGone();
  f.reboot();
  await f.g.tick();
  f.g.limitGone = () => Promise.resolve(false);
  for (let i = 0; i < 60; i++) await f.advance(30, 0.3, 0);
  assertEquals(f.g.s.margin, margin);
});

Deno.test("failed burners and ambiguous delivery cannot widen the billing margin", async () => {
  for (const brokenBurner of [true, false]) {
    const f = fixture();
    await f.g.tick();
    [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
    f.g.enterLimit(start, true);
    const margin = { ...f.g.s.margin };
    if (brokenBurner) {
      f.g.io.burner = () => ({
        status: Promise.resolve({ success: false, code: 1, signal: null }),
        kill: () => {},
      });
    } else {
      // Less than the required delivery, but still above the host's known limit.
      f.g.io.demand = () => Promise.resolve({ busy: 3.5 / p.vcpus, steal: 0.2, seconds: 25 });
    }
    for (let i = 0; i < 50; i++) await f.advance(30, 0.3, 0);
    assertEquals(f.g.s.margin, margin);
  }
});

Deno.test("a failed test's cooldown starts after the test completes", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.s.balance = p.recovered;
  f.g.limitGone = () => {
    const uptime = f.g.s.uptime! + 35_000;
    f.g.io.clock = () => Promise.resolve({ at: start, uptime, bootId: "boot-a" });
    return Promise.resolve(false);
  };
  await f.advance(30);
  assertEquals(f.g.s.limit!.testAt, f.g.s.uptime! + 35_000 + 120_000);
});

Deno.test("a throwing lift test backs off without learning or failing the tick", async () => {
  const f = fixture();
  await f.g.tick();
  [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
  f.g.enterLimit(start, true);
  f.g.s.balance = p.recovered;
  const margin = { ...f.g.s.margin };
  let attempts = 0;
  f.g.io.burner = () => {
    attempts++;
    throw new Error("timeout unavailable");
  };
  await f.advance(30);
  for (let i = 0; i < 3; i++) await f.advance(30);
  assertEquals(attempts, 1);
  assertEquals(f.g.s.margin, margin);
  await f.advance(30);
  assertEquals(attempts, 2);
});
