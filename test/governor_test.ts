import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { compareReadings, detectPlan, Governor, validateConfig } from "../src/governor.ts";
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
    await within(shutdown);
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
