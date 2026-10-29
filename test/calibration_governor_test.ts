import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { flush } from "./async.ts";
import { InvalidReadingsError } from "../src/hostinger.ts";
import { Governor, openGovernor, readPersisted } from "../src/governor.ts";
import { explainCalibration, explainText } from "../src/explain.ts";
import { CALIBRATION, classifyLimit, marginFromFit } from "../src/calibration.ts";
import { MARGIN, recoveryCeiling, sliceCeiling, widen } from "../src/credits.ts";
import {
  DAY,
  decodeHistory,
  emptyHistory,
  encodeHistory,
  FLAGS,
  HistoryStore,
  type LimitRecord,
  planKey,
  readHistory,
  type Settings,
} from "../src/history.ts";
import { fixture, p, start } from "./governor-fixture.ts";
import { fit, record as limitRecord, slot } from "./calibration-fixture.ts";
import { testDirectory } from "./temp.ts";
import { study } from "./calibration-sim.ts";

// Apply needs a configured VM: its readings are what calibration tightens from.
const APPLY = {
  hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
  calibration: { mode: "apply" as const },
};

Deno.test("apply starts at configured settings while off and shadow retain legacy actuation", async () => {
  const fs = [
    fixture(),
    fixture({ calibration: { mode: "shadow" } }),
    fixture(APPLY),
  ];
  for (const f of fs) await f.g.tick();
  for (let i = 0; i < 130; i++) {
    for (const f of fs) await f.advance(30, 0.5);
    assertEquals(fs[0].cap, fs[1].cap);
    assertEquals(fs[0].g.s.balance, fs[1].g.s.balance);
  }
  assertEquals(fs[2].g.publicState(start).credits.law?.floor, 0.05);
  assertEquals(fs[2].g.settings.add, 0.04);
  assertEquals(fs[0].g.publicState(start).credits.law?.floor, 0.2);
  assert(fs[2].cap > fs[0].cap);
});

Deno.test("migration starts apply from start and keeps a previously widened margin", () => {
  const f = fixture();
  const saved = structuredClone(f.g.s);
  const g = new Governor(APPLY, p, saved, f.io);
  assertEquals(g.settings, CALIBRATION.start);
  saved.margin = { mul: 1.09, add: 0.12 };
  const widened = new Governor(APPLY, p, saved, f.io);
  assertEquals(widened.settings, { mul: 1.09, add: 0.12, floor: 0.05 });
});

Deno.test("calibration and history survive reboot while the estimate resets to zero", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  await f.advance();
  f.g.calibration.gap = 0.1;
  f.g.calibration.applied = { mul: 1.08, add: 0.15, floor: 0.08 };
  f.g.history.readings = [{ at: start - 1_800_000, v: 20 }];
  const history = decodeHistory(encodeHistory(f.g.history), f.g.history.planKey, 1);
  f.reboot();
  const restarted = new Governor(f.g.cfg, p, structuredClone(f.g.s), f.io);
  restarted.history = history;
  await restarted.tick();
  assertEquals(restarted.s.balance, 0);
  assertEquals(restarted.calibration.gap, 0.1);
  assertEquals(restarted.settings, f.g.settings);
  assertEquals(restarted.history.readings, history.readings);
});

Deno.test("operator reset is recorded and clears persistent mismatch and learned settings", async () => {
  const f = fixture({ ...APPLY, calibration: { mode: "apply" } });
  await f.g.tick();
  f.g.calibration.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
  f.g.calibration.gap = 0.1;
  f.g.calibration.rulesMismatch = true;
  f.g.s.margin = { mul: 1.09, add: 0.1 };
  // A latched mismatch from before the reset.
  f.g.history.calibrations.push({
    at: f.g.calibration.startedAt,
    trigger: "rules-mismatch",
    inputs: { onset: start, gap: 0.3, latched: true },
    digest: "0",
    from: { ...CALIBRATION.start },
    to: { mul: 1.1, add: 0.2, floor: 0.1 },
    mode: "apply",
  });
  assertEquals(f.g.calibrationStatus().mismatches.length, 1);
  f.elapse(1);
  await f.request("calibration-reset");
  assertEquals(f.g.calibration.applied, CALIBRATION.start);
  assertEquals(f.g.calibration.gap, 0);
  assertEquals(f.g.calibration.rulesMismatch, false);
  // Status lists none from before it.
  assertEquals(f.g.calibrationStatus().mismatches, []);
  assertEquals(f.g.history.calibrations.at(-1)?.trigger, "reset");
  // Off mode's legacy margin is not calibration state (§13).
  assertEquals(f.g.s.margin, { mul: 1.09, add: 0.1 });
});

Deno.test("a configured gap_start tightens the start margin before any fit", () => {
  const f = fixture({ ...APPLY, calibration: { mode: "apply", gap_start: 0.02 } });
  assertAlmostEquals(f.g.settings.add, 0.04 + 0.02 * 1.05, 1e-12);
  assertEquals(f.g.calibration.gap, 0.02);
});

Deno.test("corrupt history cannot prevent a tick and open slots survive save and explain", async () => {
  const dir = await testDirectory("calibration-explain-");
  const cfg = { ...APPLY, vcpus: 8 };
  try {
    await Deno.mkdir(`${dir}/run`);
    await Deno.mkdir(`${dir}/lib`);
    const f = fixture(cfg, { run: `${dir}/run`, lib: `${dir}/lib` });
    await Deno.writeTextFile(`${dir}/lib/history.json`, "broken");
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 22; i++) await f.advance(30, 0.3);
    await f.g.closeHistory();
    await f.g.save(start + 660_000);
    const saved = JSON.parse(await Deno.readTextFile(`${dir}/lib/persist.json`));
    assert(saved.openSlot.seconds > 0);
    const a = await explainCalibration(cfg, `${dir}/lib`);
    assertEquals(await explainCalibration(cfg, `${dir}/lib`), a);
    assertEquals(a.applied, f.g.calibrationStatus().applied);
    assertEquals(a.gap, f.g.calibrationStatus().gap);
    assertEquals(a.estimates, f.g.calibrationStatus().estimates);
    assertAlmostEquals(a.evidence.estimates.open, f.g.s.balance, 1e-6);
    assert((await Deno.stat(`${dir}/lib/history.json.bad-${start / 1000}`)).isFile);
    f.g.calibration.rulesMismatch = true;
    f.g.calibration.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
    await f.request("calibration-reset");
    await f.g.closeHistory();
    await f.g.save(start + 660_000);
    const reset = await explainCalibration(cfg, `${dir}/lib`);
    assertEquals(reset.applied, CALIBRATION.start);
    assertEquals(reset.estimates, f.g.calibration.estimates);
    assertEquals(reset.rulesMismatch, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sustained-use limit cannot widen or teach and holds the allowance below baseline", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.s.balance = p.capacity;
  f.g.enterLimit(start, true);
  const record = f.g.s.limit!.record!;
  record.caps = [6, 4, 2].map((busy, i) => ({
    at: start + i * 3_600_000,
    busy,
    demand: 8,
    ceiling: 600,
    pressing: true,
  }));
  record.confirmed = true;
  record.firstTest = "limited";
  f.g.limitGone = () => Promise.resolve(true);
  f.g.s.balance = p.recovered;
  const margin = { ...f.g.s.margin };
  await f.advance();
  assertEquals(record.class, "sustained-use");
  assertEquals(f.g.s.margin, margin);
  assertEquals(f.g.calibration.gap, 0);
  f.g.s.balance = p.capacity;
  await f.advance();
  assert(f.cap / 100 <= (p.baseline - margin.add) / margin.mul);
});

Deno.test("any lift test during the limit that fails with limited evidence confirms it", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, true);
  // An inconclusive first test neither confirms the limit nor rules it out, as before calibration.
  f.g.s.balance = p.recovered;
  f.g.io.demand = () => Promise.resolve({ busy: 3.5 / 8, steal: 0.2, seconds: 25 });
  await f.advance();
  assertEquals(f.g.s.limit!.record!.firstTest, "unknown");
  assertEquals(f.g.s.limit!.record!.confirmed, false);
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  await f.advance(150);
  assertEquals(f.g.s.limit!.record!.confirmed, true);
  assertEquals(f.g.s.limit!.record!.firstTest, "unknown");
  // A reboot after the confirmation loses the entry estimate, not the evidence.
  f.reboot();
  await f.g.tick();
  assertEquals(f.g.s.limit!.record!.learn, true);
});

Deno.test("burner delivery comes from the first lift test whose burners ran", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, true);
  f.g.s.balance = p.recovered;
  const burner = f.g.io.burner;
  f.g.io.burner = () => ({
    status: Promise.resolve({ code: 1, success: false, signal: null }),
    kill: () => {},
  });
  await f.advance();
  assertEquals(f.g.s.limit!.record!.firstTest, "unknown");
  assertEquals(f.g.s.limit!.record!.testDelivery, undefined);
  f.g.io.burner = burner;
  f.g.io.demand = () => Promise.resolve({ busy: 0.3, steal: 0.52, seconds: 25 });
  await f.advance(150);
  const record = f.g.s.limit!.record!;
  assertEquals(record.confirmed, true);
  assertAlmostEquals(record.testDelivery!.busy, 2.4, 1e-9);
});

Deno.test("optional 10 ms recovery period is set and restored at lift", async () => {
  const f = fixture({ recovery: { quota_period_ms: 10 } });
  const periods: (number | null | undefined)[] = [];
  f.g.io.cap = (_s, _n, period) => {
    periods.push(period);
    return Promise.resolve(true);
  };
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance();
  assert(periods.includes(10));
  f.g.limitGone = () => Promise.resolve(true);
  f.g.s.balance = p.recovered;
  await f.advance();
  assertEquals(periods.at(-1), null);
  // Between those changes the helper gets the quota alone.
  await f.advance();
  await f.advance(30, 0.5);
  assertEquals(periods.filter((v) => v !== undefined), [null, 10, null]);
});

Deno.test("a real meter jump that leaves every residual extreme costs a few limits, not a series", async () => {
  // 0.75 cores from day 7: drift detection never sees it, and capped own-count steps took 11 limits.
  const result = await study({ id: "meter-jump", days: 21, meterJump: 0.75 });
  // The jump study allows 3 limits for a 0.75-core jump (#13).
  assert(result.creditLimits <= 3, `${result.creditLimits}`);
  assert(result.classifications.every((c) => c === "credit"));
  // The full steps live in the temporary hold, so nothing learned keeps the jump: the margin is the
  // post-change fit's alone. The refit never fits readings marked invalid, so it cannot absorb the
  // jump twice either.
  assert(result.gap <= 0.05, `${result.gap}`);
  assertAlmostEquals(
    result.applied.add,
    marginFromFit(p, result.fit!, result.gap, CALIBRATION.start).add,
    1e-9,
  );
});

Deno.test("readings a real jump made invalid count again at its first limit", async () => {
  // Seed 6: the first limit's span reaches back a week, so the limit measures the rise from the
  // change on, and corroborates. Seed 4: three readings under 6 sigma end the invalid state before
  // any limit, and drift detection sees them.
  for (const seed of [6, 4]) {
    const r = await study({ id: "jump-0.5", days: 9, meterJump: 0.5, seed });
    assertEquals(r.creditLimits, seed === 6 ? 1 : 0, `seed ${seed}`);
    const corroborated = r.decisions.find((d) => d.trigger === "readings-corroborated");
    assertEquals(!!corroborated, seed === 6, `seed ${seed}`);
    assert(r.decisions.some((d) => d.trigger === "readings-resumed"), `seed ${seed}`);
    // The readings count again in that evaluation, so the holds they kept end with it.
    if (corroborated) {
      assert(r.decisions.some((d) => d.trigger === "readings-resumed" && d.at === corroborated.at));
    }
    // The rise a corroborating limit measured explains its optimism, so it raises no floor.
    if (corroborated) assertEquals(r.applied.floor, CALIBRATION.start.floor);
  }
  // A whole core: the rise the limits measure exceeds a core, so the readings are corroborated and
  // the pinned rules hold.
  const core = await study({ id: "jump-1", days: 9, meterJump: 1, seed: 1 });
  assert(core.creditLimits <= 2, `${core.creditLimits}`);
  assert(core.decisions.some((d) => d.trigger === "readings-corroborated"));
  assert(!core.decisions.some((d) => d.trigger === "rules-mismatch"));
  assertEquals(core.applied.floor, CALIBRATION.start.floor);
});

