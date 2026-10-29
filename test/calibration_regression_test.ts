import { assert, assertEquals } from "@std/assert";
import {
  calibrationConfig,
  classifyLimit,
  initialCalibration,
  updateCalibration,
} from "../src/calibration.ts";
import { DAY, emptyHistory, FLAGS, SLOT_MS } from "../src/history.ts";
import { run } from "./sim.ts";
import { at, fit, p, record, slot } from "./calibration-fixture.ts";

const episode = () => record("apply");

Deno.test("off learns from confirmed flat credit caps without a full-bank anchor", async () => {
  const result = await run({ name: "hidden overhead", seed: 1, billMul: 1.12, billAdd: 0.15 });
  assert(result.throttles <= 2, `${result.throttles} limits`);
  assert(result.paused_h < 0.3, `${result.paused_h} paused hours`);
  assert(result.burn_tests <= 12, `${result.burn_tests} lift tests`);
});

Deno.test("credit-band cap variation cannot classify as sustained-use", () => {
  const record = episode();
  record.lift = at + 3_600_000;
  record.recovery = {
    elapsedSeconds: 3300,
    estimatedRecoverySeconds: 3300,
    estimatedPausedSeconds: 0,
  };
  record.caps = [2.7, 2.1].map((busy, i) => ({
    at: at + i * 1_800_000,
    busy,
    demand: 6,
    ceiling: 200,
    pressing: true,
  }));
  assertEquals(classifyLimit(p, record), "credit");
});

Deno.test("CUSUM revert retains a limit's floor correction when the gap stays unchanged", () => {
  const c = calibrationConfig({
    mode: "apply",
    fit: { min_pairs: 2, min_days: 1 },
    cusum: { verify_readings: 1 },
  });
  const h = emptyHistory("k", 1, at);
  const end = at + Math.round(p.recovered / 0.13) * 1000;
  const onset = end + 300_000, lift = onset + 3_600_000, now = lift + 1_200_000;
  for (let t = at; t < now + 3 * 3_600_000; t += SLOT_MS) h.slots.push(slot(t, 4));
  for (let t = at; t <= now - 600_000; t += 1_800_000) h.readings.push({ at: t, v: 4.9 / 8 * 100 });
  h.limits = [{
    ...episode(),
    onset: at - 3_600_000,
    entry: at - 3_500_000,
    lift: at,
    class: "credit",
  }, { ...episode(), onset, entry: onset + 90_000, lift, class: "credit" }];
  const state = initialCalibration(c, at);
  Object.assign(state, {
    fit,
    gap: 0.05,
    applied: { mul: 1.07, add: 0.06, floor: 0.05 },
    pending: {
      at,
      from: { ...c.start },
      gapFrom: 0.05,
      oldFit: fit,
      fit: { ...fit, a: 1.07, aHi: 1.07 },
      hold: { mul: 1.07, add: 0.06, floor: 0.05 },
      readings: 0,
      z: 0,
      verified: false,
      residual: 0,
      n: 0,
    },
    lastPaired: h.readings.at(-1)!.at,
    boundAt: now,
    pendingLimits: [onset],
  });
  const learned = updateCalibration(p, h, state, c, now, 10000).state;
  assert(learned.applied.floor > c.start.floor);
  assertEquals(learned.gap, state.gap);
  const last = h.readings.at(-1)!.at;
  h.readings.push({ at: last + 1_800_000, v: (fit.a * 4 + fit.b) / 8 * 100 });
  const reverted = updateCalibration(p, h, learned, c, last + 1_860_000, 10000).state;
  assert(reverted.applied.floor >= learned.applied.floor);
});

Deno.test("a bad feed that recovers leaves the margin where it was", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  h.slots = Array.from({ length: 280 }, (_, i) => slot(at + i * SLOT_MS, 4));
  const normal = (fit.a * 4 + fit.b) / p.vcpus * 100;
  // Four readings report the whole VM busy, then 78 normal ones follow.
  const all = Array.from({ length: 90 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: i >= 8 && i <= 11 ? 100 : normal,
  }));
  let s = initialCalibration(c, at);
  Object.assign(s, { fit, fitAt: at + 30 * DAY, lastPaired: at });
  const triggers: string[] = [];
  for (let k = 2; k <= all.length; k++) {
    h.readings = all.slice(0, k);
    const r = updateCalibration(p, h, s, c, all[k - 1].at + 60_000, 30000);
    triggers.push(...r.changes.map((d) => d.trigger));
    s = r.state;
  }
  // Before extreme residuals were kept from drift detection, the first one raised the slope to
  // 1.996 and verification kept it for good.
  assertEquals(triggers, ["readings-invalid", "readings-resumed"]);
  assertEquals(s.applied, { ...c.start });
});

