import { assert, assertAlmostEquals, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  compareReadings,
  detectPlan,
  Governor,
  startLine,
  validateConfig,
} from "../src/governor.ts";
import { plan } from "../src/plans.ts";
import { creditStep, liftConfirmed, type Reading } from "../src/credits.ts";
import { fixture, p, start } from "./governor-fixture.ts";
import { cpuReadings } from "../src/hostinger.ts";
import { testDirectory } from "./temp.ts";
import { flush, until, within } from "./async.ts";
import contract from "./fixtures/hostinger-protocol.json" with { type: "json" };

Deno.test("startup applies the first ceiling without contacting a hung VM broker", async () => {
  const directory = await testDirectory("startup-broker-");
  const release = `${Deno.cwd()}/${directory}/release`;
  const started = `${Deno.cwd()}/${directory}/started`;
  const cfg = {
    hostinger: {
      vm_id: 123,
      request_command: [
        "/bin/bash",
        "-c",
        `IFS= read -r request; touch '${started}'; ` +
        `while [[ ! -f '${release}' ]]; do sleep 0.01; done; ` +
        `printf '%s' '{"version":1,"vm_id":123,"data":{"cpus":4,"ipv4":[]}}'`,
      ],
    },
  };
  const originalRead = Deno.readTextFile;
  Deno.readTextFile = (...args) =>
    String(args[0]) === "/proc/stat"
      ? Promise.resolve(Array.from({ length: 8 }, (_, i) => `cpu${i} 0 0 0`).join("\n"))
      : originalRead(...args);
  const f = fixture();
  let caps = 0;
  const startup = (async () => {
    const p = await detectPlan(cfg);
    const g = new Governor(cfg, p, undefined, {
      ...f.io,
      cap: (...args) => {
        caps++;
        return f.io.cap(...args);
      },
    });
    await g.tick();
    return g.publicState(start);
  })();
  try {
    const state = await within(startup);
    assertEquals(state.plan.vcpus, 8);
    assertEquals(caps, 1);
    assertEquals(state.ceiling, f.cap);
    await assertRejects(() => Deno.stat(started), Deno.errors.NotFound);
    assertEquals(
      await detectPlan({ ...cfg, vcpus: 2, baseline_share: 0.3 }),
      plan(2, undefined, 0.3),
    );
  } finally {
    await Deno.writeTextFile(release, "");
    await startup;
    Deno.readTextFile = originalRead;
    await Deno.remove(directory, { recursive: true });
  }
});

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

Deno.test("public state identifies its schema independently of persisted accounting", () => {
  const f = fixture();
  const state = f.g.publicState(start);
  assertEquals(state.schemaVersion, 1);
  assertEquals(f.g.s.schema, 2);
});

Deno.test("back-to-back ticks preserve credits and apply queued control changes", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance();
  await f.request("seed");
  const baseline = structuredClone(f.g.s);
  await f.g.tick();
  await f.g.tick();
  assertEquals(f.g.s.balance, p.capacity);
  assertEquals(f.g.s.samples, baseline.samples);
  assertEquals(f.g.s.cpuPrev, baseline.cpuPrev);
  assertEquals(f.g.s.usagePrev, baseline.usagePrev);
  assertEquals(f.g.s.rebuilding, null);
  await f.request("limit-on");
  await f.g.tick();
  assertEquals(f.cap, f.g.s.limit!.ceiling);
  assertEquals(f.g.publicState(start).accepting, false);
  await f.request("limit-off");
  await f.g.tick();
  assertEquals(f.g.s.balance, p.recovered);
  assertEquals(f.g.publicState(start).accepting, true);
  await f.advance();
  assertEquals(f.g.s.samples.length, baseline.samples.length + 1);
  assertEquals(f.g.s.samples.at(-1)!.seconds, 30);
});

Deno.test("unchanged CPU counters preserve the full accounting interval", async () => {
  const f = fixture();
  await f.g.tick();
  await f.request("seed");
  const baseline = structuredClone(f.g.s);
  await f.g.tick({ at: start + 5, uptime: 100_005, bootId: "boot-a" });
  assertEquals(f.g.s.balance, p.capacity);
  assertEquals(f.g.s.uptime, baseline.uptime);
  assertEquals(f.g.s.cpuPrev, baseline.cpuPrev);
  await f.advance(30, 0.8);
  assert(f.g.s.balance < p.capacity);
  assertEquals(f.g.s.samples.at(-1)!.seconds, 30);
});

Deno.test("short samples cannot permanently tighten a recovery ceiling", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance();
  const before = structuredClone(f.g.s);
  assertEquals(before.limit!.ceiling, 210);
  // Four busy jiffies in a 20 ms interval on eight CPUs look like two outside cores.
  await f.advance(0.02, 0.25, 0, 0, 0.02, 16);
  assertEquals(f.g.s.limit!.ceiling, before.limit!.ceiling);
  assertEquals(f.g.s.samples, before.samples);
  assertEquals(f.g.s.cpuPrev, before.cpuPrev);
  await f.advance(29.98, 0, 0, 0, 29.98, 23984);
  assertEquals(f.g.s.limit!.ceiling, before.limit!.ceiling);
  assertEquals(f.g.s.samples.at(-1)!.seconds, 30);
  assertEquals(f.g.s.samples.at(-1)!.busy, 4 / 24000);
  assertEquals(
    f.g.s.balance,
    creditStep(p, before.balance, 4 / 24000 * p.vcpus, 30, before.margin, true),
  );
});

Deno.test("a window holding only a test sample cannot tighten a recovery ceiling", async () => {
  const f = fixture({ tick_seconds: 300 });
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.s.limit!.testAt = Infinity;
  await f.advance(300);
  const ceiling = f.g.s.limit!.ceiling;
  // At long ticks the sample after a lift test can be the only one in the five-minute window.
  f.g.s.tested = true;
  await f.advance(301);
  assertEquals(f.g.s.samples.at(-1)!.test, true);
  assertEquals(f.g.s.limit!.ceiling, ceiling);
});

for (const tickSeconds of [1, 10, 30, 300]) {
  Deno.test(`minimum sample interval scales with ${tickSeconds}s ticks and preserves CPU use`, async () => {
    const f = fixture({ tick_seconds: tickSeconds });
    await f.g.tick();
    f.g.s.balance = 5000;
    const before = structuredClone(f.g.s);
    const seconds = Math.min(5, tickSeconds / 2);
    await f.advance(seconds - 0.01, 0.25, 0, 2, seconds - 0.01, (seconds - 0.01) * 800);
    assertEquals(f.g.s.balance, before.balance);
    assertEquals(f.g.s.cpuPrev, before.cpuPrev);
    assertEquals(f.g.s.usagePrev, before.usagePrev);
    assertEquals(f.g.s.samples.length, 0);
    await f.advance(0.01, 0.5, 0, 4, 0.01, 8);
    assertEquals(f.g.s.samples.length, 1);
    const sample = f.g.s.samples[0];
    assertEquals(sample.seconds, seconds);
    assertEquals(
      f.g.s.balance,
      creditStep(p, before.balance, sample.busy * p.vcpus, seconds, before.margin, true),
    );
    await f.advance(tickSeconds);
    assertEquals(f.g.s.samples.length, 2);
    assertEquals(f.g.s.samples[1].seconds, tickSeconds);
  });
}

Deno.test("a pending limit-start hook cannot delay the ceiling update or tick", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance(30, 0.25, 0.5);
  await f.advance(30, 0.25, 0.5);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let started = false;
  let hookCeiling = 0;
  let hookLimitCeiling = 0;
  f.g.io.hooks = async (_event, state) => {
    started = true;
    hookCeiling = state.ceiling;
    hookLimitCeiling = state.limit!.ceiling;
    await gate;
  };
  const tick = f.advance(30, 0.25, 0.5);
  try {
    await within(tick, 30);
    assert(started);
    assertEquals(f.cap, f.g.s.limit!.ceiling);
    assertEquals(hookCeiling, hookLimitCeiling);
  } finally {
    release();
    await tick;
  }
});

Deno.test("invalid fallback settings are rejected during configuration validation", () => {
  for (const value of [0, 19, 20.5, -1, NaN, Infinity, "150"]) {
    assertThrows(() => validateConfig(JSON.parse(JSON.stringify({ fallback_cpu_percent: value }))));
  }
});