Deno.test("a feed reporting 8x the meter alerts and tightens nothing", async () => {
  // Long enough for a drift change to verify and refit, had the extreme residuals reached it.
  // The feed turns 8x on day 7; what was learned before it stays exactly as it was, at every
  // evaluation from then on, not only at the end.
  let first: number | null = null, atChange: Settings | null = null;
  const changed: Settings[] = [];
  const r = await study({
    id: "feed",
    days: 14,
    readingScale: 8,
    observe(g) {
      first ??= g.s.at;
      if (g.s.at < first + 7 * DAY) return;
      atChange ??= { ...g.calibration.applied };
      if (JSON.stringify(g.calibration.applied) !== JSON.stringify(atChange)) {
        changed.push({ ...g.calibration.applied });
      }
    },
  });
  assert(r.decisions.some((d) => d.trigger === "readings-invalid"));
  assertEquals(changed, []);
  assertEquals(r.applied, atChange);
});

Deno.test("eight-day billing-gap simulation learns 0.10 after one confirmed credit limit", async () => {
  const result = await study({ id: "credit-gap", days: 8, gap: 0.1 });
  assert(result.creditLimits <= 2);
  assert(result.gap >= 0.1 && result.gap < 0.13);
  assert(result.classifications.includes("credit"));
});

Deno.test("shadow and off have identical ceilings in the meter simulation", async () => {
  const off = await study({ id: "off", days: 4, mode: "off" });
  const shadow = await study({ id: "shadow", days: 4, mode: "shadow" });
  assertEquals(shadow.ceilingDigest, off.ceilingDigest);
});

Deno.test("mode changes retain an applied calibration and a latched rules mismatch", () => {
  const f = fixture(APPLY);
  f.g.calibration.gap = 0.1;
  f.g.calibration.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
  f.g.calibration.rulesMismatch = true;
  const off = new Governor({ calibration: { mode: "off" } }, p, structuredClone(f.g.s), f.io);
  const applied = new Governor(APPLY, p, structuredClone(off.s), f.io);
  assertEquals(applied.calibration.gap, 0.1);
  assertEquals(applied.calibration.rulesMismatch, true);
  assertEquals(applied.settings, f.g.settings);
});

Deno.test("explain recomputes a qualifying fit and anchored estimates identical to the daemon", async () => {
  const dir = await testDirectory("explain-fit-");
  const cfg = {
    vcpus: 8,
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" as const, fit: { min_pairs: 2, min_days: 1 } },
  };
  try {
    await Deno.mkdir(`${dir}/lib`);
    await Deno.mkdir(`${dir}/run`);
    const f = fixture(cfg, { lib: `${dir}/lib`, run: `${dir}/run` });
    await f.g.loadHistory(start);
    const from = start - 183_600_000;
    f.g.history.slots = Array.from({ length: 306 }, (_, i) => {
      const own = 3 + Math.floor(i / 3) % 3;
      return {
        at: from + i * 600_000,
        seconds: 600,
        busy: own * 600,
        steal: 0,
        managed: own * 600,
        outside: 0,
        charged: (1.05 * own + 0.04) * 600,
        flags: 0,
      };
    });
    f.g.history.limits = [{
      onset: from - 3_600_000,
      entry: from - 3_500_000,
      lift: from,
      class: "credit",
      path: "evident",
      balance: 0,
      used: 50000,
      settings: { ...CALIBRATION.start },
      gap: 0,
      mode: "apply",
      track: null,
      caps: [],
      confirmed: true,
      learn: false,
    }];
    const readings = Array.from(
      { length: 103 },
      (_, i) => ({ at: from + i * 1_800_000, v: (1.0463 * (3 + (i + 2) % 3) + 0.0193) / 8 * 100 }),
    );
    f.g.history.meterPairs = readings.slice(1).map((r, i) => ({
      at: r.at,
      from: readings[i].at,
      own: 3 + i % 3,
      seconds: 1800,
    }));
    f.g.io.readings = () => Promise.resolve(readings);
    await f.g.tick();
    await f.advance();
    await f.advance();
    await f.g.closeDiagnostics();
    await f.g.closeHistory();
    await f.g.save(start + 60_000);
    assert(f.g.calibration.fit !== null);
    assert(f.g.calibration.estimates.clamp !== null);
    // The evaluation explain replays was appended after the snapshot, not compacted into it.
    assert((await Deno.readTextFile(`${dir}/lib/history.log`)).includes('"checkpoint"'));
    const explained = await explainCalibration(cfg, `${dir}/lib`);
    assertEquals(explained.evidence.fit, f.g.calibration.fit);
    assertEquals(explained.evidence.estimates, f.g.calibration.estimates);
    const text = explainText(explained);
    assert(text.startsWith("Calibration apply: x"), text);
    assert(text.includes(`digest ${explained.evidence.digest}: replay verified`));
    const held = explainText({
      ...explained,
      hold: { since: start, reason: "stale" },
      rulesMismatch: true,
      lastLimit: {
        class: "credit",
        onset: start,
        lift: null,
        diagnosis: {
          gap: 0.0312,
          source: "readings",
          anchor: null,
          onset: start,
          eta: 0,
          explained: false,
          left: 0,
        },
      },
    });
    assert(
      held.includes(`; holding the stale readings fallback since ${new Date(start).toISOString()}`),
    );
    assert(held.startsWith(`Calibration apply: x${explained.applied.mul}`));
    // Holds that raise the settings show, as JSON shows them, and so do the readings' state, any
    // cooldown and the long intervals.
    const pending = {
      at: start,
      from: { ...CALIBRATION.start },
      gapFrom: 0,
      oldFit: fit,
      fit,
      hold: { mul: 1.06, add: 0.1, floor: 0.05 },
      readings: 3,
      z: 4,
      verified: false,
      residual: 0,
      n: 0,
    };
    const more = explainText({
      ...explained,
      ownHold: { gap: 0.3, settings: { mul: 1.05, add: 0.36, floor: 0.05 } },
      cusum: { ...explained.cusum, pending },
      readingsInvalid: true,
      apiStaleSince: start,
      cooldownUntil: start + 10_800_000,
      longIntervals: { count: 2, whole: 0.01, lastHalfHour: 0.2, zWhole: 0.3, zLastHalfHour: 4 },
    });
    assert(more.includes("holding the own-count hold for a 0.3-core gap, a pending drift change"));
    assert(more.includes(`Readings invalid since ${new Date(start).toISOString()}`));
    assert(
      more.includes(`Sustained-use cooldown until ${new Date(start + 10_800_000).toISOString()}`),
    );
    assert(more.includes("Long reading intervals 2: mean residual 0.01 cores (0.3 sigma)"));
    // So do the start, drift detection, each logged mismatch and the last limit's lift.
    const rest = explainText({
      ...explained,
      mismatches: [
        { at: start, onset: start - 3_600_000, kind: "lift", value: 2.5, latched: false },
        { at: start + 1, onset: start - 1_800_000, kind: "gap", value: 0.3, latched: true },
      ],
      lastLimit: { class: "credit", onset: start, lift: start + 3_600_000, diagnosis: null },
    });
    assert(rest.includes(`; start x${CALIBRATION.start.mul} +${CALIBRATION.start.add} cores`));
    assert(rest.includes("Drift CUSUM "));
    assert(rest.includes("recovery took 2.5x the prediction"));
    assert(rest.includes("gap 0.3 cores, latched"));
    assert(rest.includes(`lifted ${new Date(start + 3_600_000).toISOString()}`));
    assert(held.includes("rules mismatch latched until reset"));
    assert(held.includes("diagnosed 0.0312 cores from readings"));
    assert(
      explainText({ ...explained, fit: null, lastLimit: null }).includes("Meter not qualified"),
    );
    assertEquals(await explainCalibration(cfg, `${dir}/lib`), explained);
    const persisted = JSON.parse(await Deno.readTextFile(`${dir}/lib/persist.json`));
    persisted.calibration.applied.mul = 1.3;
    persisted.calibration.fit.a = 1.25;
    await Deno.writeTextFile(`${dir}/lib/persist.json`, JSON.stringify(persisted));
    assertEquals((await explainCalibration(cfg, `${dir}/lib`)).applied, explained.applied);
    assertEquals(
      (await explainCalibration({ ...cfg, calibration: { mode: "off" } }, `${dir}/lib`)).mode,
      "apply",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the meter simulator sets and restores the optional recovery quota period", async () => {
  const result = await study({ id: "quota-period", days: 8, gap: 0.1, recoveryPeriod: 10 });
  assert(result.quotaPeriodUsed);
  assert(result.quotaPeriodRestored);
});

Deno.test("a limit whose first test passed is classified unknown once, with an alert", async () => {
  const f = fixture({ hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" } });
  const events: string[] = [];
  f.g.io.hooks = (event) => {
    events.push(event);
    return Promise.resolve();
  };
  await f.g.tick();
  f.g.enterLimit(start, true);
  f.g.limitGone = () => Promise.resolve(true);
  f.g.s.balance = p.recovered;
  await f.advance();
  for (let i = 0; i < 40; i++) await f.advance(30, 0.2);
  assertEquals(f.g.history.limits.at(-1)?.class, "unknown");
  assertEquals(events.filter((e) => e === "limit-classified").length, 1);
  assertEquals(
    f.g.history.calibrations.filter((d) => d.trigger === "limit-classified").length,
    1,
  );
  assertEquals(f.g.calibrationStatus().lastLimit?.class, "unknown");
  await f.g.closeDiagnostics();
});

Deno.test("invalid API readings alert once in every mode", async () => {
  for (const mode of ["off", "shadow", "apply"] as const) {
    const f = fixture({ ...APPLY, calibration: { mode } });
    const events: string[] = [];
    f.g.io.hooks = (event) => {
      events.push(event);
      return Promise.resolve();
    };
    f.g.io.readings = () =>
      Promise.reject(new InvalidReadingsError("unrecognized CPU metric unit"));
    await f.g.tick();
    for (let i = 0; i < 6; i++) {
      await f.advance();
      await flush();
    }
    assertEquals(events.filter((e) => e === "readings-invalid").length, 1, mode);
    assert(f.g.calibration.metricInvalid);
    assert(f.g.calibrationStatus().readingsInvalid);
    await f.g.closeDiagnostics();
  }
});

Deno.test("a fetch without readings leaves an invalid metric invalid", async () => {
  const f = fixture(APPLY);
  let fail = true, fetches = 0;
  f.g.io.readings = () => {
    fetches++;
    return fail
      ? Promise.reject(new InvalidReadingsError("unrecognized CPU metric unit"))
      : Promise.resolve([]);
  };
  await f.g.tick();
  for (let i = 0; i < 4; i++) {
    await f.advance();
    await flush();
  }
  assert(f.g.calibration.metricInvalid);
  fail = false;
  const before = fetches;
  for (let i = 0; i < 20; i++) {
    await f.advance();
    await flush();
  }
  assert(fetches > before);
  assert(f.g.calibration.metricInvalid);
  await f.g.closeDiagnostics();
});

Deno.test("only the newest diagnosis keeps its recorded inputs", async () => {
  const f = fixture({ hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" } });
  await f.g.tick();
  const limit = (onset: number): LimitRecord => ({
    onset,
    entry: onset,
    lift: onset + 3_600_000,
    path: "evident",
    balance: 0,
    used: 0,
    settings: { ...CALIBRATION.start },
    gap: 0,
    mode: "off",
    track: null,
    caps: [],
    confirmed: true,
    learn: true,
    class: "credit",
  });
  const old = {
    ...limit(start - 5 * 86_400_000),
    diagnosisEvidence: {
      config: CALIBRATION,
      upper: 0.167,
      fit: null,
      anchor: null,
      readings: [],
      slots: [],
    },
  };
  const recent = limit(start - 86_400_000);
  f.g.history.limits = [old, recent];
  f.g.calibration.pendingLimits = [recent.onset];
  for (let i = 0; i < 21; i++) await f.advance();
  assertEquals(f.g.history.limits[0].diagnosisEvidence, undefined);
  assert(f.g.history.limits[1].diagnosisEvidence);
  assert(f.g.history.limits[1].diagnosis);
  await f.g.closeDiagnostics();
});

Deno.test("malformed persisted calibration restarts from the configured start", () => {
  const f = fixture(APPLY);
  const saved = structuredClone(f.g.s);
  saved.calibration!.applied = { mul: Number.NaN, add: 0.2, floor: 0.1 };
  const g = new Governor(APPLY, p, saved, f.io);
  assertEquals(g.settings, CALIBRATION.start);
});

Deno.test("a helper that rejects the quota period still receives the quota", async () => {
  const f = fixture({ recovery: { quota_period_ms: 10 } });
  const calls: { cap: number; period: number | null | undefined }[] = [];
  f.g.io.cap = (_s, cap, period) => {
    calls.push({ cap, period });
    return Promise.resolve(period === undefined);
  };
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance();
  assertEquals(f.g.s.capFailed, false);
  assertEquals(calls.at(-2)?.period, 10);
  assertEquals(calls.at(-1), { cap: f.g.s.ceiling!, period: undefined });
  // The rejected period is not retried on every pass, only after 15 minutes, so a transient
  // failure cannot leave the period stuck.
  f.g.limitGone = () => Promise.resolve(false);
  for (let i = 0; i < 5; i++) await f.advance(30, 0.2);
  assertEquals(calls.filter((c) => c.period === 10).length, 1);
  for (let i = 0; i < 30; i++) await f.advance(30, 0.2);
  assertEquals(calls.filter((c) => c.period === 10).length, 2);
});

Deno.test("a helper without the period argument isn't asked to restore a default it never changed", async () => {
  const f = fixture();
  const calls: (number | null | undefined)[] = [];
  f.g.io.cap = (_s, _cap, period) => {
    calls.push(period);
    return Promise.resolve(period === undefined);
  };
  // A 10 ms period recorded before the option was turned off.
  f.g.s.quotaPeriod = 10;
  await f.g.tick();
  for (let i = 0; i < 40; i++) await f.advance(30, 0.2);
  assertEquals(calls.filter((p) => p === null).length, 1);
  assertEquals(f.g.s.quotaPeriod, undefined);
});

Deno.test("a restart during a limit sends the 10 ms period again after the service fallback reset it", async () => {
  const f = fixture({ recovery: { quota_period_ms: 10 } });
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance();
  assertEquals(f.g.s.quotaPeriod, 10);
  // The same boot: the saved state carries on, but ExecStopPost and ExecStartPre reset the period.
  const g = new Governor(f.g.cfg, p, structuredClone(f.g.s), f.io);
  const periods: (number | null | undefined)[] = [];
  g.io.cap = (_s, _n, period) => {
    periods.push(period);
    return Promise.resolve(true);
  };
  f.elapse();
  await g.tick();
  f.elapse();
  await g.tick();
  assertEquals(periods.filter((v) => v !== undefined), [10]);
});

Deno.test("a quota period left from before the option was turned off is restored at startup", async () => {
  const f = fixture();
  const saved = structuredClone(f.g.s);
  saved.quotaPeriod = 10;
  const g = new Governor({}, p, saved, f.io);
  const periods: (number | null | undefined)[] = [];
  g.io.cap = (_s, _n, period) => {
    periods.push(period);
    return Promise.resolve(true);
  };
  await g.tick();
  assertEquals(periods, [null]);
  assertEquals(g.s.quotaPeriod, undefined);
});

// A sustained-use limit with a confirmed first test, lifted on the next pass.
function sustainedLift(f: ReturnType<typeof fixture>, busy = [6, 4, 2]) {
  f.g.s.balance = p.capacity;
  f.g.enterLimit(start, true);
  const record = f.g.s.limit!.record!;
  record.caps = busy.map((b, i) => ({
    at: start + i * 3_600_000,
    busy: b,
    demand: 8,
    ceiling: 600,
    pressing: true,
  }));
  record.confirmed = true;
  record.firstTest = "limited";
  f.g.limitGone = () => Promise.resolve(true);
  f.g.s.balance = p.recovered;
  return record;
}

Deno.test("a sustained-use limit's estimate comes back, whether or not the evaluation succeeds", async () => {
  for (const failing of [false, true]) {
    const f = fixture();
    await f.g.tick();
    await f.advance(30, 0.1);
    const record = sustainedLift(f);
    // A fault only the readings math meets: classification and the restore need the records alone.
    if (failing) (f.g.calibration as { invalidSpans: unknown }).invalidSpans = [null];
    await f.advance(30, 0.1);
    assertEquals([record.class, record.restored], ["sustained-use", true], `${failing}`);
    assertEquals(f.g.s.balance, p.capacity);
    assertEquals(!!f.g.s.evaluationFailed, failing);
  }
});

Deno.test("explain shows the fallback a failing evaluation holds, as status does", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    await f.advance(600, 0.3);
    f.g.calibration.estimates = { ...f.g.calibration.estimates, acted: f.g.s.balance - 500 };
    (f.g.calibration as { invalidSpans: unknown }).invalidSpans = [null];
    await f.advance(600, 0.3);
    await f.g.save(start + 1_230_000);
    await f.g.closeHistory();
    const explained = await explainCalibration({ ...APPLY, vcpus: 8 }, paths.lib);
    const status = f.g.calibrationStatus();
    assert(status.failing !== null);
    assertEquals(explained.failing, status.failing);
    assertEquals([explained.applied, explained.estimates.acted], [
      status.applied,
      status.estimates.acted,
    ]);
    assertEquals(explained.applied.add, MARGIN.add);
    assert(explainText(explained).includes("Calibration failing since"));
  });
});

Deno.test("hooks see the quota the pass applied, and credit limits do not alert", async () => {
  for (const [busy, alerts] of [[[6, 4, 2], true], [[2.4, 2.4], false]] as const) {
    const f = fixture();
    const seen: { event: string; ceiling: number; applied: number }[] = [];
    f.g.io.hooks = (event, state) => {
      seen.push({ event, ceiling: state.ceiling, applied: f.cap });
      return Promise.resolve();
    };
    await f.g.tick();
    sustainedLift(f, [...busy]);
    await f.advance();
    assertEquals(seen.map((e) => e.event).includes("limit-classified"), alerts);
    assert(seen.some((e) => e.event === "limit-end"));
    for (const e of seen) assertEquals(e.ceiling, e.applied);
  }
});

Deno.test("public state shows the limit without its evidence record", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, true);
  const limit = f.g.publicState(start).limit!;
  assertEquals("record" in limit, false);
  assert(f.g.s.limit!.record);
});

Deno.test("a seed or limit request is evaluated on the next pass, so explain agrees", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance();
  await f.request("seed");
  await f.advance();
  assertEquals(f.g.history.checkpoint?.at, f.g.s.at);
  assertEquals(f.g.calibration.estimates.open, f.g.s.balance);
  // Two seconds later the pass reuses its measurements, but still evaluates the request before it
  // sets the ceiling, which in apply would otherwise act on the unclamped estimate. It evaluates at
  // the last full pass, which the open slot reaches.
  await f.request("seed");
  const at = f.g.s.at!;
  await f.advance(2);
  assertEquals(f.g.history.checkpoint?.at, at);
});