Deno.test("a bad feed cannot tighten the margin through the daily refit", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  h.slots = Array.from(
    { length: 280 },
    (_, j) => slot(at + j * SLOT_MS, 3 + (Math.floor(j / 3) + 1) % 3),
  );
  const host = (i: number) => fit.a * (3 + i % 3) + fit.b;
  // Readings 40 to 42 report the whole VM busy; the rest follow box A's relation.
  const all = Array.from({ length: 90 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: i >= 40 && i <= 42 ? 100 : host(i) / p.vcpus * 100,
  }));
  let s = initialCalibration(c, at);
  Object.assign(s, { fit, fitAt: at, lastPaired: at });
  const triggers: string[] = [];
  for (let k = 2; k <= all.length; k++) {
    h.readings = all.slice(0, k);
    const r = updateCalibration(p, h, s, c, all[k - 1].at + 60_000, 30000);
    triggers.push(...r.changes.map((d) => d.trigger));
    s = r.state;
  }
  // The refit runs daily here. It must see the streak marked invalid first, and never fit it.
  assert(triggers.includes("readings-invalid"), triggers.join(" "));
  assertEquals(s.applied, c.start);
});

Deno.test("fresh normal residuals recover from the invalid-reading latch", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("k", 1, at);
  h.slots = Array.from({ length: 18 }, (_, i) => slot(at + i * SLOT_MS, 3 + Math.floor(i / 3) % 3));
  h.readings = Array.from(
    { length: 7 },
    (_, i) => ({ at: at + i * 1_800_000, v: (fit.a * (3 + (i + 2) % 3) + fit.b) / 8 * 100 }),
  );
  const state = initialCalibration(c, at);
  Object.assign(state, {
    fit,
    invalid: true,
    residualInvalid: true,
    extreme: 3,
    apiStaleSince: at,
    lastPaired: at,
  });
  const recovered = updateCalibration(p, h, state, c, at + 10_800_000, 10000);
  assertEquals(recovered.state.invalid, false);
  assertEquals(recovered.state.extreme, 0);
  assertEquals(recovered.changes.map((d) => d.trigger), ["readings-resumed"]);
});

Deno.test("a reading gap is bridged without retrying thousands of certified-full anchors", () => {
  const end = at + 90 * DAY, idleUntil = at + 60 * DAY;
  const h = emptyHistory("8:4.8:34560", 1, at);
  for (let t = at; t < end; t += SLOT_MS) {
    h.slots.push({
      ...slot(t, t < idleUntil ? 0.1 : 5),
      flags: t < idleUntil ? FLAGS.atCapacity : 0,
    });
  }
  const readings = [];
  for (let t = at; t < end; t += 1_800_000) {
    if (t > idleUntil + 3_600_000 && t < idleUntil + 7_320_000) continue;
    readings.push({ at: t, v: (fit.a * (t <= idleUntil ? 0.1 : 5) + fit.b) / 8 * 100 });
  }
  let accesses = 0;
  h.readings = new Proxy(readings, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) accesses++;
      return Reflect.get(target, key, receiver);
    },
  });
  const c = calibrationConfig({ mode: "apply" });
  const result = updateCalibration(p, h, initialCalibration(c, at), c, end, 0);
  // The clamp crosses the gap at the settings in force and stays available after it.
  assert(result.state.estimates.clamp !== null);
  assert(accesses < 100_000, `${accesses} reading accesses across one known gap`);
});

Deno.test("apply acquires a lift anchor and enables its clamp without ever certifying full", async () => {
  const result = await run({
    name: "apply hidden overhead",
    seed: 1,
    billMul: 1.12,
    billAdd: 0.15,
    calibration: { mode: "apply" },
  });
  // Until a fit qualifies on day three, only the floor absorbs this much hidden overhead.
  assert(result.throttles <= 3, `${result.throttles} limits`);
  assert(result.clamp_ticks > 0);
  assertEquals(result.applied.floor, 0.1);
  assert(result.applied.mul >= 1.12, `${result.applied.mul}`);
});

Deno.test("wrong recovery rules are diagnosed even when the meter cannot explain them", async () => {
  const result = await run({
    name: "wrong baseline",
    seed: 1,
    baselineTrue: 0.3,
    limitShare: 0.2,
    calibration: { mode: "apply" },
  });
  assert(result.rules_mismatches > 0);
});