Deno.test("hook dispatch failure cannot fail CPU control or mutate the governor state", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.io.hooks = (_event, state) => {
    state.credits.margin.mul = 999;
    if (state.limit) state.limit.ceiling = 800;
    return Promise.reject(new Error("unavailable notification destination"));
  };
  await f.advance(30, 0.25, 0.5);
  await f.advance(30, 0.25, 0.5);
  await f.advance(30, 0.25, 0.5);
  assertEquals(f.g.s.margin.mul, 1.05);
  assertEquals(f.cap, f.g.s.limit!.ceiling);
  assert(f.cap <= 210);
});

Deno.test("a pending limit-end hook cannot delay resuming the ceiling", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.s.balance = p.recovered;
  f.g.limitGone = () => Promise.resolve(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let stateCeiling = 0;
  f.g.io.hooks = async (event, state) => {
    assertEquals(event, "limit-end");
    assertEquals(state.limit, null);
    stateCeiling = state.ceiling;
    await gate;
  };
  const tick = f.advance();
  try {
    await within(tick, 30);
    assertEquals(stateCeiling, f.cap);
    assertEquals(f.g.s.limit, undefined);
  } finally {
    release();
    await tick;
  }
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

Deno.test("a hung diagnostics broker cannot delay this or the next ceiling update", async () => {
  const directory = await testDirectory("diagnostics-hang-");
  const release = `${Deno.cwd()}/${directory}/release`;
  const f = fixture({
    initial_balance: p.capacity,
    hostinger: {
      vm_id: 123,
      request_command: [
        "/bin/bash",
        "-c",
        `IFS= read -r request; while [[ ! -f '${release}' ]]; do sleep 0.01; done; ` +
        `printf '%s' '{"version":1,"vm_id":123,"data":{"cpu_usage":{"unit":"%","usage":{}}}}'`,
      ],
    },
  });
  let request: Promise<unknown> | undefined;
  let requests = 0;
  f.g.io.readings = (...args) => {
    requests++;
    return request = cpuReadings(...args);
  };
  let tick: Promise<void> | undefined;
  try {
    await f.g.tick();
    const initialCeiling = f.cap;
    f.g.s.balance = 0;
    tick = f.advance(30, 0.5);
    await within(tick);
    assert(f.cap < initialCeiling);
    const depletedCeiling = f.cap;
    assertEquals(requests, 1);
    // Several scheduled checks become due while the same broker request remains hung.
    for (let i = 0; i < 3; i++) {
      await f.request("seed");
      await within(f.advance(1800));
      assert(f.cap > depletedCeiling);
      assertEquals(f.g.publicState(start).accepting, true);
      assertEquals(requests, 1);
    }
  } finally {
    await Deno.writeTextFile(release, "");
    await tick;
    await request;
    await f.g.closeDiagnostics();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("shutdown waits for the broker to finish before a subsequent request", async () => {
  const directory = await testDirectory("shutdown-broker-");
  const release = `${Deno.cwd()}/${directory}/release`;
  const started = `${Deno.cwd()}/${directory}/started`;
  const finished = `${Deno.cwd()}/${directory}/finished`;
  const f = fixture({
    hostinger: {
      vm_id: 123,
      request_command: [
        "/bin/bash",
        "-c",
        `IFS= read -r request; touch '${started}'; ` +
        `while [[ ! -f '${release}' ]]; do sleep 0.01; done; ` +
        `touch '${finished}'; ` +
        `printf '%s' '{"version":1,"vm_id":123,"data":{"cpu_usage":{"unit":"%","usage":{}}}}'`,
      ],
    },
  });
  let requests = 0;
  f.g.io.readings = (...args) => {
    requests++;
    return cpuReadings(...args);
  };
  await f.g.tick();
  await f.advance();
  assertEquals(requests, 1);
  let shutdown: Promise<void> | undefined;
  let closed = false;
  try {
    await until(async () => (await Deno.stat(started).catch(() => null))?.isFile ?? false);
    shutdown = f.g.closeDiagnostics().then(() => {
      closed = true;
    });
    await flush();
    assertEquals(closed, false);
    await Deno.writeTextFile(release, "");
    // The broker still has to notice the release, exit and be read, so allow as long as its start.
    await within(shutdown, 1000);
    assert((await Deno.stat(finished)).isFile);
    await f.advance(1800);
    assertEquals(requests, 1);
    assertEquals(f.g.s.anchor, undefined);
    assertEquals(await cpuReadings(f.g.cfg.hostinger!, 123, 0, 5_000_000), []);
  } finally {
    await Deno.writeTextFile(release, "");
    await shutdown;
    await f.g.closeDiagnostics();
    await Deno.remove(directory, { recursive: true });
  }
});

for (const reset of ["reboot", "resetCounters"] as const) {
  Deno.test(`diagnostics from before ${reset} cannot publish or change retry timing`, async () => {
    const f = fixture({ hostinger: { vm_id: 123 } });
    let release!: (readings: Reading[]) => void;
    const pending = new Promise<Reading[]>((resolve) => release = resolve);
    // Leave the request outstanding to verify its result cannot revive pre-reset state.
    f.g.io.readings = () => pending;
    await f.g.tick();
    await f.advance();
    f[reset]();
    await f.g.tick();
    release([{ at: start - 1_800_000, v: 0 }, { at: start, v: 0 }, { at: start + 15_000, v: 0 }]);
    await flush();
    assertEquals(f.g.s.anchor, undefined);
    assertEquals(f.g.s.readings, []);
    f.g.io.readings = f.io.readings;
    await f.advance();
    assertEquals(f.attempts, 1);
    await f.g.closeDiagnostics();
  });
}

for (const limited of [false, true]) {
  Deno.test(`late diagnostics ${limited ? "while limited " : ""}leave local control unchanged`, async () => {
    const f = fixture({ hostinger: { vm_id: 123 } });
    let release!: (readings: Reading[]) => void;
    f.g.io.readings = () => new Promise((resolve) => release = resolve);
    await f.g.tick();
    await f.advance(30, 0.5);
    if (limited) {
      await f.request("limit-on");
      await f.g.tick();
    }
    const before = structuredClone(f.g.s);
    const publicBefore = f.g.publicState(start);
    const cap = f.cap;
    release([{ at: start - 1_800_000, v: 0 }, { at: start, v: 0 }, { at: start + 15_000, v: 0 }]);
    await flush();
    const after = f.g.publicState(start);
    assertEquals(f.g.s.balance, before.balance);
    assertEquals(f.g.s.used, before.used);
    assertEquals(f.g.s.margin, before.margin);
    assertEquals(f.g.s.limit, before.limit);
    assertEquals(f.cap, cap);
    assertEquals(after.accepting, publicBefore.accepting);
    assertEquals(after.credits.anchor?.applied, false);
    assertEquals(after.credits.anchor?.exact, false);
    await f.g.closeDiagnostics();
  });
}

Deno.test("restarting on the same boot retires old timers and checks diagnostics promptly", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance();
  const saved = {
    ...f.g.s,
    balance: 5000,
    anchorNext: 1_930_000,
    anchorBackoff: 1_800_000,
  };
  const g = new Governor({ hostinger: { vm_id: 123 } }, p, saved, f.io);
  assertEquals(g.s.balance, 5000);
  await g.tick();
  f.elapse();
  await g.tick();
  await flush();
  assertEquals(f.attempts, 1);
  assertEquals("anchorNext" in g.s, false);
  assertEquals("anchorBackoff" in g.s, false);
  await g.closeDiagnostics();
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

Deno.test("an idle slice is never probed, however its steal compares with its demand", async () => {
  // A live KVM 8 box, Nov 2026: 0.17 cores busy, 0.13 of them outside the slice, 10-25% steal. The probe's cut
  // to 0.2 cores cut nothing, and noise confirmed 12 false limits.
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(true);
  };
  for (let i = 0; i < 20; i++) await f.advance(30, 0.17 / 8, 0.03 / 8, 0.04);
  // A 60% share of almost nothing isn't evident either.
  for (let i = 0; i < 20; i++) await f.advance(30, 0.02 / 8, 0.04 / 8, 0.01);
  assertEquals(probes, 0);
  assertEquals(f.g.s.limit, undefined);
});

Deno.test("steal on work outside the slice doesn't make the slice worth probing", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(true);
  };
  // 3 cores outside with 20% steal: their steal once read as 0.6 cores of slice demand.
  for (let i = 0; i < 20; i++) await f.advance(30, 3.2 / 8, 0.8 / 8, 0.05);
  assertEquals(probes, 0);
  // The slice's own work is probed as before.
  for (let i = 0; i < 4; i++) await f.advance(30, 2.5 / 8, 0.4 / 8, 2.4);
  assertEquals(probes, 1);
});

Deno.test("work outside an idle slice pinned at the cap confirms with burners and rejects noisy hosts", async () => {
  for (
    const [limited, busy, steal, burnBusy, burnSteal] of [
      // Real 2.4-core cap with 3 cores outside, at a full estimate (wrong estimate).
      [true, 2.38 / 8, 0.62 / 8, 2.4 / 8, 0.7],
      // Real 2.4-core cap with 10% neighbour steal (2.16 cores delivered).
      [true, 2.16 / 8, 1.34 / 8, 2.16 / 8, 0.73],
      // No limit, 2.9 cores outside + 20% neighbour steal, at a low estimate (10%): burners break through.
      [false, 2.32 / 8, 0.58 / 8, 5.8 / 8, 0.2],
    ] as const
  ) {
    const f = fixture();
    let burns = 0;
    const g = new Governor({}, p, undefined, {
      ...f.io,
      demand: () => {
        burns++;
        return Promise.resolve({ busy: burnBusy, steal: burnSteal, seconds: 25 });
      },
    });
    const tickWith = async (b: number, st: number, managed: number) => {
      f.elapse(30, b, st, managed);
      await g.tick();
    };
    await g.tick();
    g.s.balance = limited ? p.capacity : 0.1 * p.capacity;
    let probes = 0;
    g.probe = () => {
      probes++;
      return Promise.resolve(true);
    };
    for (let i = 0; i < 6 && !g.s.limit; i++) await tickWith(busy, steal, 0.04);
    assertEquals(probes, 0);
    assertEquals(burns, 1);
    assertEquals(!!g.s.limit, limited);
    if (limited) assertEquals(g.s.limit?.record?.path, "probe");
  }
});

Deno.test("no probe or pinned check follows a credit lift until its bank could be spent, shortened by lift lag", async () => {
  const f = fixture();
  let testBusy = 2.4 / 8, testSteal = 0.7;
  const g = new Governor({}, p, undefined, {
    ...f.io,
    demand: () => Promise.resolve({ busy: testBusy, steal: testSteal, seconds: 25 }),
  });
  await g.tick();
  g.s.used = 200_000;
  g.enterLimit(start, false);
  g.s.balance = p.recovered;
  // First lift test fails with limited evidence, confirming a credit limit and recording limitedUptime.
  f.elapse(30);
  await g.tick();
  assert(g.s.limit);
  assertEquals(g.s.limit.record?.confirmed, true);
  // Two minutes later (matching the 2-minute lift-test backoff), the limit lifts.
  testBusy = 4.7 / 8;
  testSteal = 0.06;
  for (let i = 0; i < 6 && g.s.limit; i++) {
    f.elapse(30);
    await g.tick();
  }
  assertEquals(g.s.limit, undefined);
  let probes = 0;
  g.probe = () => {
    probes++;
    return Promise.resolve(false);
  };
  // After widening, the quiet window from limitedUptime leaves ~28 minutes after detection: 24 min
  // stays quiet, then a probe fires once the window passes.
  for (let i = 0; i < 48; i++) {
    f.elapse(30, 2.5 / 8, 0.4 / 8, 2.4);
    await g.tick();
  }
  assertEquals(probes, 0);
  for (let i = 0; i < 16 && probes === 0; i++) {
    f.elapse(30, 2.5 / 8, 0.4 / 8, 2.4);
    await g.tick();
  }
  assertEquals(probes, 1);

  // During a quiet window, evident steal still enters immediately.
  g.s.used = 200_000;
  g.enterLimit(g.s.at, false);
  g.s.balance = p.recovered;
  testBusy = 2.4 / 8;
  testSteal = 0.7;
  f.elapse(30);
  await g.tick();
  assertEquals(g.s.limit?.record?.confirmed, true);
  testBusy = 4.7 / 8;
  testSteal = 0.06;
  for (let i = 0; i < 6 && g.s.limit; i++) {
    f.elapse(30);
    await g.tick();
  }
  assertEquals(g.s.limit, undefined);
  for (let i = 0; i < 12 && !g.s.limit; i++) {
    f.elapse(30, 2.4 / 8, 5.6 / 8, 2.4);
    await g.tick();
  }
  assert(g.s.limit);
  assertEquals(probes, 1);
});

Deno.test("unknown and sustained-use lifts do not suppress probes afterward", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.limitGone = () => Promise.resolve(true);
  f.g.s.balance = p.recovered;
  for (let i = 0; i < 4 && f.g.s.limit; i++) await f.advance(30);
  assertEquals(f.g.s.limit, undefined);
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(false);
  };
  for (let i = 0; i < 4; i++) await f.advance(30, 2.5 / 8, 0.4 / 8, 2.4);
  assertEquals(probes, 1);
});

Deno.test("a limit tightens the ceiling only where the slice's demand would feel it, using the current sample's outside load", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance(30, 0.17 / 8, 0.01 / 8, 0.04);
  const held = f.g.s.limit!.ceiling;
  // Noise presses on an idle slice: tightening it gives nothing back.
  for (let i = 0; i < 10; i++) await f.advance(30, 0.17 / 8, 0.01 / 8, 0.04);
  assertEquals(f.g.s.limit!.ceiling, held);
  // After an outside burst ends, tightening still cuts a busy slice without waiting for the 5-minute window to decay.
  for (let i = 0; i < 6; i++) await f.advance(30, 1.4 / 8, 0, 0.1);
  const before = f.g.s.limit!.ceiling;
  await f.advance(30, 0.9 / 8, 0.18 / 8, 0.9);
  await f.advance(30, 0.9 / 8, 0.18 / 8, 0.9);
  assert(f.g.s.limit!.ceiling < before, `${f.g.s.limit!.ceiling} of ${before}`);
});