Deno.test("a lift reaches history before persist.json forgets the limit", async () => {
  const dir = await testDirectory("lift-durable-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    await f.advance();
    sustainedLift(f, [2.4, 2.4]);
    await f.advance();
    assertEquals(f.g.s.limit, undefined);
    await f.g.save(start + 60_000);
    const { history } = await readHistory(`${paths.lib}/history.json`, f.g.history.planKey, null);
    assert(history.limits.at(-1)?.lift !== undefined);
    assertEquals(history.limits.at(-1)?.class, "credit");
    assert(history.calibrations.some((d) => d.trigger === "limit-classified"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a reboot inside a slot comes back to it, marked, not as a clock step", async () => {
  const dir = await testDirectory("reboot-slot-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 4; i++) await f.advance(30, 0.3);
    const at = f.g.s.openSlot!.at;
    f.reboot(60_000);
    await f.g.tick();
    // persist.json keeps the open slot, marked.
    await f.g.save(f.g.s.at!);
    const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    assert(saved.openSlot!.at === at && saved.openSlot!.flags & FLAGS.reboot);
    for (let i = 0; i < 20; i++) await f.advance(30, 0.3);
    await f.g.save(f.g.s.at!);
    const { history } = await readHistory(`${paths.lib}/history.json`, f.g.history.planKey, null);
    const back = history.slots.filter((s) => s.at === at);
    // One slot, both sides of the reboot in it. Closed at the reboot, the slot back started at the
    // same time, which marked the first clock-invalid and dropped the second.
    assertEquals(back.length, 1);
    assert(back[0].flags & FLAGS.reboot && !(back[0].flags & FLAGS.clockInvalid));
    assert(back[0].seconds > 300);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a lost persist.json brings a drift hold back and restarts its verification", async () => {
  const dir = await testDirectory("calibration-pending-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const h = emptyHistory(planKey(p), 1, start);
    const hold = { mul: 1.074, add: 0.05, floor: 0.05 };
    const pending = {
      at: start - 3_600_000,
      from: { ...CALIBRATION.start },
      gapFrom: 0,
      oldFit: fit,
      fit: { ...fit, a: 1.074, aHi: 1.074 },
      hold,
      readings: 10,
      z: 8,
      verified: false,
      residual: 0,
      n: 0,
    };
    h.calibrations = [{
      at: start - 1000,
      trigger: "cusum-alarm",
      inputs: {},
      digest: "0",
      from: { ...CALIBRATION.start },
      to: hold,
      mode: "apply",
      learned: { ...CALIBRATION.start },
      gap: 0,
      rulesMismatch: false,
      pending,
      // An earlier change's refits still stop at its change point.
      fitSince: start - 5 * DAY,
      fitFrom: { mul: 1.051, add: 0.04, floor: 0.05 },
    }];
    const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
    store.write(h, start);
    await store.close();
    const f = fixture(APPLY, paths);
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(start);
    // The alarm never touched the learned settings; its hold comes back, and §8 can still
    // withdraw it.
    assertEquals(g.calibration.applied, CALIBRATION.start);
    assertEquals(g.calibration.pending, { ...pending, readings: 0, z: 0 });
    assertEquals(g.calibration.fit, fit);
    assertEquals(g.settings, hold);
    assertEquals(g.calibration.fitSince, start - 5 * DAY);
    assertEquals(g.calibration.fitFrom, { mul: 1.051, add: 0.04, floor: 0.05 });
    await g.closeHistory();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("explain matches the daemon right after a reset that keeps operational state", async () => {
  const dir = await testDirectory("calibration-reset-");
  const cfg = { ...APPLY, vcpus: 8 };
  try {
    await Deno.mkdir(`${dir}/run`);
    await Deno.mkdir(`${dir}/lib`);
    const f = fixture(cfg, { run: `${dir}/run`, lib: `${dir}/lib` });
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 22; i++) await f.advance(30, 0.3);
    const s = f.g.calibration;
    s.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
    s.gap = 0.1;
    s.rulesMismatch = true;
    s.cooldownUntil = start + 10_800_000;
    s.invalidSpans = [{ from: start - 7_200_000, to: start - 3_600_000 }];
    s.fitAt = start;
    s.fitSince = start - DAY;
    s.fitFrom = { ...CALIBRATION.start };
    const stale = { since: start, reason: "stale" as const };
    s.hold = stale;
    await f.request("calibration-reset");
    // A reset returns learned state to the start and keeps what readings and limits do now.
    const reset = f.g.calibration;
    assertEquals(reset.applied, CALIBRATION.start);
    assertEquals(reset.gap, 0);
    assertEquals(reset.rulesMismatch, false);
    assertEquals(reset.cooldownUntil, start + 10_800_000);
    assertEquals(reset.hold, stale);
    assertEquals(reset.invalidSpans, [{ from: start - 7_200_000, to: start - 3_600_000 }]);
    await f.g.closeHistory();
    await f.g.save(start + 700_000);
    // No evaluation ran since the reset: explain replays the reset checkpoint itself.
    const explained = await explainCalibration(cfg, `${dir}/lib`);
    assertEquals(explained.invalidSpans, reset.invalidSpans);
    assertEquals(explained.hold, stale);
    assertEquals(explained.cooldownUntil, start + 10_800_000);
    // Evaluations after the reset verify too: the state on disk lacks the fit times the reset
    // dropped, and so does the digest.
    for (let i = 0; i < 22; i++) await f.advance(30, 0.3);
    assert(f.g.history.checkpoint!.at > start + 660_000);
    await f.g.closeHistory();
    await f.g.save(f.g.s.at!);
    assert((await explainCalibration(cfg, `${dir}/lib`)).evidence.verified);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a reboot right after a slot closes still marks the next slot for the clamp", async () => {
  const f = fixture();
  await f.g.tick();
  // Run to an exact slot boundary, where the open slot has just closed.
  while (f.g.s.openSlot) await f.advance(30, 0.2);
  f.reboot();
  await f.g.tick();
  for (let i = 0; i < 25; i++) await f.advance(30, 0.2);
  const marked = f.g.history.slots.filter((x) => x.flags & FLAGS.reboot);
  assertEquals(marked.length, 1);
  assert(f.g.s.rebootPending === undefined);
});

Deno.test("an entry over the same run of steal does not reuse the previous record's onset", async () => {
  const f = fixture();
  await f.g.tick();
  for (let i = 0; i < 4; i++) await f.advance(30, 0.3, 0.3);
  f.g.enterLimit(start + 120_000, true, "evident");
  // During the limit, `limit on` keeps the record detection opened, so it still gets its lift.
  await f.request("limit-on");
  assertEquals(f.g.history.limits.length, 1);
  assertEquals(f.g.s.limit?.record, f.g.history.limits[0]);
  await f.request("limit-off");
  await f.request("limit-on");
  const onsets = f.g.history.limits.map((l) => l.onset);
  assertEquals(onsets.length, 2);
  assertEquals(new Set(onsets).size, 2);
  assert(onsets[1] > f.g.history.limits[0].lift!);
});

Deno.test("a limit carried over from v0.2.5 is classified at its lift before it can widen", async () => {
  const carried = async (config = {}) => {
    const f = fixture();
    await f.g.tick();
    const saved = structuredClone(f.g.s);
    saved.limit = {
      since: start,
      ceiling: 100,
      heldFrom: 0,
      startedAt: 0,
      entry: { balance: 5000, used: 50000, learn: true },
    };
    return { f, saved, g: new Governor(config, p, structuredClone(saved), f.io) };
  };
  for (const [busy, widens] of [[[2.4, 2.4], true], [[6, 4, 2], false]] as const) {
    const { f, saved, g } = await carried();
    const record = g.s.limit!.record!;
    assert(g.history.limits.includes(record));
    // The burners found the limit still in force: v0.2.5 widened here, now nothing is learned yet.
    g.limitGone = () => {
      Object.assign(g, { liftEvidence: "limited" });
      return Promise.resolve(false);
    };
    g.s.balance = p.recovered;
    await g.tick();
    f.elapse(30, 0.2);
    await g.tick();
    assertEquals(g.s.margin, saved.margin);
    assert(record.confirmed);
    // At the lift, the caps it pressed on since decide: a credit limit widens, a sustained-use one
    // doesn't.
    record.caps = busy.map((b, i) => ({
      at: start + i * 3_600_000,
      busy: b,
      demand: 8,
      ceiling: 600,
      pressing: true,
    }));
    g.limitGone = () => Promise.resolve(true);
    for (let i = 0; i < 20 && g.s.limit; i++) {
      g.s.balance = p.recovered;
      f.elapse(30, 0.2);
      await g.tick();
    }
    assertEquals(record.class, widens ? "credit" : "sustained-use");
    assertEquals(g.s.margin.add > saved.margin.add, widens, JSON.stringify(g.s.margin));
  }
  // Apply never widens, not even off's margin.
  const { f, saved, g: applying } = await carried(APPLY);
  applying.limitGone = () => {
    Object.assign(applying, { liftEvidence: "limited" });
    return Promise.resolve(false);
  };
  applying.s.balance = p.recovered;
  await applying.tick();
  f.elapse(30, 0.2);
  await applying.tick();
  assertEquals(applying.s.margin, saved.margin);
});

Deno.test("lost calibration state recovers learned settings from recorded decisions", async () => {
  const dir = await testDirectory("calibration-recover-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const h = emptyHistory(planKey(p), 1, start);
    const learned = { mul: 1.08, add: 0.1, floor: 0.07 };
    h.calibrations = [{
      at: start - 1000,
      trigger: "limit-diagnosis",
      inputs: {},
      digest: "0",
      from: { ...CALIBRATION.start },
      to: learned,
      mode: "apply",
      learned,
      gap: 0.05,
      rulesMismatch: true,
    }];
    const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
    store.write(h, start);
    await store.close();
    const f = fixture(APPLY, paths);
    const saved = structuredClone(f.g.s);
    saved.calibration!.applied = { mul: Number.NaN, add: 0, floor: 0 };
    const g = new Governor(APPLY, p, saved, f.io, paths);
    await g.loadHistory(start);
    assertEquals(g.calibration.applied, learned);
    assertEquals(g.calibration.gap, 0.05);
    assertEquals(g.calibration.rulesMismatch, true);
    await g.closeHistory();
    // Without persist.json at all, history still holds the learned settings. The bank restarts at
    // 0 as after a reboot; initial_balance applies only to a first start.
    const lost = { ...APPLY, initial_balance: 20000 };
    const fresh = new Governor(lost, p, undefined, f.io, paths);
    await fresh.loadHistory(start);
    assertEquals(fresh.calibration.applied, learned);
    assertEquals(fresh.calibration.gap, 0.05);
    assertEquals(fresh.calibration.rulesMismatch, true);
    assertEquals(fresh.s.balance, 0);
    assertEquals(fresh.s.rebuilding?.reason, "first-start");
    await fresh.closeHistory();
    const first = { run: `${dir}/first-run`, lib: `${dir}/first-lib` };
    await Deno.mkdir(first.run);
    await Deno.mkdir(first.lib);
    const install = new Governor(lost, p, undefined, f.io, first);
    await install.loadHistory(start);
    assertEquals(install.s.balance, 20000);
    await install.closeHistory();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("without a VM to read, a day without readings holds nothing", async () => {
  const f = fixture();
  await f.g.tick();
  for (let i = 0; i < 26; i++) await f.advance(3600, 0.2);
  assertEquals(f.g.calibration.hold, null);
  assert(!f.g.history.calibrations.some((d) => d.trigger === "stale-fallback"));
});

Deno.test("slots that kernel uptime makes slightly longer than 600 seconds read back", async () => {
  const dir = await testDirectory("history-uptime-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // Uptime advances 30.01 seconds for every 30 on the wall clock.
    for (let i = 0; i < 45; i++) await f.advance(30.01, 0.3, 0, 2.4, 30);
    await f.g.closeHistory();
    assert(f.g.history.slots.some((s) => s.seconds > 600));
    const { history, clean } = await readHistory(
      `${paths.lib}/history.json`,
      f.g.history.planKey,
      null,
    );
    assert(clean);
    assertEquals(history.slots, f.g.history.slots);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the first switch to apply resets learned state and keeps what the readings are doing", () => {
  const f = fixture({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "shadow" },
  });
  const s = f.g.calibration;
  // Shadow would have learned these; the readings it marked invalid and the cooldown are facts.
  s.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
  s.gap = 0.1;
  s.rulesMismatch = true;
  s.fit = fit;
  s.invalidSpans = [{ from: start - 7_200_000, to: start - 3_600_000 }];
  s.cooldownUntil = start + 10_800_000;
  s.settledSeenAt = start - 3 * 3_600_000;
  s.hold = { since: start - 3_600_000, reason: "stale" };
  f.g.s.balance = 20000;
  const g = new Governor(APPLY, p, structuredClone(f.g.s), f.io);
  const c = g.calibration;
  assertEquals(c.applied, CALIBRATION.start);
  assertEquals([c.gap, c.rulesMismatch, c.fit], [0, false, null]);
  assertEquals(c.invalidSpans, s.invalidSpans);
  assertEquals(c.cooldownUntil, s.cooldownUntil);
  assertEquals(c.settledSeenAt, s.settledSeenAt);
  assertEquals(c.hold, s.hold);
  // The first apply pass acts on the open estimate until it evaluates.
  assertEquals(c.estimates.acted, 20000);
  assertEquals(g.actedBalance, 20000);
});

Deno.test("recovery honors a reset made in shadow and works in shadow once apply has run", async () => {
  const dir = await testDirectory("calibration-recover-modes-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const learned = { mul: 1.08, add: 0.1, floor: 0.07 };
    const decision = (mode: "apply" | "shadow", trigger: "fit" | "reset", at: number) => ({
      at,
      trigger,
      inputs: {},
      digest: "0",
      from: { ...CALIBRATION.start },
      to: trigger === "reset" ? { ...CALIBRATION.start } : learned,
      mode,
      learned: trigger === "reset" ? { ...CALIBRATION.start } : learned,
      gap: trigger === "reset" ? 0 : 0.05,
      rulesMismatch: false,
      activated: true as const,
    });
    const write = async (h: ReturnType<typeof emptyHistory>) => {
      const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
      store.write(h, start);
      await store.close();
    };
    const shadow = {
      hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
      calibration: { mode: "shadow" as const },
    };
    const f = fixture(APPLY, paths);
    // Learned in apply, then reset after a switch to shadow: the reset wins.
    const h = emptyHistory(planKey(p), 1, start);
    h.calibrations = [
      decision("apply", "fit", start - 2000),
      decision("shadow", "reset", start - 1000),
    ];
    await write(h);
    const reset = new Governor(APPLY, p, undefined, f.io, paths);
    await reset.loadHistory(start);
    assertEquals(reset.calibration.applied, CALIBRATION.start);
    await reset.closeHistory();
    // Learned, then persist.json lost while in shadow: shadow recovers it, and a later switch back
    // to apply keeps it instead of starting over.
    h.calibrations = [
      decision("apply", "fit", start - 2000),
      decision("shadow", "fit", start - 1000),
    ];
    h.calibrations[1].invalidSpans = [{ from: start - 7_200_000, to: null }];
    h.limits = [{
      onset: start - 4 * 3_600_000,
      entry: start - 4 * 3_600_000,
      lift: start - 3_600_000,
      path: "evident",
      balance: 0,
      used: 0,
      settings: { ...CALIBRATION.start },
      gap: 0,
      mode: "shadow",
      track: null,
      caps: [],
      confirmed: true,
      learn: true,
      class: "sustained-use",
    }];
    await write(h);
    const lost = new Governor(shadow, p, undefined, f.io, paths);
    await lost.loadHistory(start);
    assertEquals(lost.calibration.applied, learned);
    assertEquals(lost.s.calibrationActivated, true);
    // The readings marked invalid stay out of fits; nothing left could end the open span.
    assertEquals(lost.calibration.invalidSpans, [{ from: start - 7_200_000, to: start }]);
    assertEquals(lost.calibration.cooldownUntil, start - 3_600_000 + 10_800_000);
    await lost.closeHistory();
    const back = new Governor(APPLY, p, structuredClone(lost.s), f.io, paths);
    assertEquals(back.calibration.applied, learned);
    // Decisions record that apply had run, so recovery can tell.
    await back.loadHistory(start);
    await back.request("/fixture", await f.io.clock());
    assert(back.history.calibrations.length >= 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("decisions after apply first ran are marked, with the readings marked invalid", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  f.g.calibration.invalidSpans = [{ from: start - 7_200_000, to: start - 3_600_000 }];
  await f.request("calibration-reset");
  const d = f.g.history.calibrations.at(-1)!;
  assertEquals(d.activated, true);
  assertEquals(d.invalidSpans, [{ from: start - 7_200_000, to: start - 3_600_000 }]);
  const shadow = fixture({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "shadow" },
  });
  await shadow.g.tick();
  await shadow.request("calibration-reset");
  assertEquals(shadow.g.history.calibrations.at(-1)!.activated, undefined);
});

Deno.test("persist.json that doesn't parse is set aside; one that can't be read stays", async () => {
  const dir = await testDirectory("persist-");
  try {
    const path = `${dir}/persist.json`;
    assertEquals(await readPersisted(path), { readable: true });
    await Deno.writeTextFile(path, "{ torn");
    assertEquals(await readPersisted(path), { readable: true, invalid: true });
    assert(
      (await Array.fromAsync(Deno.readDir(dir))).some((e) =>
        e.name.startsWith("persist.json.bad-")
      ),
    );
    await Deno.writeTextFile(path, JSON.stringify({ schema: 2 }));
    const read = await readPersisted(path);
    assertEquals([read.saved?.schema, read.readable], [2, true]);
    // Only the three newest copies set aside stay.
    for (let i = 1; i <= 4; i++) await Deno.writeTextFile(`${path}.bad-${i}`, "");
    await Deno.writeTextFile(path, "{ torn again");
    await readPersisted(path);
    const copies = (await Array.fromAsync(Deno.readDir(dir))).filter((e) =>
      e.name.startsWith("persist.json.bad-")
    );
    assertEquals(copies.length, 3);
    await Deno.writeTextFile(path, JSON.stringify({ schema: 2 }));
    await Deno.chmod(path, 0);
    // Root reads it anyway, and the test task grants no access to the uid.
    if (await Deno.readTextFile(path).then(() => false, () => true)) {
      assertEquals(await readPersisted(path), { readable: false });
      // That run leaves the file for the next one.
      const paths = { run: `${dir}/run`, lib: dir };
      await Deno.mkdir(paths.run);
      const f = fixture({}, paths);
      f.g.persistWritable = false;
      await f.g.tick();
      await f.g.save(start);
      await Deno.chmod(path, 0o600);
      assertEquals(JSON.parse(await Deno.readTextFile(path)), { schema: 2 });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an onset never reaches back into time the daemon didn't watch", async () => {
  const f = fixture();
  await f.g.tick();
  for (let i = 0; i < 4; i++) await f.advance(30, 0.3);
  // Stopped for three hours, then back with steal at once.
  await f.advance(10_800, 0.3, 0.3);
  const back = f.g.s.at;
  await f.advance(30, 0.3, 0.3);
  f.g.enterLimit(f.g.s.at, true);
  assertEquals(f.g.history.limits.at(-1)!.onset, back);
});

Deno.test("the first cap row judges pressing on the sample it measures", async () => {
  const f = fixture();
  await f.g.tick();
  // Five quiet minutes, then the sample that shows the limit, pressing on its own though not
  // averaged over the window.
  for (let i = 0; i < 10; i++) await f.advance(30, 0.3);
  await f.advance(30, 0.3, 0.05);
  f.g.enterLimit(f.g.s.at, true);
  const cap = f.g.history.limits.at(-1)!.caps[0];
  assertAlmostEquals(cap.busy, 2.4, 1e-9);
  assertEquals(cap.pressing, true);
});

Deno.test("a slot that closes reaches history even when the pass fails after it", async () => {
  const dir = await testDirectory("slot-durable-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 19; i++) await f.advance(30, 0.3);
    const closed = f.g.history.slots.length;
    f.g.io.ceiling = () => Promise.reject(new Error("cgroup unreadable"));
    while (f.g.history.slots.length === closed) await f.advance(30, 0.3).catch(() => {});
    await f.g.save(f.g.s.at);
    await f.g.closeHistory();
    const { history } = await readHistory(`${paths.lib}/history.json`, f.g.history.planKey, null);
    assertEquals(history.slots.length, f.g.history.slots.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a lost persist.json comes back from the recorded evaluation, verification counters included", async () => {
  const dir = await testDirectory("recover-checkpoint-");
  const cfg = {
    vcpus: 8,
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" as const, fit: { min_pairs: 2, min_days: 1 } },
  };
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const f = fixture(cfg, paths);
    await f.g.loadHistory(start);
    const from = start - 183_600_000;
    f.g.history.slots = Array.from(
      { length: 306 },
      (_, i) => slot(from + i * 600_000, 3 + Math.floor(i / 3) % 3),
    );
    const readings = Array.from(
      { length: 103 },
      (_, i) => ({ at: from + i * 1_800_000, v: (1.0463 * (3 + (i + 2) % 3) + 0.0193) / 8 * 100 }),
    );
    f.g.io.readings = () => Promise.resolve(readings);
    await f.g.tick();
    await f.advance();
    await f.advance();
    // A drift change mid-verification, and a CUSUM cursor at the newest pair.
    const c = f.g.calibration;
    assert(c.fit && c.lastPaired > 0);
    c.pending = {
      at: start - 3_600_000,
      from: { ...c.applied },
      gapFrom: c.gap,
      oldFit: c.fit,
      fit: { ...c.fit, b: c.fit.b + 0.2 },
      hold: { mul: 1.06, add: 0.3, floor: 0.05 },
      readings: 10,
      z: 8,
      verified: false,
      residual: 0,
      n: 0,
    };
    await f.request("seed");
    await f.advance();
    await f.g.closeDiagnostics();
    await f.g.closeHistory();
    await f.g.save(f.g.s.at);
    const before = structuredClone(f.g.calibration);
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor(cfg, p, undefined, f.io, paths);
    await g.loadHistory(f.g.s.at);
    const r = g.calibration;
    // Verification goes on from where it was, so 14 days of old pairs can't withdraw the hold.
    assertEquals(r.pending, before.pending);
    assertEquals(r.lastPaired, before.lastPaired);
    assertEquals(r.longPairedAt, before.longPairedAt);
    assertEquals(r.fit, before.fit);
    assertEquals(r.applied, before.applied);
    assertEquals(r.settledSeenAt, before.settledSeenAt);
    assertEquals(g.s.balance, 0);
    await g.closeHistory();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a persist.json a decision behind catches up with history on start", async () => {
  const dir = await testDirectory("catch-up-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    const saved = structuredClone(f.g.s);
    // A later evaluation recorded a tightening, then the daemon stopped before persist.json caught
    // up; its checkpoint didn't verify, so the decision alone carries it.
    const learned = { mul: 1.07, add: 0.09, floor: 0.06 };
    f.g.history.calibrations.push({
      at: saved.calibration!.evaluatedAt + 1,
      trigger: "limit-diagnosis",
      inputs: {},
      digest: "0",
      from: { ...CALIBRATION.start },
      to: learned,
      mode: "apply",
      learned,
      gap: 0.03,
      rulesMismatch: false,
      activated: true,
      serial: (saved.calibration!.serial ?? 0) + 1,
    });
    await f.g.closeHistory();
    const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
    store.write(f.g.history, start);
    await store.close();
    const g = new Governor(APPLY, p, saved, f.io, paths);
    await g.loadHistory(start);
    assertEquals(g.calibration.applied, learned);
    assertEquals(g.calibration.gap, 0.03);
    await g.closeHistory();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("only a lift test that still found the limit places the cap", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, true);
  const record = f.g.s.limit!.record!;
  // A test that passed: the burners got far more than the limit, with no steal.
  f.g.io.demand = () => Promise.resolve({ busy: 6 / p.vcpus, steal: 0, seconds: 25 });
  assert(await f.g.limitGone());
  assertEquals(record.testDelivery, undefined);
  // One that ran into the limit.
  f.g.io.demand = () => Promise.resolve({ busy: 2.4 / p.vcpus, steal: 0.5, seconds: 25 });
  assert(!await f.g.limitGone());
  assertAlmostEquals(record.testDelivery!.busy, 2.4, 1e-9);
});

Deno.test("a failed test above the credit cap places it only once a later test fails", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, true);
  const record = f.g.s.limit!.record!;
  // After Hostinger's lift, neighbours' steal alone fails a test: 4 cores delivered, 20% stolen.
  f.g.io.demand = () => Promise.resolve({ busy: 4 / p.vcpus, steal: 0.2, seconds: 25 });
  assert(!await f.g.limitGone());
  assertEquals(record.testDelivery, undefined);
  assertAlmostEquals(record.testCandidate!.busy, 4, 1e-9);
  // Read as a cap, that delivery would make the credit limit sustained-use.
  assertEquals(
    classifyLimit(p, { ...record, testDelivery: record.testCandidate }),
    "sustained-use",
  );
  assertEquals(classifyLimit(p, record), "unknown");
  // A later test that still fails shows the first one ran into the limit: a sustained-use cap.
  f.g.io.demand = () => Promise.resolve({ busy: 3 / p.vcpus, steal: 0.4, seconds: 25 });
  assert(!await f.g.limitGone());
  assertAlmostEquals(record.testDelivery!.busy, 4, 1e-9);
  assertEquals(record.testCandidate, undefined);
  assertEquals(classifyLimit(p, record), "sustained-use");
});

Deno.test("a credit limit widen() can't measure leaves the margin and apply's start alone", async () => {
  const f = fixture();
  await f.g.tick();
  const record = sustainedLift(f, [2.4, 2.4]);
  // Too little was spent during the limit for widen() to learn from.
  record.used = 1000;
  await f.advance();
  assertEquals(record.class, "credit");
  assertEquals(f.g.s.margin, { mul: 1.05, add: 0.08 });
  assert(!f.g.s.marginLearned);
  assertEquals(new Governor(APPLY, p, structuredClone(f.g.s), f.io).settings, CALIBRATION.start);
});

Deno.test("a pass that tested the lift isn't counted as time the daemon didn't watch", async () => {
  const f = fixture();
  await f.g.tick();
  await f.advance(30, 0.3);
  // A lift test and the wait after it: 75 seconds since the last pass began.
  f.g.s.tested = true;
  await f.advance(75, 0.3);
  assertEquals(f.g.s.samples.at(-1)!.unobserved, undefined);
  await f.advance(75, 0.3);
  assertEquals(f.g.s.samples.at(-1)!.unobserved, true);
});

Deno.test("a limit record in persist.json that fails validation is dropped, not adopted", async () => {
  const f = fixture();
  await f.g.tick();
  f.g.enterLimit(start, true);
  const saved = structuredClone(f.g.s);
  (saved.limit!.record as { caps?: unknown }).caps = "broken";
  const g = new Governor({}, p, saved, f.io);
  g.adoptHistory(emptyHistory(planKey(p), null, start), start);
  assertEquals(g.s.limit!.record, undefined);
  assertEquals(g.history.limits, []);
  await g.tick();
});

// A pass the daemon made in its own directory, with the files it leaves behind.
async function withFiles(run: (paths: { run: string; lib: string }) => Promise<void>) {
  const dir = await testDirectory("files-");
  try {
    const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
    await run(paths);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("persist.json is written only once history holds the pass it saves", async () => {
  await withFiles(async (paths) => {
    // No VM, so no fetch finishing inside the pass marks history again before save().
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    await f.g.save(start);
    const persisted = () => Deno.readTextFile(`${paths.lib}/persist.json`);
    const before = await persisted();
    // Hold the history log's appends: the pass below closes a slot and records an evaluation.
    const open = Deno.open;
    let release = () => {};
    const held = new Promise<void>((resolve) => release = resolve);
    (Deno as { open: unknown }).open = (...args: Parameters<typeof Deno.open>) =>
      String(args[0]).endsWith(".log") ? held.then(() => open(...args)) : open(...args);
    try {
      await f.advance(600, 0.2);
      const saving = f.g.save(start + 600_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(await persisted(), before);
      release();
      await saving;
      assert((await persisted()) !== before);
    } finally {
      (Deno as { open: unknown }).open = open;
      release();
    }
    await f.g.closeHistory();
  });
});

Deno.test("a reset that persist.json missed is not undone on start", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    Object.assign(f.g.calibration, {
      applied: { mul: 1.1, add: 0.2, floor: 0.1 },
      gap: 0.1,
      rulesMismatch: true,
    });
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    const tightened = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    assertEquals(tightened.calibration!.rulesMismatch, true);
    // The reset reaches history; the daemon stops before persist.json follows.
    await f.request("calibration-reset");
    await f.g.closeHistory();
    for (const pass of [false, true]) {
      const g = new Governor(APPLY, p, structuredClone(tightened), f.io, paths);
      await g.loadHistory(start + 30_000);
      assertEquals(g.calibration.applied, CALIBRATION.start, `pass after the reset: ${pass}`);
      assertEquals([g.calibration.gap, g.calibration.rulesMismatch], [0, false]);
      await g.closeHistory();
      if (pass) break;
      // Again with the evaluation after the reset recorded too.
      await f.advance(30, 0.2);
      await f.g.closeHistory();
    }
  });
});

Deno.test("in off, a failing evaluation still classifies a lifted limit, widens and cools down", async () => {
  const f = fixture();
  await f.g.tick();
  const lifted = (onset: number, busy: number[]): LimitRecord => ({
    onset,
    entry: onset,
    lift: onset + busy.length * 1_800_000,
    path: "evident",
    balance: 5000,
    used: 50000,
    settings: { ...CALIBRATION.start },
    gap: 0,
    mode: "off",
    track: null,
    caps: busy.map((b, i) => ({
      at: onset + i * 1_800_000,
      busy: b,
      demand: b + 1,
      ceiling: 800,
      pressing: true,
    })),
    confirmed: true,
    learn: true,
  });
  const credit = lifted(start - 6 * 3_600_000, [2.4, 2.4, 2.4]);
  const sustained = lifted(start - 3 * 3_600_000, [6, 4, 2.5]);
  f.g.history.limits = [credit, sustained];
  // Something in the readings math throws; classification needs only the records.
  f.g.calibration.invalidSpans = null as never;
  const log = console.log;
  console.log = () => {};
  try {
    await f.advance(600, 0.2);
  } finally {
    console.log = log;
  }
  assertEquals(f.g.history.limits.map((r) => r.class), ["credit", "sustained-use"]);
  assertEquals(f.g.s.margin, widen(MARGIN, credit.balance, credit.used));
  assertEquals(f.g.calibration.cooldownUntil, sustained.lift! + 10_800_000);
});

Deno.test("a lost persist.json gives back the margin widen() learned", async () => {
  await withFiles(async (paths) => {
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // Off records the legacy margin in force at entry.
    const learned: LimitRecord = {
      onset: start - 3_600_000,
      entry: start - 3_600_000,
      lift: start,
      path: "evident",
      balance: 5000,
      used: 50000,
      settings: { ...MARGIN, floor: 0.2 },
      gap: 0,
      mode: "off",
      track: null,
      caps: [],
      confirmed: true,
      learn: true,
      class: "credit",
      legacyLearned: true,
    };
    f.g.history.limits.push(learned);
    f.g.s.margin = widen(MARGIN, learned.balance, learned.used);
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor({}, p, undefined, f.io, paths);
    await g.loadHistory(start + 30_000);
    assertEquals(g.s.margin, widen(MARGIN, learned.balance, learned.used));
    await g.closeHistory();
  });
});

Deno.test("a failed restore of the default period is retried, not left at 10 ms", async () => {
  const f = fixture({ recovery: { quota_period_ms: 10 } });
  const calls: (number | null | undefined)[] = [];
  let failures = 0;
  f.g.io.cap = (_s, _n, period) => {
    calls.push(period);
    if (period === null && failures > 0) {
      failures--;
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  };
  await f.g.tick();
  f.g.enterLimit(start, false);
  await f.advance();
  assertEquals(f.g.s.quotaPeriod, 10);
  // The first restore at the lift fails once.
  failures = 1;
  const before = calls.filter((c) => c === null).length;
  f.g.limitGone = () => Promise.resolve(true);
  f.g.s.balance = p.recovered;
  for (let i = 0; i < 40; i++) await f.advance(30, 0.2);
  assertEquals(calls.filter((c) => c === null).length - before, 2);
  assertEquals(f.g.s.quotaPeriod, undefined);
});

Deno.test("the first pass after a switch to apply evaluates, so explain equals the daemon", async () => {
  await withFiles(async (paths) => {
    const shadow = { ...APPLY, calibration: { mode: "shadow" as const } };
    const f = fixture(shadow, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // What shadow learned stays out of apply's first start, so the recorded evaluation differs.
    Object.assign(f.g.calibration, {
      applied: { mul: 1.07, add: 0.1, floor: 0.07 },
      rulesMismatch: true,
    });
    for (let i = 0; i < 25; i++) await f.advance(30, 0.3);
    await f.g.save(start + 750_000);
    await f.g.closeHistory();
    const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    // No fetch completes, so only the start itself makes the first pass evaluate.
    f.io.readings = () => Promise.reject(new Error("offline"));
    const g = new Governor(APPLY, p, saved, f.io, paths);
    await g.loadHistory(start + 750_000);
    f.elapse(30, 0.3);
    await g.tick();
    await g.save(start + 780_000);
    await g.closeHistory();
    const explained = await explainCalibration({ ...APPLY, vcpus: p.vcpus }, paths.lib);
    const status = g.calibrationStatus();
    assertEquals(status.applied, CALIBRATION.start);
    assertEquals(explained.evidence.at, g.calibration.evaluatedAt);
    assertEquals([explained.applied, explained.estimates], [status.applied, status.estimates]);
  });
});

Deno.test("after a lost persist.json the first slot back carries a reboot mark for the clamp", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 40; i++) await f.advance(30, 0.3);
    await f.g.save(start + 1_200_000);
    await f.g.closeHistory();
    const slots = f.g.history.slots.length;
    await Deno.remove(`${paths.lib}/persist.json`);
    // Local samples restart with the new process; so does the clamp's replay, from an empty bank.
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(start + 1_200_000);
    await g.tick();
    for (let i = 0; i < 25; i++) {
      f.elapse(30, 0.3);
      await g.tick();
    }
    const back = g.history.slots.slice(slots);
    assert(back.length > 0);
    assert(back[0].flags & FLAGS.reboot);
    await g.closeHistory();
  });
});

// A credit limit off learned from, as off records it: the legacy margin in force at entry.
const offLimit = (onset: number, settings = { ...MARGIN, floor: 0.2 }): LimitRecord => ({
  onset,
  entry: onset,
  lift: onset + 3_600_000,
  path: "evident",
  balance: 5000,
  used: 50000,
  settings,
  gap: 0,
  mode: "off",
  track: null,
  caps: [],
  confirmed: true,
  learn: true,
  class: "credit",
  legacyLearned: true,
});

Deno.test("apply's first start after a lost persist.json keeps the margin off widened", async () => {
  await withFiles(async (paths) => {
    const f = fixture({ hostinger: APPLY.hostinger }, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // An older widening, entered at 1.15x + 0.18, outlived every record but this one.
    const record = offLimit(start - 7_200_000, { mul: 1.15, add: 0.18, floor: 0.2 });
    f.g.history.limits.push(record);
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(start + 30_000);
    const widened = widen({ mul: 1.15, add: 0.18 }, record.balance, record.used);
    assertEquals(g.s.margin, widened);
    assert(
      g.settings.mul >= widened.mul && g.settings.add >= widened.add,
      JSON.stringify(g.settings),
    );
    await g.closeHistory();
  });
});

Deno.test("on start, history's copy of the open limit's record wins over persist.json's", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.enterLimit(start, false);
    await f.advance(30, 0.3);
    await f.g.save(start + 30_000);
    const behind = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    // The next pass confirms the limit; history holds it, persist.json doesn't.
    f.g.s.limit!.record!.confirmed = true;
    f.g.s.limit!.record!.caps.push({ ...f.g.s.limit!.record!.caps[0], at: start + 60_000 });
    await f.advance(30, 0.3);
    await f.g.closeHistory();
    const g = new Governor(APPLY, p, behind, f.io, paths);
    await g.loadHistory(start + 60_000);
    assertEquals(g.s.limit?.record?.confirmed, true);
    assertEquals(g.s.limit?.record?.caps.length, 2);
    await g.closeHistory();
  });
});

Deno.test("a limit open at the first switch to apply still teaches it", async () => {
  await withFiles(async (paths) => {
    const shadow = { ...APPLY, calibration: { mode: "shadow" as const } };
    const f = fixture(shadow, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.enterLimit(start, true);
    await f.advance(30, 0.3);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    const g = new Governor(APPLY, p, saved, f.io, paths);
    await g.loadHistory(start + 30_000);
    const record = g.s.limit!.record!;
    assert(record.entry >= g.calibration.startedAt, `${record.entry} ${g.calibration.startedAt}`);
    await g.closeHistory();
  });
});

Deno.test("a lost persist.json beside unreadable history is no first start", async () => {
  await withFiles(async (paths) => {
    const f = fixture({ ...APPLY, initial_balance: p.capacity }, paths);
    const g = f.g;
    await g.loadHistory(start);
    (g as unknown as { historyStore: { unreadable: boolean } }).historyStore.unreadable = true;
    g.persistWritable = true;
    g.adoptHistory(g.history, start);
    // The bank isn't known, and persist.json waits for the history this run couldn't read.
    assertEquals(g.s.balance, 0);
    assertEquals(g.persistWritable, false);
    await g.closeHistory();
  });
});

Deno.test("recovery from decisions keeps a lift-check mismatch toward the 30-day latch", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    const record = { ...offLimit(start - 2 * 86_400_000), mode: "apply" as const };
    delete record.legacyLearned;
    f.g.history.limits.push(record);
    f.g.history.calibrations.push({
      at: start - 86_400_000,
      trigger: "rules-mismatch",
      inputs: { onset: record.onset, ratio: 1.8, predicted: 1000, mismatches: 1, latched: false },
      digest: "0",
      from: { ...CALIBRATION.start },
      to: { ...CALIBRATION.start },
      mode: "apply",
      learned: { ...CALIBRATION.start },
      gap: 0,
      rulesMismatch: false,
      activated: true,
      serial: 1,
    });
    // No checkpoint verifies, so the decisions carry the recovery.
    delete f.g.history.checkpoint;
    await f.advance(30, 0.2);
    f.g.history.checkpoint = undefined;
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
    const loaded = await store.load(planKey(p), 1, start + 30_000);
    loaded.checkpoint = undefined;
    store.write(loaded, start + 30_000);
    await store.close();
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(start + 30_000);
    assertEquals(g.calibration.mismatches, [record.lift]);
    await g.closeHistory();
  });
});

Deno.test("a start catches up by serial, not by time, after the clock stepped back", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    const behind = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    // A reset while the clock runs an hour behind, recorded in history but not in persist.json.
    Object.assign(f.g.calibration, { applied: { mul: 1.1, add: 0.2, floor: 0.1 } });
    behind.calibration!.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
    f.elapse(30, 0.2, 0, undefined, -3600);
    await f.request("calibration-reset");
    await f.g.closeHistory();
    assert(f.g.history.checkpoint!.at < behind.calibration!.evaluatedAt);
    const g = new Governor(APPLY, p, behind, f.io, paths);
    await g.loadHistory(start);
    assertEquals(g.calibration.applied, CALIBRATION.start);
    await g.closeHistory();
  });
});

Deno.test("the rebuilt legacy margin keeps the margin any kept record held at entry", async () => {
  await withFiles(async (paths) => {
    const f = fixture({}, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // An unknown limit taught nothing, but entered under a margin earlier limits had widened.
    const { legacyLearned: _, ...unknown } = offLimit(start - 7_200_000, {
      mul: 1.12,
      add: 0.12,
      floor: 0.2,
    });
    f.g.history.limits.push({ ...unknown, class: "unknown" });
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor({}, p, undefined, f.io, paths);
    await g.loadHistory(start + 30_000);
    assertEquals(g.s.margin, { mul: 1.12, add: 0.12 });
    await g.closeHistory();
  });
});

// Makes the recorded evaluation fail its digest, as an upgrade that changes the evaluation does, in
// a pass too close to the last to evaluate, which history's write then carries.
async function unverifiable(g: Governor) {
  g.history.checkpoint = { ...g.history.checkpoint!, digest: "00000000" };
  await g.tick();
}

Deno.test("after recovering from decisions, no later start takes an old reset as newer", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    await f.request("calibration-reset");
    for (let i = 0; i < 3; i++) await f.advance(30, 0.2);
    await unverifiable(f.g);
    await f.g.save(f.g.s.at!);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    // Recovered from the decisions, then tightened by later learning, and saved.
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(f.g.s.at!);
    const reset = f.g.history.calibrations.findLast((d) => d.trigger === "reset")!;
    assert(g.calibration.serial! >= reset.serial!, `${g.calibration.serial} < ${reset.serial}`);
    g.calibration.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
    await g.tick();
    await g.save(g.s.at!);
    await g.closeHistory();
    // A plain restart keeps what was learned: the reset's decision is older than persist.json.
    const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    const again = new Governor(APPLY, p, saved, f.io, paths);
    await again.loadHistory(g.s.at!);
    assertEquals(again.calibration.applied, { mul: 1.1, add: 0.2, floor: 0.1 });
    await again.closeHistory();
  });
});

Deno.test("a lost persist.json after apply ran is no first start: earlier limits can't teach", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.enterLimit(start, true);
    await f.advance(30, 0.2);
    // A reset while the limit is still open: that limit can no longer teach.
    await f.request("calibration-reset");
    await f.advance(30, 0.2);
    const startedAt = f.g.calibration.startedAt;
    assert(startedAt > f.g.s.limit!.record!.entry);
    await f.g.save(f.g.s.at!);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(f.g.s.at!);
    assertEquals(g.calibration.startedAt, startedAt);
    assert(g.s.calibrationActivated);
    await g.closeHistory();
  });
});

Deno.test("apply's first start keeps the widened margin when only decisions survive", async () => {
  await withFiles(async (paths) => {
    const f = fixture({ ...APPLY, calibration: { mode: "shadow" as const } }, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.history.limits.push(offLimit(start - 7_200_000, { mul: 1.15, add: 0.18, floor: 0.2 }));
    await f.advance(30, 0.2);
    assert(f.g.history.checkpoint);
    await unverifiable(f.g);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(start + 30_000);
    const widened = widen({ mul: 1.15, add: 0.18 }, 5000, 50000);
    assert(
      g.settings.mul >= widened.mul && g.settings.add >= widened.add,
      JSON.stringify(g.settings),
    );
    await g.closeHistory();
  });
});

Deno.test("apply's first start after a lost persist.json drops what shadow learned", async () => {
  await withFiles(async (paths) => {
    const f = fixture({ ...APPLY, calibration: { mode: "shadow" as const } }, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.calibration.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor(APPLY, p, undefined, f.io, paths);
    await g.loadHistory(start + 30_000);
    // The recorded evaluation verifies and gives shadow's state back, which apply starts over from.
    assertEquals(g.calibration.applied, CALIBRATION.start);
    await g.closeHistory();
  });
});

Deno.test("a persist.json that doesn't parse, or can't be read, counts as lost before history exists", async () => {
  const cfg = { initial_balance: 20_000 };
  await withFiles(async (paths) => {
    const persist = `${paths.lib}/persist.json`;
    await Deno.writeTextFile(persist, "{ torn");
    const g = await openGovernor(cfg, p, start, fixture().io, paths);
    assertEquals(g.s.balance, 0);
    assert(g.s.rebuilding && g.s.rebootPending);
    await g.closeHistory();
    await Deno.remove(paths.lib, { recursive: true });
    await Deno.mkdir(paths.lib);
    // One this run can't read is existing state too: it doesn't grant initial_balance. Root reads
    // any file, so there it can't be made unreadable.
    await Deno.writeTextFile(persist, "{}");
    await Deno.chmod(persist, 0);
    if (!await Deno.readTextFile(persist).then(() => true, () => false)) {
      const unreadable = await openGovernor(cfg, p, start, fixture().io, paths);
      assertEquals([unreadable.s.balance, unreadable.persistWritable], [0, false]);
      await unreadable.closeHistory();
    }
    await Deno.chmod(persist, 0o600);
    await Deno.remove(paths.lib, { recursive: true });
    await Deno.mkdir(paths.lib);
    // A first start still takes initial_balance.
    const first = await openGovernor(cfg, p, start, fixture().io, paths);
    assertEquals(first.s.balance, 20_000);
    await first.closeHistory();
  });
});

Deno.test("a limit history recorded and persist.json missed goes on as a limit", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    await f.advance(30, 0.3);
    await f.g.save(start + 30_000);
    const before = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    // A limit enters; history has its record when the daemon stops, persist.json doesn't.
    f.g.enterLimit(start + 30_000, true, "evident");
    f.g.s.limit!.record!.confirmed = true;
    (f.g as unknown as { writeHistory(now: number): void }).writeHistory(start + 30_000);
    await f.g.closeHistory();
    for (const saved of [structuredClone(before), undefined]) {
      // persist.json from before the limit, or none at all.
      const g = new Governor(APPLY, p, saved, f.io, paths);
      await g.loadHistory(start + 60_000);
      const record = g.history.limits.at(-1)!;
      assertEquals(g.s.limit?.record, record);
      assertEquals([g.s.limit!.since, g.s.balance, record.learn], [record.entry, 0, true]);
      // It holds the box at the recovery ceiling from the first pass, as across a reboot.
      assertEquals(g.s.limit!.ceiling, recoveryCeiling(p, 0.4));
      await g.closeHistory();
    }
    // The other way: history recorded the lift that persist.json missed, so the limit is over.
    const limited = structuredClone(f.g.s);
    f.g.s.limit!.record!.lift = start + 90_000;
    f.g.s.limit = undefined;
    (f.g as unknown as { writeHistory(now: number): void }).writeHistory(start + 90_000);
    await f.g.closeHistory();
    const g = new Governor(APPLY, p, limited, f.io, paths);
    await g.loadHistory(start + 120_000);
    assertEquals(g.s.limit, undefined);
    assertEquals(g.history.limits.at(-1)!.lift, start + 90_000);
    await g.closeHistory();
  });
});