Deno.test("failed probes back off from 10 minutes to 1 hour regardless of estimate, and keep backoffMs for downgrade safety", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(false);
  };
  // First failed probe at 25% steal on a full estimate sets a 10-minute cooldown, not hours.
  for (let i = 0; i < 4 && probes === 0; i++) await f.advance(30, 2.4 / 8, 0.8 / 8, 2.4);
  assertEquals(probes, 1);
  assertEquals(f.g.s.probe.backoffMs, 20 * 60_000);
  // A real limit at 45.5% steal (below 60% evident and 2x jump) is probed after 10 minutes.
  for (let i = 0; i < 19; i++) await f.advance(30, 2.4 / 8, 2.0 / 8, 2.4);
  assertEquals(probes, 1);
  await f.advance(30, 2.4 / 8, 2.0 / 8, 2.4);
  assertEquals(probes, 2);
  assertEquals(f.g.s.probe.backoffMs, 40 * 60_000);
  // State loaded without backoffMs still recovers a valid finite backoff.
  const withoutBackoff = JSON.parse(JSON.stringify(f.g.s));
  delete withoutBackoff.probe.backoffMs;
  const restored = new Governor({}, p, withoutBackoff, f.io);
  assertEquals(restored.s.probe.backoffMs, 10 * 60_000);
});

Deno.test("steal at or above 60% below the evident steal floor still probes when the slice has demand", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(true);
  };
  // One thread under a KVM 8 per-vCPU cap: 0.30 busy, 0.55 steal (64.7% >= 60%, 0.55 < 0.60 evident floor).
  for (let i = 0; i < 4 && !f.g.s.limit; i++) await f.advance(30, 0.30 / 8, 0.55 / 8, 0.30);
  assertEquals(probes, 1);
  assert(f.g.s.limit);
});

Deno.test("KVM 1 and KVM 2 skip futile probes below 0.20 busy cores and probe slices at 0.25 busy cores", async () => {
  for (const vcpus of [1, 2]) {
    const small = plan(vcpus);
    // Below PROBE_CEILING (0.20 busy cores): a 20% quota probe cannot cut the slice, so route to
    // burner confirmation instead of futile probing.
    const fLow = fixture({ vcpus });
    const gLow = new Governor({ vcpus }, small, undefined, fLow.io);
    await gLow.tick();
    gLow.s.balance = small.capacity;
    let lowProbes = 0;
    let burnerRuns = 0;
    gLow.probe = () => {
      lowProbes++;
      return Promise.resolve(true);
    };
    gLow.io.demand = () => {
      burnerRuns++;
      return Promise.resolve({ busy: small.limit / vcpus, steal: 0.5, seconds: 25 });
    };
    for (let i = 0; i < 4 && !gLow.s.limit; i++) {
      fLow.elapse(30, small.limit / vcpus, small.limit / vcpus, 0.175);
      await gLow.tick();
    }
    assertEquals(lowProbes, 0, `KVM ${vcpus} below 0.20`);
    assertEquals(burnerRuns, 1, `KVM ${vcpus} below 0.20`);
    assert(gLow.s.limit, `KVM ${vcpus} below 0.20`);

    // At 0.25 busy cores (>= 0.20): the 20% probe cuts the slice cleanly and enters via probe.
    const fHigh = fixture({ vcpus });
    const gHigh = new Governor({ vcpus }, small, undefined, fHigh.io);
    await gHigh.tick();
    gHigh.s.balance = small.capacity;
    let highProbes = 0;
    gHigh.probe = () => {
      highProbes++;
      return Promise.resolve(true);
    };
    for (let i = 0; i < 4 && !gHigh.s.limit; i++) {
      fHigh.elapse(30, small.limit / vcpus, small.limit / vcpus, 0.25);
      await gHigh.tick();
    }
    assertEquals(highProbes, 1, `KVM ${vcpus} at 0.25`);
    assert(gHigh.s.limit, `KVM ${vcpus} at 0.25`);
  }
});