const sustainedRecord = (onset: number) => ({
  ...limitRecord("apply"),
  onset,
  entry: onset + 90_000,
});

Deno.test("the sustained-use cooldown follows from the limit records", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  f.g.calibration.cooldownUntil = 0;
  f.g.s.balance = p.capacity;
  // A crash left persist.json without the cooldown; history holds the classified record.
  f.g.history.limits.push({
    ...sustainedRecord(start - 3_600_000),
    lift: start - 600_000,
    class: "sustained-use",
  });
  await f.advance(30, 0.2);
  // At the baseline, by the settings in force, though the bank is full.
  assertEquals(f.cap, sliceCeiling(p, (p.baseline - 0.04) / 1.05, 0));
  assert(f.cap < sliceCeiling(p, p.vcpus, 0));
  assert(f.g.calibrationStatus().cooldownUntil! > start);
});

Deno.test("a widening off learned from a limit entered in apply survives a lost persist.json", async () => {
  await withFiles(async (paths) => {
    const f = fixture({ ...APPLY, calibration: { mode: "off" } }, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // Entered in apply, lifted and widened in off: its entry settings are apply's, not the legacy
    // margin, so only the margin the widening left gives it back.
    const record = {
      ...sustainedRecord(start - 7_200_000),
      mode: "apply" as const,
      settings: { ...CALIBRATION.start },
      class: "credit" as const,
      confirmed: true,
      learn: true,
      legacyLearned: true,
      legacyMargin: { mul: 1.15, add: 0.1 },
      lift: start - 3_600_000,
    };
    f.g.history.limits.push(record);
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    await Deno.remove(`${paths.lib}/persist.json`);
    const g = new Governor({ ...APPLY, calibration: { mode: "off" } }, p, undefined, f.io, paths);
    await g.loadHistory(start + 60_000);
    assertEquals(g.s.margin, { mul: 1.15, add: 0.1 });
    await g.closeHistory();
  });
});

Deno.test("a request just after a pass takes that pass's time", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  await f.advance(30, 0.3);
  const passAt = f.g.s.at;
  f.elapse(3, 0.3);
  await f.request("calibration-reset");
  await f.g.tick();
  // The closely spaced pass evaluates where the open slot ends, so the reset is no later than it.
  assertEquals(f.g.history.calibrations.at(-1)!.at, passAt);
  assert(f.g.calibration.evaluatedAt >= f.g.calibration.startedAt);
  assert(f.g.history.checkpoint!.at >= f.g.calibration.startedAt);
  // `limit on` in the pass that ran `limit off` begins after that lift, and never before its entry.
  f.g.enterLimit(f.g.s.at, true, "evident");
  await f.request("limit-off");
  await f.request("limit-on");
  const last = f.g.history.limits.at(-1)!;
  assert(last.entry >= last.onset);
});

Deno.test("a limit record in persist.json that fails validation takes history's copy", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.enterLimit(start, true);
    await f.advance(30, 0.3);
    await f.g.save(start + 30_000);
    await f.g.closeHistory();
    const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    (saved.limit!.record as { caps?: unknown }).caps = "broken";
    const g = new Governor(APPLY, p, saved, f.io, paths);
    await g.loadHistory(start + 30_000);
    assertEquals(g.s.limit!.record!.onset, f.g.s.limit!.record!.onset);
    assert(Array.isArray(g.s.limit!.record!.caps));
    assertEquals(g.history.limits.length, 1);
    await g.closeHistory();
  });
});

Deno.test("persist.json says when history fell behind it, and its limit record wins then", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    f.g.enterLimit(start, true);
    await f.advance(30, 0.3);
    await f.g.save(start + 30_000);
    // History's appends fail from here; the pass confirms the limit all the same.
    const open = Deno.open;
    (Deno as { open: unknown }).open = (...args: Parameters<typeof Deno.open>) =>
      String(args[0]).endsWith(".log")
        ? Promise.reject(new Deno.errors.PermissionDenied("held"))
        : open(...args);
    try {
      f.g.s.limit!.record!.confirmed = true;
      await f.advance(30, 0.3);
      await f.g.save(start + 60_000);
    } finally {
      (Deno as { open: unknown }).open = open;
    }
    await f.g.closeHistory();
    const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    assertEquals(saved.historyBehind, true);
    assertEquals(f.g.s.historyBehind, undefined);
    const g = new Governor(APPLY, p, saved, f.io, paths);
    await g.loadHistory(start + 60_000);
    assertEquals(g.s.limit!.record!.confirmed, true);
    assertEquals(g.history.limits.at(-1)!.confirmed, true);
    await g.closeHistory();
  });
});