Deno.test("a single-tick outside spike does not zero out steady slice demand for probing", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  let probes = 0;
  f.g.probe = () => {
    probes++;
    return Promise.resolve(true);
  };
  await f.advance(30, 1.0 / 8, 0.35 / 8, 1.0);
  await f.advance(30, 1.0 / 8, 0.35 / 8, 1.0);
  // One tick with a 1.5-core outside spike: 3-tick avg outside is 0.5, not 1.5, so sliceDemand stays >= 0.4.
  await f.advance(30, 2.5 / 8, 0.85 / 8, 1.0);
  assertEquals(probes, 1);
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

Deno.test("setup's limit-test budget covers the probe and the lift test", async () => {
  // tools/setup-hostinger-broker.py sizes its service waits from this shared value.
  const f = fixture();
  let probeMs = 0;
  const probing = new Governor({}, p, undefined, {
    ...f.io,
    pause: (ms) => {
      probeMs += ms;
      return Promise.resolve();
    },
    steal: (ms) => {
      probeMs += ms;
      return Promise.resolve(0);
    },
  });
  await probing.probe(0.5, 200);
  assertEquals(probeMs, contract.governor_limit_test_ms);
  let liftMs = 0;
  const lifting = new Governor({}, p, undefined, {
    ...f.io,
    pause: (ms) => {
      liftMs += ms;
      return Promise.resolve();
    },
    demand: (ms) => {
      liftMs += ms;
      return f.io.demand(ms);
    },
  });
  await lifting.limitGone();
  assert(liftMs < contract.governor_limit_test_ms);
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

Deno.test("CPU comparison skips intervals outside 900 to 2,700 seconds", () => {
  const readings = [{ at: start, v: 0 }, { at: start + 2_701_000, v: 25 }, {
    at: start + 4_501_000,
    v: 50,
  }];
  const samples = [{ at: start + 2_701_000, seconds: 2701, busy: 0.2, steal: 0 }, {
    at: start + 4_501_000,
    seconds: 1800,
    busy: 0.4,
    steal: 0,
  }];
  // Only the second interval counts: 50% read against 40% measured.
  assertEquals(compareReadings(readings, samples), 10);
});

Deno.test("CPU comparison requires complete guest coverage and rejects clock-jump samples", () => {
  const readings = [{ at: start, v: 0 }, { at: start + 1_798_000, v: 25 }, {
    at: start + 3_849_000,
    v: 45,
  }];
  const samples = [{ at: start + 1_798_000, seconds: 1798, busy: 0.2, steal: 0 }, {
    at: start + 3_849_000,
    seconds: 2051,
    busy: 0.4,
    steal: 0,
  }];
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
  assertThrows(() => validateConfig({ hostinger: { request_command: ["/usr/bin/broker"] } }));
  assertEquals(
    validateConfig({
      hostinger: { vm_id: 123, request_command: ["/usr/bin/sudo", "-n", "/usr/bin/broker"] },
    }).hostinger?.vm_id,
    123,
  );
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

Deno.test("a limit teaches the margin only once a lift test fails, when it lifts", async () => {
  const f = fixture();
  await f.g.tick();
  [f.g.s.balance, f.g.s.used] = [20_000, 50_000];
  const margin = { ...f.g.s.margin };
  f.g.enterLimit(start, true);
  assertEquals(f.g.s.margin, margin);
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  for (let i = 0; i < 60; i++) await f.advance(30, 0.3, 0);
  assertEquals(f.g.s.limit?.record?.confirmed, true);
  // Classification at the lift, with every cap recorded, decides what the limit teaches.
  assertEquals(f.g.s.margin, margin);
  f.g.limitGone = () => Promise.resolve(true);
  for (let i = 0; i < 60 && f.g.s.limit; i++) await f.advance(30, 0.3, 0);
  assertEquals(f.g.s.limit, undefined);
  assertEquals(f.g.history.limits.at(-1)?.class, "credit");
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

Deno.test("the start line says a reboot restarts the bank at 0", () => {
  const kvm8 = plan(8);
  const half = kvm8.capacity / 2;
  assertEquals(
    startLine(kvm8, half, "boot-a", "boot-a"),
    "governor up: KVM 8, baseline 4.8 vCPU, capacity 34560 core-seconds, 50% credits",
  );
  assertEquals(
    startLine(kvm8, half, "boot-a", "boot-b"),
    "governor up: KVM 8, baseline 4.8 vCPU, capacity 34560 core-seconds, 0% credits after a reboot (50% before it)",
  );
  // A first start has no saved boot and nothing to restart.
  assertEquals(startLine(kvm8, 0, undefined, "boot-b").endsWith(", 0% credits"), true);
});

Deno.test("pinned-at-cap confirmation preserves post-burner start and cap delivery while requiring a recovery lift test to confirm", async () => {
  const f = fixture({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" },
  });
  await f.g.tick();
  f.g.s.balance = p.capacity;
  // Burners see the real 2.4-core host cap (52% demand steal) and consume 30s of wall + uptime.
  f.g.io.demand = () => {
    f.elapse(30, 2.4 / 8, 2.6 / 8, 0.04);
    return Promise.resolve({ busy: 2.4 / 8, steal: 0.52, seconds: 25 });
  };
  // Outside load (2.34 cores; slice = 0.04 cores) pins the cap while slice is idle.
  for (let i = 0; i < 4 && !f.g.s.limit; i++) {
    await f.advance(30, 2.38 / 8, 0.80 / 8, 0.04);
  }
  const lim = f.g.s.limit!;
  assert(lim);
  assert(lim.entry !== undefined);
  assertEquals(lim.limitedUptime, undefined);
  assertEquals(lim.record?.confirmed, false);
  assertEquals(lim.record?.firstTest, undefined);
  assertEquals(lim.record?.limitedAt, undefined);
  assertEquals(lim.record?.testDelivery, { busy: 2.4, demand: 2.4 / (1 - 0.52) });
  // One failed lift test during recovery confirms the limit and records limitedAt/limitedUptime.
  let liftCalls = 0;
  f.g.io.demand = () => {
    liftCalls++;
    return Promise.resolve(
      liftCalls === 1
        ? { busy: 2.4 / 8, steal: 0.52, seconds: 25 }
        : { busy: 5 / 8, steal: 0, seconds: 25 },
    );
  };
  for (let i = 0; i < 80 && f.g.s.limit; i++) await f.advance(30, 0.2 / 8, 0, 0.1);
  assertEquals(f.g.s.limit, undefined);
  const rec = f.g.history.limits.at(-1)!;
  assertEquals(rec.class, "credit");
  assertEquals(rec.confirmed, true);
  assert(rec.limitedAt !== undefined && rec.limitedAt > rec.entry);
  assert(f.g.s.balance >= f.g.law.floor * p.capacity, `${f.g.s.balance}`);
  assert(f.g.actedBalance >= f.g.law.floor * p.capacity, `${f.g.actedBalance}`);
});

Deno.test("confirmed credit lift restores starving balance and clamp up to floor, and accounts for spending since limitedAt", async () => {
  // Direction 1: in apply mode with pre-lift replayBase and pressing ticks in recovery slots,
  // restoring lifts both s.balance and replayBase to the spending floor (full baseline speed,
  // without unleashing a burst above baseline before settled readings corroborate the limit).
  {
    const f = fixture({
      hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
      calibration: { mode: "apply" },
    });
    await f.g.tick();
    const onset = f.g.s.at + 30_000;
    f.g.enterLimit(onset, true, "probe");
    const lim = f.g.s.limit!;
    lim.record!.confirmed = true;
    lim.record!.caps = [{ at: onset, busy: 2.4, demand: 4.0, ceiling: 800, pressing: true }];
    f.g.calibration.replayBase = { at: onset, balance: 0, exact: true, gap: 0, origin: onset };
    f.g.history.readings = [{ at: onset, v: 0 }];
    for (let i = 0; i < 60; i++) {
      lim.testAt = 1e15;
      if (i % 20 === 5) await f.advance(30, 0.4 / 8, 0.05 / 8, 0.1);
      else await f.advance(30, 0.1 / 8, 0, 0.05);
    }
    lim.record!.limitedAt = f.g.s.at;
    lim.limitedUptime = f.g.s.uptime;
    lim.testAt = 0;
    f.g.s.balance = 0;
    f.g.io.demand = () => Promise.resolve({ busy: 5 / 8, steal: 0, seconds: 25 });
    await f.advance(30, 0.1 / 8, 0, 0.05);
    const floorCap = f.g.law.floor * p.capacity;
    assertEquals(f.g.history.limits.at(-1)?.class, "credit");
    assert(f.g.s.balance >= floorCap - 1e-6, `${f.g.s.balance} vs ${floorCap}`);
    assert(f.g.actedBalance >= floorCap - 1e-6, `${f.g.actedBalance} vs ${floorCap}`);
    assertEquals(f.g.s.used, 0);
    // At the floor, the box gets full baseline (~450% on KVM 8) instead of starving below baseline.
    assert(f.cap >= 440, `expected lifted ceiling >= 440%, got ${f.cap}%`);
  }
  // Direction 2: 10 minutes of 8-core outside burn between limitedAt and detection lowers the
  // recorded liftBalance below p.recovered (and caps restore in off mode, where floor == recovered).
  {
    const f = fixture();
    await f.g.tick();
    const onset = f.g.s.at + 30_000;
    f.g.enterLimit(onset, true, "probe");
    const lim = f.g.s.limit!;
    lim.startedAt = -3_600_000;
    lim.record!.confirmed = true;
    lim.record!.caps = [{ at: onset, busy: 2.4, demand: 4.0, ceiling: 800, pressing: true }];
    lim.record!.limitedAt = f.g.s.at;
    lim.limitedUptime = f.g.s.uptime;
    lim.testAt = 1e15;
    // 10 minutes of 8-core outside work after limitedAt.
    for (let i = 0; i < 19; i++) await f.advance(30, 8.0 / 8, 0, 0);
    lim.testAt = 0;
    f.g.s.balance = 0;
    f.g.io.demand = () => Promise.resolve({ busy: 5 / 8, steal: 0, seconds: 25 });
    await f.advance(30, 8.0 / 8, 0, 0);
    const rec = f.g.history.limits.at(-1)!;
    assertEquals(rec.class, "credit");
    assert(
      rec.liftBalance !== undefined && rec.liftBalance < p.recovered - 1900,
      `${rec.liftBalance}`,
    );
    assertAlmostEquals(f.g.s.balance, rec.liftBalance!, 1e-6);
    assert(f.g.actedBalance <= rec.liftBalance! + 1e-6, `${f.g.actedBalance}`);
  }
});

Deno.test("recovery ceiling relaxes after outside spikes with or without steal, migrates legacy limits conservatively, and avoids per-tick churn", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, false);
  f.g.s.limit!.testAt = 1e15;
  // Advance past TIGHTEN_AFTER_MS (60s), then send a transient outside spike WITH steal (2.4 busy,
  // 0.4 steal, 0.20 managed -> outside 2.2): drops ceiling to 20% without latching tightenedCeiling.
  await f.advance(30, 0.2 / 8, 0, 0);
  await f.advance(30, 0.2 / 8, 0, 0);
  await f.advance(30, 2.4 / 8, 0.4 / 8, 0.20);
  assertEquals(f.g.s.limit!.ceiling, 20);
  assertEquals(f.g.s.limit!.tightenedCeiling, 800);
  // Once outside drops back to 0.2 cores and clears the 5-minute window, ceiling relaxes back up.
  for (let i = 0; i < 11; i++) await f.advance(30, 0.2 / 8, 0, 0);
  assert(f.g.s.limit!.ceiling >= 180, `${f.g.s.limit!.ceiling}`);
  // Alternating outside 0.5 <-> 0.7 cores during recovery does not churn quota calls every tick.
  let capCalls = 0;
  const origCap = f.g.io.cap;
  f.g.io.cap = (slice, pct, period) => {
    capCalls++;
    return origCap(slice, pct, period);
  };
  for (let i = 0; i < 10; i++) await f.advance(30, (i % 2 === 0 ? 0.5 : 0.7) / 8, 0, 0);
  assert(capCalls <= 3, `expected low recovery churn, got ${capCalls} cap calls`);
  f.g.io.cap = origCap;
  // Genuine pressing (slice = 1.8 cores, outside = 0.2) cuts ceiling strictly below current and
  // latches tightenedCeiling so it stays capped even after quiet returns.
  for (let i = 0; i < 11; i++) await f.advance(30, 0.2 / 8, 0, 0);
  const beforePress = f.g.s.limit!.ceiling;
  await f.advance(30, 2.0 / 8, 0.4 / 8, 1.8);
  await f.advance(30, 2.0 / 8, 0.4 / 8, 1.8);
  const tightened = f.g.s.limit!.ceiling;
  assert(tightened < beforePress, `${tightened} vs ${beforePress}`);
  for (let i = 0; i < 11; i++) await f.advance(30, 0.2 / 8, 0, 0);
  assertEquals(f.g.s.limit!.ceiling, tightened);
  // Legacy v0.3.2 persisted limit at 20% (no tightenedCeiling) migrates conservatively to 20%.
  const saved = JSON.parse(JSON.stringify(f.g.s));
  saved.limit.ceiling = 20;
  delete saved.limit.tightenedCeiling;
  const legacyGov = new Governor({}, p, saved, f.g.io);
  assertEquals(legacyGov.s.limit!.tightenedCeiling, 20);
});

Deno.test("unlimited noisy idle slots do not set FLAGS.pressing and onset walkback stops at idle, above-cap, or diffuse steal", async () => {
  const f = fixture({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" },
  });
  await f.g.tick();
  f.g.s.balance = p.capacity;
  // 25 minutes of idle host with 0.03 cores neighbour steal (16.7% of demand >= 10% LIMIT_STEAL,
  // which walked onset back on v0.3.2).
  for (let i = 0; i < 50; i++) await f.advance(30, 0.15 / 8, 0.03 / 8, 0.05);
  assert(f.g.history.slots.length >= 2);
  for (const sl of f.g.history.slots) {
    assertEquals(sl.flags & 4, 0, `unexpected FLAGS.pressing on unlimited slot: ${sl.flags}`);
  }
  // Above-cap noisy busy sample (3.0 busy > 2.4 limit, 0.4 steal) also stops walkback.
  await f.advance(30, 3.0 / 8, 0.4 / 8, 2.5);
  // Real limit begins on a cap-shaped sample.
  await f.advance(30, 2.4 / 8, 1.0 / 8, 2.3);
  const busyAt = f.g.s.at;
  f.g.enterLimit(busyAt, true, "evident");
  assertEquals(f.g.s.limit!.record!.onset, busyAt - 30_000);
  // An hour of diffuse multi-vCPU neighbour steal (0.21 busy + 0.11 steal) bounds walkback to 5 min.
  const f2 = fixture();
  await f2.g.tick();
  for (let i = 0; i < 120; i++) await f2.advance(30, 0.21 / 8, 0.11 / 8, 0.10);
  await f2.advance(30, 2.4 / 8, 1.0 / 8, 2.3);
  const now2 = f2.g.s.at;
  f2.g.enterLimit(now2, true, "evident");
  assert(
    now2 - f2.g.s.limit!.record!.onset <= 5 * 60_000 + 30_000,
    `walkback too long: ${(now2 - f2.g.s.limit!.record!.onset) / 60_000} min`,
  );
});

Deno.test("outside a limit on KVM 8, 10% ceiling jitter is skipped by the deadband while full ceiling and 20% floor apply immediately", async () => {
  const f = fixture();
  let calls = 0;
  const origSet = f.g.io.cap;
  f.g.io.cap = async (percent, slice, periodMs) => {
    calls++;
    return await origSet(percent, slice, periodMs);
  };
  await f.g.tick();
  f.g.s.balance = p.capacity;
  // Outside 0.15 (busy 0.20, slice 0.05) -> ceiling 780%.
  await f.advance(30, 0.20 / 8, 0, 0.05);
  assertEquals(f.cap, 780);
  const afterInitial = calls;
  // Outside 0.22 (busy 0.25, slice 0.03) -> target 770% (delta 10% < 20% deadband): skipped.
  await f.advance(30, 0.25 / 8, 0, 0.03);
  assertEquals(f.cap, 780);
  assertEquals(calls, afterInitial);
  // Outside 0.05 (busy 0.10, slice 0.05) -> target 790% (delta 10% < 20% deadband): skipped.
  await f.advance(30, 0.10 / 8, 0, 0.05);
  assertEquals(f.cap, 780);
  assertEquals(calls, afterInitial);
  // Outside 0.40 (busy 0.45, slice 0.05) -> target 760% (delta 20%): applied immediately.
  await f.advance(30, 0.45 / 8, 0, 0.05);
  assertEquals(f.cap, 760);
  assertEquals(calls, afterInitial + 1);
  // As outside decays from 0.40 back toward 0.05, ceiling steps from 760% to 780% (delta 20%) and
  // holds 780% rather than flapping to 790%; once outside hits 0.00, full 800% applies immediately.
  for (let i = 0; i < 11; i++) await f.advance(30, 0.10 / 8, 0, 0.05);
  assertEquals(f.cap, 780);
  for (let i = 0; i < 11; i++) await f.advance(30, 0.0 / 8, 0, 0.0);
  assertEquals(f.cap, 800);
  // While actively throttling below full box capacity (allowed < vcpus), a 10% tightening applies
  // immediately (never biasing credit spend upward), while a 10% upward nudge is skipped.
  f.g.s.balance = 5_000;
  await f.advance(30, 0.0 / 8, 0, 0.0);
  const throttled = f.cap;
  assert(throttled < 800 && throttled > 100, `${throttled}`);
  // Raise outside by 0.12 cores -> target drops by 10%: applied immediately.
  await f.advance(30, 0.12 / 8, 0, 0.0);
  assertEquals(f.cap, throttled - 10);
});

Deno.test("failed probe cooldown starts after probe completes and decays back to 10m after 24h calm", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  f.g.probe = () => {
    f.elapse(45, 2.4 / 8, 0.8 / 8, 2.4);
    return Promise.resolve(false);
  };
  let beforeProbe = 0;
  for (let i = 0; i < 4 && f.g.s.probe.backoffMs === 10 * 60_000; i++) {
    beforeProbe = f.g.s.uptime! + 30_000;
    await f.advance(30, 2.4 / 8, 0.8 / 8, 2.4);
  }
  // Probe added 45s of uptime, so cooldownUntil is measured from post-probe uptime.
  assertEquals(f.g.s.probe.backoffMs, 20 * 60_000);
  assertEquals(f.g.s.probe.cooldownUntil, beforeProbe + 45_000 + 10 * 60_000);
  // 24 hours past cooldown with calm steal resets backoffMs to 10m.
  f.elapse(24 * 3600 + 700, 0.2 / 8, 0, 0.1);
  await f.g.tick();
  assertEquals(f.g.s.probe.backoffMs, 10 * 60_000);
  assertEquals(f.g.s.probe.failedSf, undefined);
});

Deno.test("apply charges neighbours' steal as it happens and gives the ceiling up for it; off, shadow and a limit do not", async () => {
  const hostinger = { vm_id: 1, token_file: "/etc/governor/hostinger-token" };
  const reference = {
    a: 1.03,
    b: 0.02,
    stealFit: { a: 1.01, b: 0.02, c: 0.5, hi: 0.6, sigma: [0.01, 0.01] as [number, number] },
    // The fit's own pairs saw 2% of the load stolen.
    stealAt: [0, 0.02] as [number, number],
    aHi: 1.04,
    sigma: [0.02, 0.01] as [number, number],
    pairs: 100,
    days: 5,
  };
  // One pass at 4 busy and 1 stolen core from a bank of 20,000: what was charged, in cores.
  const charged = async (mode: "off" | "shadow" | "apply", fit: typeof reference | null) => {
    const f = fixture({ hostinger, calibration: { mode } });
    await f.g.tick();
    if (fit) f.g.calibration.referenceFit = f.g.calibration.fit = fit;
    f.g.s.balance = 20_000;
    await f.advance(30, 4.0 / 8, 1.0 / 8, 0.2);
    const own = f.g.settings.mul * 4.0 + f.g.settings.add;
    const total = p.baseline - (f.g.s.balance - 20_000) / 30;
    // The slot records the same charge, which gap learning's own-count replay reads back.
    assertAlmostEquals(f.g.s.openSlot!.charged, total * 30, 1e-6, mode);
    return total - own;
  };
  // The steal model's bound, 0.6 a stolen core, on the steal beyond the 0.08 cores the fit
  // expects at four cores, which its line already carries.
  assertAlmostEquals(await charged("apply", reference), 0.6 * (1 - 0.02 * 4), 1e-9);
  // Until a contention window has bounded the meter's sensitivity, a stolen core beyond the
  // expected steal is charged whole, and without a fit every stolen core is.
  assertAlmostEquals(
    await charged("apply", { ...reference, stealFit: undefined } as never),
    1 - 0.02 * 4,
    1e-9,
  );
  assertAlmostEquals(await charged("apply", null), 1, 1e-9);
  // The charge reads the fit drift detection follows, the newest, not the one the margin kept.
  {
    const f = fixture({ hostinger, calibration: { mode: "apply" } });
    await f.g.tick();
    f.g.calibration.fit = { ...reference, stealFit: undefined } as never;
    f.g.calibration.referenceFit = { ...reference, stealFit: undefined, stealHi: 0.25 } as never;
    f.g.s.balance = 20_000;
    await f.advance(30, 4.0 / 8, 1.0 / 8, 0.2);
    const own = f.g.settings.mul * 4.0 + f.g.settings.add;
    assertAlmostEquals(p.baseline - (f.g.s.balance - 20_000) / 30 - own, 0.25 * 0.92, 1e-9);
  }
  // Off and shadow act on the legacy margin alone.
  assertAlmostEquals(await charged("off", reference), 0, 1e-9);
  assertAlmostEquals(await charged("shadow", reference), 0, 1e-9);
  // During a limit the steal is the cap's own.
  {
    const f = fixture({ hostinger, calibration: { mode: "apply" } });
    await f.g.tick();
    f.g.enterLimit(start, false);
    f.g.s.limit!.testAt = 1e15;
    f.g.s.balance = 1_000;
    await f.advance(30, 0.1 / 8, 1.0 / 8, 0.05);
    // Pressing on the limit earns nothing, and the pass pays for its own tenth of a core alone.
    const own = (f.g.settings.mul * 0.1 + f.g.settings.add) * 30;
    assertAlmostEquals(f.g.s.balance, 1_000 - own, 1e-6);
  }
  // What is charged for steal is not there to spend on the slice: at the floor, where the law
  // allows what the baseline pays for, the ceiling gives up a core's charge at once. Left to the
  // bank alone, the estimate fell a whole floor's reserve before the law took half a core back.
  const ceiling = async (steal: number) => {
    const f = fixture({ hostinger, calibration: { mode: "apply" } });
    await f.g.tick();
    f.g.s.probe.cooldownUntil = 1e15;
    for (let i = 0; i < 4; i++) {
      f.g.s.balance = f.g.law.floor * p.capacity;
      await f.advance(30, 4.0 / 8, steal / 8, 3.8);
    }
    return f.cap;
  };
  const calm = await ceiling(0), contended = await ceiling(1);
  assert(calm - contended >= 80 && calm - contended <= 110, `${calm}% and ${contended}%`);
});

// A confirmed credit limit whose last failed lift test is now, ready for the pass that finds the
// lift: `between` runs what happens from that test to the lift.
async function liftAfter(between: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(f.g.s.at + 30_000, true, "probe");
  const lim = f.g.s.limit!;
  lim.startedAt = -3_600_000;
  lim.record!.confirmed = true;
  lim.record!.caps = [{ at: f.g.s.at, busy: 2.4, demand: 4.0, ceiling: 800, pressing: true }];
  lim.testAt = 1e15;
  await f.advance(30, 0.2 / 8, 0, 0);
  lim.record!.limitedAt = f.g.s.at;
  lim.limitedUptime = f.g.s.uptime;
  await between(f);
  lim.testAt = 0;
  f.g.s.balance = 0;
  f.g.io.demand = () => Promise.resolve({ busy: 5 / 8, steal: 0, seconds: 25 });
  return { f, lim };
}
const drain = 1.05 * 8 + 0.08 - p.baseline;

Deno.test("a credit lift's lower bound counts spending on uptime, takes unwatched time at its worst, and stops at the end of the test", async () => {
  // Five minutes at every core, with the wall clock stepping back an hour as they begin. On wall
  // time the lift then came before the last failed test, and the bound was the full 20%.
  {
    const { f } = await liftAfter(async (f) => {
      await f.advance(30, 1, 0, 0, -3600);
      for (let i = 0; i < 9; i++) await f.advance(30, 1, 0, 0);
    });
    await f.advance(30, 1, 0, 0);
    const rec = f.g.history.limits.at(-1)!;
    assertEquals(rec.class, "credit");
    assertAlmostEquals(rec.liftBalance!, p.recovered - drain * 330, 1);
    assertAlmostEquals(f.g.s.balance, rec.liftBalance!, 1e-6);
  }
  // Ten minutes the daemon did not watch, averaging four cores: under the baseline as an average,
  // though they may have been five idle minutes and five at every core after the lift.
  {
    const { f } = await liftAfter((f) => f.advance(600, 4 / 8, 0, 0));
    assert(f.g.s.samples.at(-1)!.unobserved);
    await f.advance(30, 0.2 / 8, 0, 0);
    const rec = f.g.history.limits.at(-1)!;
    // Less the worst of those ten minutes, plus what the idle pass that found the lift earned.
    const earned = (p.baseline - (1.05 * 0.2 + 0.08)) * 30;
    assertAlmostEquals(rec.liftBalance!, p.recovered - drain * 600 + earned, 1);
  }
  // The record's lift is stamped when the passing test ends, 35 seconds of burners later: the
  // anchor there is lower by the most they could spend, while the live estimate, which the next
  // sample charges for the test, is not.
  {
    const { f } = await liftAfter(() => Promise.resolve());
    f.g.io.demand = () => {
      f.elapse(35, 5 / 8, 0, 0);
      return Promise.resolve({ busy: 5 / 8, steal: 0, seconds: 25 });
    };
    await f.advance(30, 0.2 / 8, 0, 0);
    const rec = f.g.history.limits.at(-1)!;
    assertEquals(rec.lift, f.g.s.at + 35_000);
    assertAlmostEquals(rec.liftBalance!, p.recovered - drain * 35, 1e-6);
    assertAlmostEquals(f.g.s.balance, p.recovered, 1e-6);
  }
  // Without a failed test this boot nothing says how long ago the lift may have been: no restore.
  {
    const { f, lim } = await liftAfter(() => Promise.resolve());
    lim.limitedUptime = undefined;
    await f.advance(30, 0.2 / 8, 0, 0);
    const rec = f.g.history.limits.at(-1)!;
    assertEquals(rec.class, "credit");
    assertEquals(rec.liftBalance, 0);
    assert(f.g.s.balance < 200, `${f.g.s.balance}`);
  }
});

Deno.test("a start that finds its limit lifted in history gives back what the lost pass restored", async () => {
  // persist.json was last saved during the limit; the pass that found the lift reached history
  // only. The limit ends at the start either way, but the bank that pass restored was lost.
  const apply = {
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" as const },
  };
  for (const liftBalance of [undefined, 900]) {
    const f = fixture(apply);
    await f.g.tick();
    f.g.enterLimit(f.g.s.at, true, "probe");
    f.g.s.balance = 0;
    const saved = JSON.parse(JSON.stringify(f.g.s));
    const history = structuredClone(f.g.history);
    const lifted = history.limits.at(-1)!;
    Object.assign(lifted, { confirmed: true, class: "credit", lift: f.g.s.at + 60_000 });
    if (liftBalance !== undefined) lifted.liftBalance = liftBalance;
    const g = new Governor(apply, p, saved, f.io);
    g.adoptHistory(history, lifted.lift! + 10_000);
    assertEquals(g.s.limit, undefined);
    const floor = g.law.floor * p.capacity;
    const settings = g.settings;
    const spent = (settings.mul * 8 + settings.add - p.baseline) * 10;
    assertAlmostEquals(g.s.balance, Math.min(floor, (liftBalance ?? p.recovered) - spent), 1e-6);
  }
  // A limit that was not a confirmed credit limit gives nothing back.
  const f = fixture(apply);
  await f.g.tick();
  f.g.enterLimit(f.g.s.at, true, "probe");
  f.g.s.balance = 0;
  const saved = JSON.parse(JSON.stringify(f.g.s));
  const history = structuredClone(f.g.history);
  Object.assign(history.limits.at(-1)!, { class: "unknown", lift: f.g.s.at + 60_000 });
  const g = new Governor(apply, p, saved, f.io);
  g.adoptHistory(history, f.g.s.at + 70_000);
  assertEquals([g.s.limit, g.s.balance], [undefined, 0]);
});

Deno.test("a recovery ceiling gives back what an outside spike cost once the spike has left the window", async () => {
  for (const vcpus of [4, 8]) {
    const small = plan(vcpus);
    const f = fixture({ vcpus });
    const g = new Governor({ vcpus }, small, undefined, f.io);
    await g.tick();
    g.enterLimit(start, false);
    g.s.limit!.testAt = 1e15;
    const pass = async (outside: number) => {
      f.elapse(30, outside / vcpus, 0, 0);
      await g.tick();
      g.s.limit!.testAt = 1e15;
    };
    for (let i = 0; i < 11; i++) await pass(0.1);
    const calm = g.s.limit!.ceiling;
    // A 0.2-core spike costs 10 or 20 points at once. Relaxing only by more than a 20-point
    // deadband, in a ceiling that moves in tens, never gave them back.
    await pass(0.3);
    const spiked = g.s.limit!.ceiling;
    assert(calm - spiked === 10 || calm - spiked === 20, `KVM ${vcpus}: ${calm} to ${spiked}`);
    for (let i = 0; i < 9; i++) await pass(0.1);
    assertEquals(g.s.limit!.ceiling, spiked, `KVM ${vcpus}: still in the window`);
    for (let i = 0; i < 2; i++) await pass(0.1);
    assertEquals(g.s.limit!.ceiling, calm, `KVM ${vcpus}`);
  }
});

Deno.test("status shows a failing evaluation in off and shadow, where nothing is held for it", async () => {
  for (const mode of ["off", "shadow", "apply"] as const) {
    const f = fixture({
      hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
      calibration: { mode },
    });
    await f.g.tick();
    f.g.s.balance = 20_000;
    f.g.s.evaluationFailed = { since: start, logged: start, behind: 1_000 };
    const failing = f.g.publicState(start).credits.calibration!.failing;
    assertEquals(failing, { since: start, behind: mode === "apply" ? 1_000 : 0 }, mode);
  }
});

Deno.test("a limit that begins during a probe cooldown in apply is still entered within minutes, and learns from the estimate before the cap's steal was charged", async () => {
  // The slice runs batch work at whatever its ceiling allows, with 0.2 cores outside it. Under the
  // cap the VM delivers 2.4 cores and the rest of what is asked is stolen.
  const scenario = async (failedSf: number, above: number) => {
    const f = fixture({
      hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
      calibration: { mode: "apply" },
    });
    let limited = false;
    const world = () => {
      const want = Math.min(8, f.cap / 100 + 0.2), busy = limited ? Math.min(want, p.limit) : want;
      return { want, busy, steal: want - busy };
    };
    f.g.io.steal = () => {
      const w = world();
      return Promise.resolve(w.want ? w.steal / w.want : 0);
    };
    const step = () => {
      const w = world();
      return f.advance(30, w.busy / 8, w.steal / 8, Math.max(0, w.busy - 0.2));
    };
    await f.g.tick();
    const reserve = f.g.law.floor * p.capacity + above;
    for (let i = 0; i < 12; i++) {
      f.g.s.balance = reserve;
      await step();
    }
    // Neighbours failed a probe a moment ago: an hour's cooldown, the longest there is.
    f.g.s.probe = { cooldownUntil: f.g.s.uptime! + 3_600_000, backoffMs: 3_600_000, failedSf };
    limited = true;
    // What the estimate reads at entry if the cap's own steal is never charged: the bank as it
    // stood, plus what each pass under the cap earns on its own count.
    let unchargedForSteal = f.g.s.balance, passes = 0, chargedForSteal = 0;
    while (!f.g.s.limit && passes < 130) {
      const own = f.g.settings.mul * world().busy + f.g.settings.add;
      await step();
      passes++;
      unchargedForSteal += (p.baseline - own) * 30;
      chargedForSteal += f.g.s.samples.at(-1)!.stealCharged ?? 0;
    }
    return { f, seconds: passes * 30, unchargedForSteal, chargedForSteal };
  };
  // The ceiling gives up what steal is charged, so demand shrinks toward the cap and the steal
  // share stops short of what bypasses a cooldown: these limits pressed on the cap for the whole
  // hour. Delivery pinned in the cap's band, where it was not when the probe failed, bypasses it.
  for (const [failedSf, above] of [[0.22, 60], [0.30, 4500], [0.35, 4500]]) {
    const { f, seconds, unchargedForSteal, chargedForSteal } = await scenario(failedSf, above);
    assert(f.g.s.limit && seconds <= 360, `failed probe at ${failedSf}: ${seconds} s`);
    // What the cap's own steal was charged before the limit was recognised comes back in the
    // estimate the limit learns from.
    const record = f.g.history.limits.at(-1)!;
    assert(chargedForSteal > 100, `${chargedForSteal}`);
    assertAlmostEquals(record.balance, unchargedForSteal, 1, `failed probe at ${failedSf}`);
  }
});

Deno.test("neighbours in the cap's band get one extra probe in a cooldown, and only when the slice asks for all its ceiling allows", async () => {
  const apply = {
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" as const },
  };
  const failing = (f: ReturnType<typeof fixture>) => {
    const seen = { probes: 0 };
    f.g.probe = () => {
      seen.probes++;
      return Promise.resolve(false);
    };
    return seen;
  };
  // A slice far below its ceiling shows all the steal there is: the charge hides none of it, so
  // moving into the band earns no test. Each one would cost the reading pair around it, which on
  // a contended host is a pair the steal model needs.
  {
    const f = fixture(apply);
    await f.g.tick();
    const seen = failing(f);
    for (let i = 0; i < 4; i++) {
      f.g.s.balance = p.capacity;
      await f.advance(30, 4.0 / 8, 1.0 / 8, 3.8);
    }
    assertEquals([seen.probes, f.g.s.probe.failedAtCap], [1, false]);
    // The rest of the ten-minute cooldown at 2.2 busy cores, a fifth of the demand stolen.
    for (let i = 0; i < 15; i++) {
      f.g.s.balance = p.capacity;
      await f.advance(30, 2.2 / 8, 0.55 / 8, 2.0);
    }
    assert(f.cap >= 700, `${f.cap}%`);
    assertEquals(seen.probes, 1);
  }
  // Batch work that runs at whatever its ceiling allows, with neighbours taking a share of it.
  const batch = async (mode: "apply" | "shadow", share: number) => {
    const f = fixture({ ...apply, calibration: { mode } });
    await f.g.tick();
    const seen = failing(f);
    const step = (balance: number) => {
      const want = Math.min(8, f.cap / 100 + 0.2), steal = share * want;
      f.g.s.balance = balance;
      return f.advance(30, (want - steal) / 8, steal / 8, want - steal - 0.2);
    };
    // A full bank: every core asked for, and delivery well above the band.
    for (let i = 0; i < 4; i++) await step(p.capacity);
    assertEquals([seen.probes, f.g.s.probe.failedAtCap], [1, false], mode);
    return { f, seen, step, reserve: f.g.law.floor * p.capacity + 60 };
  };
  // The bank at its reserve: the ceiling gives up what steal is charged, and delivery settles
  // into the band. That is what a new cap would look like, so it earns one test.
  const { f, seen, step, reserve } = await batch("apply", 0.35);
  let passes = 0;
  while (seen.probes < 2 && passes++ < 15) await step(reserve);
  assertEquals([seen.probes, f.g.s.probe.failedAtCap], [2, true]);
  // It failed with the VM in the band: sitting there says nothing new until the cooldown ends.
  const until = f.g.s.probe.cooldownUntil;
  while (f.g.s.uptime! + 30_000 < until) await step(reserve);
  assertEquals(seen.probes, 2);
  // Shadow charges no steal, so its ceiling gives none up and hides nothing: the same slice in
  // the band, half its demand stolen, waits out its cooldown as it always did.
  const shadow = await batch("shadow", 0.5);
  let inBand = 0;
  for (let i = 0; i < 15; i++) {
    await shadow.step(shadow.reserve);
    const busy = (1 - 0.5) * (shadow.f.cap / 100 + 0.2);
    if (busy >= 0.85 * p.limit && busy <= p.limit + 0.1) inBand++;
  }
  assert(inBand >= 10, `${inBand} passes in the band at ${shadow.f.cap}%`);
  assertEquals(shadow.seen.probes, 1);
});

Deno.test("the ceiling's cooldown cap and deadband use the margin with the steal charge in it", async () => {
  const apply = {
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" as const },
  };
  // After a sustained-use limit the slice stays at or under the baseline for the cooldown. What
  // steal is charged comes out of that too.
  const cooled = async (steal: number) => {
    const f = fixture(apply);
    await f.g.tick();
    f.g.s.probe.cooldownUntil = 1e15;
    f.g.calibration.cooldownUntil = f.g.s.at + 86_400_000;
    for (let i = 0; i < 4; i++) {
      f.g.s.balance = p.capacity;
      await f.advance(30, 4.0 / 8, steal / 8, 3.8);
    }
    return f.cap;
  };
  const calm = await cooled(0), contended = await cooled(1);
  assert(calm - contended >= 80, `${calm}% and ${contended}%`);
  // Just above a full allowance on the own count, just below it once 0.1 stolen cores are
  // charged: the ceiling is throttling, so a 10-point tightening is not jitter to skip.
  const f = fixture(apply);
  await f.g.tick();
  f.g.s.probe.cooldownUntil = 1e15;
  const balance = f.g.law.floor * p.capacity +
    (8.05 * f.g.settings.mul + f.g.settings.add - p.baseline) * 1800;
  const ceilings: number[] = [];
  for (let i = 0; i < 5; i++) {
    f.g.s.balance = balance;
    await f.advance(30, 4.0 / 8, 0.1 / 8, 3.8);
    ceilings.push(f.cap);
  }
  // Two samples carry no steal average yet; from the third the charge is in the ceiling.
  assertEquals(ceilings.slice(0, 2), [780, 780]);
  assertEquals(ceilings.at(-1), 770);
});

Deno.test("time no sample covers since the last failed lift test counts at the most the VM can spend", async () => {
  const { f } = await liftAfter(async (f) => {
    for (let i = 0; i < 10; i++) await f.advance(30, 0.2 / 8, 0, 0);
    // Five of those minutes are gone from the sample buffer, as after a restart that lost them.
    f.g.s.samples = f.g.s.samples.slice(0, -10);
  });
  await f.advance(30, 0.2 / 8, 0, 0);
  const rec = f.g.history.limits.at(-1)!;
  assertEquals(rec.class, "credit");
  // The idle pass that found the lift earns nothing back above the recovery level it starts
  // from; the uncovered five minutes come off at every core.
  assertAlmostEquals(rec.liftBalance!, p.recovered - drain * 300, 1);
});

Deno.test("a sustained-use restore in apply charges the steal the live estimate would have", () => {
  // The estimate a sustained-use limit hid comes back as the live estimate would stand now:
  // advanced from the lift at the settings in force, which in apply charge steal.
  const restored = (mode: "apply" | "shadow", steal: number) => {
    const f = fixture({
      hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
      calibration: { mode },
    });
    const entry = start, lift = start + 6 * 600_000, now = start + 12 * 600_000;
    const record = {
      onset: entry,
      entry,
      path: "evident" as const,
      // Low enough that two hours at two cores do not fill the bank, which would hide the charge.
      balance: 5_000,
      used: 0,
      settings: { mul: 1.05, add: 0.04, floor: 0.05 },
      gap: 0,
      mode,
      track: null,
      caps: [],
      confirmed: true,
      learn: true,
      class: "sustained-use" as const,
      lift,
    };
    f.g.history.limits = [record];
    const history = {
      ...f.g.history,
      slots: Array.from({ length: 12 }, (_, i) => ({
        at: start + i * 600_000,
        seconds: 600,
        busy: 2 * 600,
        steal: i >= 6 ? steal * 600 : 0,
        managed: 2 * 600,
        outside: 0,
        charged: (1.05 * 2 + 0.04) * 600,
        flags: i < 6 ? 1 : 0,
      })),
    };
    f.g.s.balance = 0;
    (f.g as unknown as { restoreSustained(r: unknown, h: unknown, now: number): void })
      .restoreSustained(record, history, now);
    return f.g.s.balance;
  };
  // An hour after the lift at one stolen core: without a fit, apply charges it whole.
  assertAlmostEquals(restored("apply", 0) - restored("apply", 1), 3600, 1e-6);
  // Shadow's live estimate charges no steal, so neither does its restore.
  assertEquals(restored("shadow", 1), restored("shadow", 0));
});