Deno.test("calibration learned from another VM's readings starts over", () => {
  const f = fixture(APPLY);
  f.g.calibration.gap = 0.1;
  f.g.calibration.applied = { mul: 1.1, add: 0.2, floor: 0.1 };
  const saved = structuredClone(f.g.s);
  assertEquals(saved.vmId, 1);
  const other = new Governor({ ...APPLY, hostinger: { ...APPLY.hostinger, vm_id: 2 } }, p, saved);
  assertEquals([other.calibration.gap, other.calibration.applied], [0, CALIBRATION.start]);
  assertEquals(other.s.vmId, 2);
  // Without a VM there are no readings: nothing can come from another meter, and the VM it learned
  // from is kept for the next check.
  const off = new Governor({ calibration: { mode: "off" } }, p, structuredClone(saved));
  assertEquals(off.calibration.gap, 0.1);
  assertEquals(off.s.vmId, 1);
});

Deno.test("a rebuilt history drops the clamp's base persist.json carried", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY);
    f.g.calibration.replayBase = { at: start, balance: 1000, exact: true, gap: 0 };
    const g = new Governor(APPLY, p, structuredClone(f.g.s), f.io, paths);
    await g.loadHistory(start);
    assertEquals(g.calibration.replayBase, null);
    await g.closeHistory();
  });
});

Deno.test("off and shadow report the legacy margin and floor as the settings in force", () => {
  for (const mode of ["off", "shadow"] as const) {
    const f = fixture({ ...APPLY, calibration: { mode } });
    const status = f.g.publicState(start).credits.calibration!;
    assertEquals(status.applied, { ...MARGIN, floor: 0.2 });
    assertEquals(status.learned, CALIBRATION.start);
  }
  const f = fixture(APPLY);
  assertEquals(f.g.publicState(start).credits.calibration!.applied, CALIBRATION.start);
});

Deno.test("in apply, learning under a higher hold still fires the calibration hook", async () => {
  const f = fixture(APPLY);
  const hooks: string[] = [];
  f.g.io.hooks = (event) => {
    hooks.push(event);
    return Promise.resolve();
  };
  // No readings arrive, so the stale fallback below stays in force.
  f.g.io.readings = () => Promise.resolve([]);
  await f.g.tick();
  // The stale fallback's 1.05x + 0.08 rises above the learned settings: that fires once.
  f.g.calibration.settledSeenAt = start - 30 * 3_600_000;
  f.g.calibration.hold = { since: start, reason: "stale" };
  await f.advance(30);
  assertEquals(hooks, ["calibration"]);
  // Learning tightens the learned settings while the fallback stays above them.
  const before = f.g.settings;
  f.g.calibration.applied = { ...CALIBRATION.start, add: 0.06 };
  assertEquals(f.g.settings, before);
  await f.advance(30);
  assertEquals(hooks, ["calibration", "calibration"]);
  // A pass that changes neither fires nothing, whatever it records.
  await f.advance(30);
  assertEquals(hooks, ["calibration", "calibration"]);
});

Deno.test("a failing evaluation in apply holds the fallback and keeps the clamp's margin", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  await f.advance(30, 0.3);
  const hooks: string[] = [];
  f.g.io.hooks = (event) => {
    hooks.push(event);
    return Promise.resolve();
  };
  // A record that can't be classified makes the next evaluation throw.
  const bad = { onset: start, lift: start + 1 } as LimitRecord;
  f.g.history.limits.push(bad);
  f.g.s.balance = 20_000;
  f.g.calibration.estimates = { open: 20_000, clamp: 19_000, track: null, acted: 19_000 };
  f.g.s.anchor = { at: start, balance: 0, exact: false, checkedAt: start };
  assertEquals(f.g.publicState(start).credits.anchor?.applied, true);
  await f.advance(600, 0.3);
  assertEquals(f.g.settings, { ...CALIBRATION.start, add: MARGIN.add });
  assertAlmostEquals(f.g.actedBalance, f.g.s.balance - 1000, 1e-6);
  // The hold lowered it, not the readings, and it shows as failing.
  f.g.s.anchor = { at: start, balance: 0, exact: false, checkedAt: start };
  assertEquals(f.g.publicState(start).credits.anchor?.applied, false);
  assertEquals(f.g.calibrationStatus().failing?.behind, 1000);
  assert(!f.g.s.capFailed);
  assertEquals(f.cap, f.g.s.ceiling);
  assertEquals(hooks, ["calibration"]);
  // The next slot or fetch evaluates again; a failure that repeats doesn't run every pass, and the
  // passes between keep the fallback and the margin below the open estimate. A pass between used
  // to rebuild the estimates and act on the open one, and the next failure then measured no margin.
  assertEquals((f.g as unknown as { recalibrateDue: boolean }).recalibrateDue, false);
  await f.advance(30, 0.3);
  assertEquals(f.g.settings.add, MARGIN.add);
  assertAlmostEquals(f.g.actedBalance, f.g.s.balance - 1000, 1e-6);
  await f.advance(600, 0.3);
  assertAlmostEquals(f.g.actedBalance, f.g.s.balance - 1000, 1e-6);
  assertEquals(f.g.calibrationStatus().estimates.acted, f.g.actedBalance);
  // persist.json carries it, so a restart holds the same fallback until an evaluation succeeds.
  const restarted = new Governor(APPLY, p, structuredClone(f.g.s), f.io);
  assertEquals(restarted.s.evaluationFailed?.behind, 1000);
  f.g.history.limits = f.g.history.limits.filter((r) => r !== bad);
  await f.advance(600, 0.3);
  assertEquals(f.g.settings, CALIBRATION.start);
  assertEquals(f.g.s.evaluationFailed, undefined);
  assertEquals(hooks, ["calibration", "calibration"]);
});

Deno.test("explain equals the daemon on the pass a reboot resets the bank", async () => {
  const dir = await testDirectory("calibration-reboot-");
  const cfg = { ...APPLY, vcpus: 8 };
  try {
    await Deno.mkdir(`${dir}/run`);
    await Deno.mkdir(`${dir}/lib`);
    const f = fixture(cfg, { run: `${dir}/run`, lib: `${dir}/lib` });
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 25; i++) await f.advance(30, 0.3);
    f.reboot();
    await f.g.tick();
    await f.g.save(f.g.s.at!);
    const explained = await explainCalibration(cfg, `${dir}/lib`);
    assertEquals(explained.estimates, f.g.calibration.estimates);
    assertEquals(explained.evidence.at, f.g.s.at);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("limit on and off sent together run in the order sent, and the lift isn't before entry", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    // A limit lifted in this pass, so the next record starts just after that lift, past now.
    await f.request("limit-on");
    await f.request("limit-off");
    const requests = `${paths.run}/requests`;
    await Deno.mkdir(requests);
    f.g.io.requestBody = (path) => Deno.readTextFile(path);
    // Sent a millisecond apart, `limit off` last; the directory may list them either way round.
    const send = (name: string, action: string) =>
      Deno.writeTextFile(`${requests}/${name}.json`, JSON.stringify({ action }));
    await send(`${start + 2}-b`, "limit-off");
    await send(`${start + 1}-a`, "limit-on");
    await f.g.takeRequests(await f.io.clock());
    assertEquals(f.g.s.limit, undefined);
    const [first, second] = f.g.history.limits;
    assert(second.onset > first.lift!);
    assert(second.lift! >= second.entry, JSON.stringify(second));
    await f.g.closeHistory();
  });
});

Deno.test("a malformed failure record is rebuilt once, and later starts keep when it began", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  const saved = structuredClone(f.g.s);
  saved.evaluationFailed = { since: "soon" } as never;
  const g = new Governor(APPLY, p, saved, f.io);
  const rebuilt = g.s.evaluationFailed!;
  assertEquals(rebuilt.behind, p.capacity);
  // Passes ran since, still failing, and another start reads what this one saved.
  const later = { ...structuredClone(g.s), at: g.s.at + 600_000 };
  assertEquals(new Governor(APPLY, p, later, f.io).s.evaluationFailed, rebuilt);
});

Deno.test("a reading a later fetch fills in moves the next meter pair to its own interval", async () => {
  for (const kept of [true, false]) {
    const f = fixture(APPLY);
    // Readings 20 minutes apart, the second a fetch late; each fetch holds back its newest.
    const t0 = start + 600_000, late = t0 + 1_200_000, next = t0 + 2_400_000;
    let filled = false, fetches = 0;
    f.g.io.readings = (_h, _id, _from, to = Infinity) => {
      fetches++;
      return Promise.resolve(
        [t0, late, next, t0 + 3_600_000]
          .filter((at) => at <= to && (filled || at !== late))
          .map((at) => ({ at, v: 20 })),
      );
    };
    const pairAt = (at: number) => f.g.history.meterPairs?.find((x) => x.at === at);
    await f.g.tick();
    for (let i = 0; i < 400 && !pairAt(next); i++) {
      await f.advance(30, 0.3);
      await flush();
    }
    assertEquals(pairAt(next)?.from, t0);
    filled = true;
    // Without the samples for it, the pair can't be computed again, and its interval is gone.
    if (!kept) f.g.s.samples = [];
    const before = fetches;
    for (let i = 0; i < 100 && fetches === before; i++) {
      await f.advance(30, 0.3);
      await flush();
    }
    assert(fetches > before);
    assertEquals(pairAt(late)?.from, kept ? t0 : undefined, `kept ${kept}`);
    assertEquals(pairAt(next)?.from, kept ? late : undefined, `kept ${kept}`);
    await f.g.closeDiagnostics();
  }
});

Deno.test("a reset persist.json missed holds though a decision followed it", async () => {
  await withFiles(async (paths) => {
    const f = fixture(APPLY, paths);
    await f.g.loadHistory(start);
    await f.g.tick();
    Object.assign(f.g.calibration, {
      applied: { mul: 1.1, add: 0.2, floor: 0.1 },
      gap: 0.1,
      rulesMismatch: true,
    });
    await f.advance(30, 0.2);
    await f.g.save(start + 30_000);
    const tightened = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
    // The reset reaches history, then a decision after it; persist.json has neither, and the
    // checkpoint doesn't verify, so the decisions alone carry the recovery.
    await f.request("calibration-reset");
    const reset = f.g.history.calibrations.at(-1)!;
    assertEquals(reset.trigger, "reset");
    f.g.history.calibrations.push({
      ...reset,
      at: reset.at + 1,
      trigger: "stale-fallback",
      inputs: {},
      digest: "0",
      serial: reset.serial! + 1,
    });
    f.g.history.checkpoint = { ...f.g.history.checkpoint!, digest: "00000000" };
    await f.g.closeHistory();
    const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
    store.write(f.g.history, start + 30_000);
    await store.close();
    const g = new Governor(APPLY, p, tightened, f.io, paths);
    await g.loadHistory(start + 30_000);
    assertEquals(g.calibration.applied, CALIBRATION.start);
    assertEquals([g.calibration.gap, g.calibration.rulesMismatch], [0, false]);
    await g.closeHistory();
  });
});

Deno.test("a request goes by the pass's clock in taking the last pass's time", async () => {
  const f = fixture(APPLY);
  await f.g.tick();
  await f.advance(30, 0.2);
  const last = f.g.s.at;
  // The wall clock ran 8 seconds while uptime ran 2, so the pass after the request reuses the last
  // full pass and evaluates at its time. The reset takes that time too, not a later one.
  f.elapse(2, 0.2, 0, undefined, 8);
  await f.request("calibration-reset");
  await f.g.tick();
  const reset = f.g.history.calibrations.findLast((d) => d.trigger === "reset")!;
  assertEquals(reset.at, last);
  assertEquals(f.g.history.checkpoint!.at, last);
});
