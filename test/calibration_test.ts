import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  type Bridge,
  calculateEstimates,
  CALIBRATION,
  calibrationConfig,
  type CalibrationState,
  calibrationSummary,
  certifiedAnchors,
  classifyLimit,
  clockBridged,
  creditCap,
  cusumStep,
  diagnoseGap,
  diagnosisEvidence,
  effectiveSettings,
  emptyCusum,
  fitMeter,
  historyAnchors,
  initialCalibration,
  inputsDigest,
  marginFromFit,
  pairLongIntervals,
  pairReadings,
  pairSamples,
  predictRecovery,
  replayOwn,
  replaySettled,
  resetCalibration,
  seeded,
  sigmaAt,
  sustainedRestore,
  tailSlots,
  updateCalibration,
  validateCalibration,
  validCalibrationState,
  withStart,
} from "../src/calibration.ts";
import { boundHistory, DAY, emptyHistory, FLAGS, type History, SLOT_MS } from "../src/history.ts";
import { widen } from "../src/credits.ts";
import { plan } from "../src/plans.ts";
import { at, fit, p, record, slot } from "./calibration-fixture.ts";
import { validateConfig } from "../src/governor.ts";

Deno.test("reading replay conserves charges with irregular intervals and busy-weighted slots", () => {
  const slots = Array.from({ length: 7 }, (_, i) => slot(at + i * SLOT_MS, i % 2 ? 4 : 2));
  // 1,500 and 2,100 seconds at 4 and 2.4 cores: each reading's core-seconds are charged once.
  const readings = [{ at, v: 0 }, { at: at + 1_500_000, v: 50 }, { at: at + 3_600_000, v: 30 }];
  const result = replaySettled(p, readings, slots, { at, balance: 1000, exact: true });
  assert(result.complete);
  assertAlmostEquals(result.charged, 4 * 1500 + 2.4 * 2100, 1e-8);
  assertAlmostEquals(result.balance, 1000 + 4.8 * 3600 - (4 * 1500 + 2.4 * 2100), 1e-8);
  // Partial fill within a reading must clamp before later spending.
  const burst = [slot(at, 0), slot(at + SLOT_MS, 0), slot(at + 2 * SLOT_MS, 8)];
  const r = replaySettled(p, [{ at, v: 0 }, { at: at + 1_800_000, v: 50 }], burst, {
    at,
    balance: p.capacity - 100,
    exact: true,
  });
  assertAlmostEquals(r.balance, p.capacity + p.baseline * 600 - 4 * 1800, 1e-8);
  // Past the last reading a replay stops, unless it asks to bridge the tail as well.
  const anchor = { at, balance: 1000, exact: true }, to = at + 4_200_000;
  const bridge = { fit };
  assertEquals(replaySettled(p, readings, slots, anchor, { to, bridge }).complete, false);
  const tail = replaySettled(p, readings, slots, anchor, { to, bridge, bridgeTail: true });
  assert(tail.complete);
  assertEquals(tail.bridged, 600);
});

Deno.test("reading replay stops at a gap and never treats missing data as idle", () => {
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 10 }, (_, i) => slot(at + i * SLOT_MS, 2));
  h.readings = [{ at, v: 0 }, { at: at + 1_500_000, v: 25 }, { at: at + 5_220_000, v: 25 }];
  const result = replaySettled(p, h.readings, h.slots, { at, balance: 1000, exact: true });
  assertEquals(result.complete, false);
  assertEquals(result.at, at + 1_500_000);
  assertEquals(pairReadings(p, h.readings, h.slots).length, 1);
});

Deno.test("pairing requires coverage and excludes limited, test and invalid clock slots", () => {
  const readings = [{ at, v: 0 }, { at: at + 2_100_000, v: 40 }];
  const slots = Array.from({ length: 4 }, (_, i) => slot(at + i * SLOT_MS, 3));
  assertAlmostEquals(pairReadings(p, readings, slots)[0].own, 3);
  for (const flag of [FLAGS.limited, FLAGS.test, FLAGS.clockInvalid]) {
    assertEquals(pairReadings(p, readings, [{ ...slots[0], flags: flag }, ...slots.slice(1)]), []);
  }
  assertEquals(pairReadings(p, readings, [{ ...slots[0], seconds: 500 }, ...slots.slice(1)]), []);
});

Deno.test("meter fit recovers parameters with deterministic whole-day resampling", () => {
  const pairs = Array.from({ length: 4 * 48 }, (_, i) => {
    const own = 1 + (i % 12) * 0.5;
    return {
      at: at + i * 1_800_000,
      own,
      host: 1.0463 * own + 0.0193 + (Math.floor(i / 12) % 2 ? 0.015 : -0.015),
    };
  });
  const fitted = fitMeter(pairs)!;
  assertAlmostEquals(fitted.a, fit.a, 0.001);
  assertAlmostEquals(fitted.b, fit.b, 0.002);
  assert(fitted.aHi >= fitted.a);
  // Residuals of 0.015 at every load: sigma(u) = sqrt(pi / 2) * 0.015, with no slope.
  assertAlmostEquals(fitted.sigma[0], Math.sqrt(Math.PI / 2) * 0.015, 1e-4);
  assertAlmostEquals(fitted.sigma[1], 0, 1e-4);
  assertEquals(fitMeter(pairs), fitted);
  assertEquals(fitMeter(pairs.map((r) => ({ ...r, own: r.own / 10 }))), null);
  assertEquals(fitMeter(pairs.slice(0, 48)), null);
});

Deno.test("the slope bound resamples at least two days, whole or holding their share of pairs", () => {
  // Day 0 from `from`, day 1 whole, and today until `until`. Day 1's slope is the lowest, so a
  // bound from day 1 alone would equal the overall slope.
  const pairs = (from: number, until: number) =>
    [[from, 24, 1.06], [0, 24, 1.04], [0, until, 1.06]].flatMap(([lo, hi, slope], day) =>
      Array.from({ length: (hi - lo) * 2 }, (_, i) => {
        const own = 3 + (i % 12) * 0.5;
        return { at: at + day * DAY + lo * 3_600_000 + i * 1_800_000, own, host: slope * own };
      })
    );
  // 16 pairs on day 0, a third of the 48 needed, and 8 today: days 0 and 1 to resample.
  const spread = fitMeter(pairs(16, 4))!;
  assert(spread.aHi > spread.a + 0.005, `${spread.aHi} vs ${spread.a}`);
  // Eight on day 0: the 64 pairs on three days qualify, but only day 1 could be resampled.
  assertEquals(fitMeter(pairs(20, 4)), null);
});

Deno.test("whole days without a qualifying pair are not resampled", () => {
  // An apply start on a Thursday: CI load on Thursday, Friday and Monday morning, idle weekend
  // days between. Resampling the idle days drew sets of mostly idle days, whose slope is noise.
  const random = seeded(17 * 104729);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const pairs = Array.from({ length: 4 * 48 + 4 }, (_, i) => {
    const t = at + 10 * 3_600_000 + i * 1_800_000, day = Math.floor((t - at) / DAY);
    const hour = (t - at) % DAY / 3_600_000;
    const ci = (day === 0 || day === 1 || day === 4) && hour >= 6 && hour < 22;
    const own = ci ? Math.max(0.2, 4.5 + 1.5 * normal()) : Math.max(0.02, 0.1 + 0.03 * normal());
    return { at: t, own, host: 1.0463 * own + 0.0193 + (0.0214 + 0.0119 * own) * normal() };
  });
  const fitted = fitMeter(pairs)!;
  // Resampling the weekend set aHi to 1.2323 against an a of 1.0425.
  assert(fitted.aHi < fitted.a + 0.01, `${fitted.aHi} vs ${fitted.a}`);
});

Deno.test("the reference fit's premium gives 0.0373 and the multiplier always rounds upward", () => {
  const c = calibrationConfig({ start: { add: 0 } });
  const settings = marginFromFit(p, fit, 0, { ...c.start }, c);
  assertAlmostEquals(settings.add, 0.0373, 0.0005);
  assertEquals(marginFromFit(p, { ...fit, aHi: 1.05001 }, 0, CALIBRATION.start).mul, 1.051);
  const previous = { mul: 1.1, add: 0.2, floor: 0.08 };
  const next = marginFromFit(p, fit, 0, previous);
  assert(next.mul >= previous.mul && next.add >= previous.add && next.floor >= previous.floor);
});

Deno.test("gap bisection recovers 0.03 using readings after refills", () => {
  const h = emptyHistory("test", 1, at);
  const previous = { ...record(), onset: at - 3_600_000, lift: at, class: "credit" as const };
  h.limits = [previous];
  const end = at + p.recovered / 0.13 * 1000;
  h.slots = Array.from({ length: 100 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  h.readings = Array.from(
    { length: 35 },
    (_, i) => ({ at: at + i * 1_800_000, v: 4.9 / p.vcpus * 100 }),
  );
  const current = { ...record(), onset: end + 300_000 };
  const diagnosis = diagnoseGap(p, h, current, CALIBRATION, 0.167, null);
  assertEquals(diagnosis.source, "readings");
  // Bisection finds 0.03; the reference noise adds its allowance for the reading at t_lo (§6).
  assert(
    diagnosis.gap !== null && diagnosis.gap >= 0.03 && diagnosis.gap <= 0.04,
    `${diagnosis.gap}`,
  );
  const noReadings = diagnoseGap(p, { ...h, readings: [] }, current, CALIBRATION, 0.167, null);
  assertEquals(noReadings.source, "own");
  assert(noReadings.gap !== null && noReadings.gap <= 0.01);
});

Deno.test("a repeat limit while readings are unavailable applies the full own-count result", () => {
  const h = emptyHistory("test", 1, at);
  const previous = { ...record(), onset: at - 3_600_000, lift: at, class: "credit" as const };
  h.limits = [previous];
  // 4.7 cores charged at 1.05x + 0.04 drain 0.175 cores a second against the 4.8-core baseline;
  // reaching zero 30,000 seconds after the lift needs 0.0554 more.
  h.slots = Array.from({ length: 60 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  const current = { ...record(), onset: at + 30_300_000 };
  const capped = diagnoseGap(p, h, current, CALIBRATION, 0.167, null, { useReadings: false });
  assertEquals(capped.source, "own");
  assertAlmostEquals(capped.gap!, 0.01, 1e-9);
  const full = diagnoseGap(p, h, current, CALIBRATION, 0.167, null, {
    useReadings: false,
    fullOwnStep: true,
  });
  // The whole span is estimated time: hold_sigmas reference sigmas at 4.7 cores on top, two by
  // default, against the three permanent learning takes.
  const sigma = CALIBRATION.sigma_ref[0] + CALIBRATION.sigma_ref[1] * 4.7;
  // Learning keeps only the capped step; the full result is for the temporary hold.
  assertAlmostEquals(full.gap!, 0.01, 1e-9);
  assertAlmostEquals(full.held!, p.recovered / 30_000 - 0.175 + 2 * sigma, 1e-3);
});

Deno.test("a repeat while readings are unavailable raises the temporary hold until they resume", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 60 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  const onset = at + 30_300_000, lift = onset + 3_600_000;
  const current = {
    ...record("apply"),
    onset,
    entry: onset + 90_000,
    lift,
    class: "credit" as const,
  };
  const run = (previousOnset: number) => {
    h.limits = [
      { ...record("apply"), onset: previousOnset, entry: previousOnset + 90_000, lift: at },
      current,
    ].map((l) => ({ ...l, class: "credit" as const }));
    const s = initialCalibration(c, at - 30 * DAY);
    s.pendingLimits = [onset];
    // No readings arrive: after the stale pause the guest's own count stands in.
    return updateCalibration(p, h, s, c, lift + 7_200_000, 10000).state;
  };
  const repeat = run(at - 3_600_000);
  // Learning keeps the capped step; the full own-count result goes to the hold.
  assertAlmostEquals(repeat.gap, 0.01, 1e-9);
  assert(repeat.ownHold !== null && repeat.ownHold.gap > 0.2, `${repeat.ownHold?.gap}`);
  assert(effectiveSettings(repeat).add > repeat.applied.add + 0.2);
  // The hold explains the limit, so the floor stays. Replayed at the learned margin alone, the
  // optimism the hold covers raised it to 8.9%.
  assertEquals(repeat.applied.floor, c.start.floor);
  // Fresh settled readings end it: the refit owns the meter side from then.
  const now = lift + 9_000_000;
  h.readings = [2, 1, 0].map((i) => ({ at: now - 60_000 - i * 1_800_000, v: 4.9 / 8 * 100 }));
  const resumed = updateCalibration(p, h, repeat, c, now, 10000);
  assertEquals(resumed.state.ownHold, null);
  assertEquals(resumed.state.applied, repeat.applied);
  assert(resumed.changes.some((d) => d.trigger === "readings-resumed"));
  h.readings = [];
  const single = run(at - 8 * DAY);
  assertAlmostEquals(single.gap, 0.01, 1e-9);
  assertEquals(single.ownHold, null);
  // Without a repeat, the capped step leaves optimism nothing in force explains. With no readings,
  // that raise waits for them to show whether the meter changed.
  assert(single.applied.floor > c.start.floor + 0.01, `${single.applied.floor}`);
  assertEquals(single.provisionalFloor, c.start.floor);
});

Deno.test("a limit's entry slot still earns before the limit began", () => {
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  h.slots = Array.from({ length: 100 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  h.readings = Array.from(
    { length: 35 },
    (_, i) => ({ at: at + i * 1_800_000, v: 4.9 / p.vcpus * 100 }),
  );
  // The diagnosis replays to 100 seconds into slot 88; the limit enters at 490 seconds, and the
  // governor flags the slot from its start.
  const onset = at + 88 * SLOT_MS + 400_000;
  const current = { ...record(), onset, entry: onset + 90_000 };
  const unflagged = diagnoseGap(p, h, current, CALIBRATION, 0.167, null);
  h.slots[88] = { ...h.slots[88], flags: FLAGS.limited | FLAGS.pressing };
  assertEquals(diagnoseGap(p, h, current, CALIBRATION, 0.167, null), unflagged);
});

Deno.test("a sustained-use restore comes from the own count, so a box without readings restores", () => {
  // Two hours limited and pressing at one core, then two hours earning at the start margin.
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from(
    { length: 24 },
    (_, i) => slot(at + i * SLOT_MS, 1, i < 12 ? FLAGS.limited | FLAGS.pressing : 0),
  );
  const limit = {
    ...record(),
    balance: 10000,
    lift: at + 7_200_000,
    class: "sustained-use" as const,
  };
  const s = initialCalibration(CALIBRATION, at - 30 * DAY);
  const restored = sustainedRestore(p, h, limit, s, at + 4 * 3_600_000, CALIBRATION.start);
  // Pressing slots don't earn; from the lift each second earns the baseline and pays 1.09 cores.
  assertAlmostEquals(restored!, 10000 - 1.09 * 7110 + (p.baseline - 1.09) * 7200, 1e-6);
});

Deno.test("classification distinguishes the credit cap and a falling sustained-use cap", () => {
  const credit = record();
  credit.caps = [0, 1, 2].map((i) => ({
    at: at + i * 1_800_000,
    busy: 2.4,
    demand: 6,
    ceiling: 200,
    pressing: true,
  }));
  assertEquals(classifyLimit(p, credit), "credit");
  // Classification adds to the confirmation: a first test that passed never makes a credit limit.
  assertEquals(classifyLimit(p, { ...credit, confirmed: false, firstTest: "lifted" }), "unknown");
  const sustained = {
    ...credit,
    caps: [6, 4, 2].map((busy, i) => ({ ...credit.caps[0], at: at + i * 3_600_000, busy })),
  };
  assertEquals(classifyLimit(p, sustained), "sustained-use");
  assertEquals(classifyLimit(p, { ...credit, caps: [] }), "unknown");
  // Without pressing caps, the first test's burner delivery stands in for the cap.
  assertEquals(
    classifyLimit(p, { ...credit, caps: [], testDelivery: { busy: 2.3, demand: 5 } }),
    "credit",
  );
  // A flat cap below the pinned limit fits harsher real rules; readings decide what it teaches.
  const low = { ...credit, caps: credit.caps.map((x) => ({ ...x, busy: 1.6 })) };
  assertEquals(creditCap(p, low), "low");
  assertEquals(classifyLimit(p, low), "credit");
  // A cap between the credit band and the sustained-use threshold is neither.
  const between = { ...credit, caps: credit.caps.map((x) => ({ ...x, busy: 3.2 })) };
  assertEquals(classifyLimit(p, between), "unknown");
  // A high first cap is sustained use, even when a later cap reaches the credit band.
  const late = {
    ...credit,
    caps: [4, 2.4].map((busy, i) => ({ ...credit.caps[0], busy, at: at + i })),
  };
  assertEquals(classifyLimit(p, late), "sustained-use");
  // KVM 2: 45% of two vCPUs is 0.9 cores; the credit band is 0.6 plus or minus 0.3.
  const kvm2 = plan(2);
  const small = { ...credit, caps: credit.caps.map((x) => ({ ...x, busy: 0.6, demand: 1.5 })) };
  assertEquals(classifyLimit(kvm2, small), "credit");
  const falling = {
    ...small,
    caps: [0.85, 0.6, 0.35].map((busy, i) => ({ ...small.caps[0], busy, at: at + i * 1_800_000 })),
  };
  assertEquals(classifyLimit(kvm2, falling), "sustained-use");
  // KVM 1: 20% an hour is 0.1 cores between rows, inside a flat credit cap's noise; a fall must
  // also leave the band's width.
  const kvm1 = plan(1);
  const noisy = {
    ...credit,
    caps: [0.45, 0.35].map((busy, i) => ({
      ...credit.caps[0],
      busy,
      demand: 1,
      at: at + i * 1_800_000,
    })),
  };
  assertEquals(classifyLimit(kvm1, noisy), "credit");
});

Deno.test("one-sided CUSUM stays quiet for 28 seeded days of correlated noise with daily wobble and detects a 2 sigma shift", () => {
  let state = emptyCusum();
  let previous = 0, day = 0;
  const random = seeded(13);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  for (let i = 0; i < 28 * 48; i++) {
    const u = 4;
    // Box A's day-level means stay within about 0.02 cores at CI load.
    if (i % 48 === 0) day = 0.01 * normal();
    const innovation = normal();
    const z = (innovation - 0.18 * previous) / Math.sqrt(1 + 0.18 ** 2);
    previous = innovation;
    const residual = day + z * (fit.sigma[0] + fit.sigma[1] * u);
    state = cusumStep(
      state,
      { at: at + i * 1_800_000, own: u, host: fit.a * u + fit.b + residual },
      fit,
    );
    assertEquals(state.alarm, false);
  }
  let alarm = 0;
  for (let i = 1; i <= 12; i++) {
    // A 2 sigma shift on top of the same noise.
    state = cusumStep(state, {
      at: at + i * 1_800_000,
      own: 4,
      host: fit.a * 4 + fit.b + (2 + normal()) * (fit.sigma[0] + fit.sigma[1] * 4),
    }, fit);
    if (state.alarm) {
      alarm = i;
      break;
    }
  }
  assert(alarm > 0 && alarm <= 12);
});

Deno.test("the stale fallback holds the margin without changing learned settings", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  const previous = initialCalibration(c, at);
  previous.estimates = { open: 1234, acted: 1234, clamp: null, track: null };
  const before = structuredClone(previous);
  const result = updateCalibration(p, h, previous, c, at + DAY, 1234);
  assertEquals(previous, before);
  assertEquals(result.state.applied, c.start);
  assertEquals(effectiveSettings(result.state), { ...c.start, add: 0.08 });
  assertEquals(result.state.hold?.reason, "stale");
  assertEquals(result.state.estimates.acted, 1234);
  assertEquals(result.changes.map((r) => r.trigger), ["stale-fallback"]);
  assertEquals(updateCalibration(p, h, previous, c, at + DAY, 1234), result);
});

Deno.test("the stale hold ends when settled readings resume and leaves learned settings", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  const s = initialCalibration(c, at);
  s.applied = { mul: 1.07, add: 0.06, floor: 0.06 };
  const held = updateCalibration(p, h, s, c, at + DAY, 1000).state;
  assertEquals(effectiveSettings(held), { mul: 1.07, add: 0.08, floor: 0.06 });
  h.slots = Array.from({ length: 6 }, (_, i) => slot(at + DAY + i * SLOT_MS, 3));
  h.readings = [{ at: at + DAY, v: 40 }, { at: at + DAY + 1_800_000, v: 40 }];
  const resumed = updateCalibration(p, h, held, c, at + DAY + 3_600_000, 1000);
  assertEquals(resumed.state.hold, null);
  assertEquals(effectiveSettings(resumed.state), s.applied);
  assertEquals(resumed.changes.map((d) => d.trigger), ["readings-resumed"]);
});

Deno.test("readings at invalid spacing for most of a day reach the 24-hour fallback", () => {
  for (const spacing of [600_000, 6_000_000]) {
    const c = calibrationConfig({ mode: "apply" });
    const h = emptyHistory("test", 1, at);
    let s = initialCalibration(c, at);
    const triggers: string[] = [];
    // Each fetch brings a new settled reading, so the readings are fresh but never usable.
    for (let now = at + 1_800_000; now <= at + 3 * DAY; now += 1_800_000) {
      h.readings = Array.from(
        { length: Math.floor((now - at) / spacing) },
        (_, i) => ({ at: at + i * spacing, v: 20 }),
      );
      const result = updateCalibration(p, h, s, c, now, 1000);
      s = result.state;
      triggers.push(...result.changes.map((d) => d.trigger));
    }
    assertEquals(triggers.filter((t) => t === "readings-invalid").length, 1, `${spacing}`);
    assertEquals(triggers.filter((t) => t === "stale-fallback").length, 1, `${spacing}`);
    assertEquals(s.hold?.reason, "invalid");
    assertEquals(effectiveSettings(s).add, 0.08);
  }
});

Deno.test("configuration validates calibration types, ranges and optional recovery period", () => {
  validateConfig({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply", start: { floor: 0.05 } },
    recovery: { quota_period_ms: 10 },
  });
  // Apply without readings would run its start settings, then the stale fallback, unchecked.
  assertThrows(() => validateConfig({ calibration: { mode: "apply" } }), Error, "vm_id");
  // And without a token source or broker it would never get them.
  assertThrows(
    () => validateConfig({ hostinger: { vm_id: 1 }, calibration: { mode: "apply" } }),
    Error,
    "token source",
  );
  validateConfig({ calibration: { mode: "shadow" } });
  for (
    const calibration of [
      { start: { mul: 0.9 } },
      { start: { add: 0.6 } },
      { floor_max: 0.3 },
      {
        stale: { pause_s: -1 },
      },
      { cusum: { verify_readings: 1.5 } },
      { learning: { confirm_days: 91 } },
      {
        learning: { plausible_extra: 2 },
      },
    ]
  ) assertThrows(() => validateConfig({ calibration }));
  // A misspelt setting would leave its default in force without a word.
  for (const calibration of [{ gap_strat: 0.1 }, { clamp: { enabeld: false } }]) {
    assertThrows(
      () => validateConfig({ calibration } as Parameters<typeof validateConfig>[0]),
      Error,
      "is not a setting",
    );
  }
  // Names every object has are not settings either.
  assertThrows(
    () =>
      validateConfig(
        { calibration: { constructor: 1 } } as unknown as Parameters<typeof validateConfig>[0],
      ),
    Error,
    "is not a setting",
  );
  // A start floor above floor_max names the start floor.
  assertThrows(
    () => validateConfig({ calibration: { start: { floor: 0.2 } } }),
    Error,
    "start.floor must be at most floor_max",
  );
  // So would one outside calibration.
  for (
    const config of [
      { readings: { use_newst: true } },
      { recovery: { quota_period: 10 } },
      { hostinger: { vm_id: 1, token_flie: "/etc/governor/hostinger-token" } },
      { tick_second: 30 },
    ]
  ) {
    assertThrows(
      () => validateConfig(config as Parameters<typeof validateConfig>[0]),
      Error,
      "is not a setting",
    );
  }
});

Deno.test("readings can lower the acted estimate but never raise it above the open estimate", () => {
  const c = calibrationConfig({ mode: "apply" });
  for (const cores of [8, 0]) {
    const h = emptyHistory("test", 1, at);
    h.limits = [{
      ...record(),
      onset: at - 3_600_000,
      entry: at - 3_500_000,
      lift: at,
      class: "credit",
    }];
    h.slots = Array.from({ length: 12 }, (_, i) => slot(at + i * SLOT_MS, cores));
    h.readings = Array.from(
      { length: 5 },
      (_, i) => ({ at: at + i * 1_800_000, v: cores / 8 * 100 }),
    );
    const estimates = updateCalibration(p, h, initialCalibration(c, at), c, at + 7_200_000, 20000)
      .state.estimates;
    assert(estimates.clamp !== null);
    // Eight busy cores drain the lift's 20% bank; an idle box would fill it past the open estimate.
    assertEquals(estimates.acted, cores ? estimates.clamp + 0.025 * p.capacity : 20000);
    assert(estimates.acted <= estimates.open);
  }
});

Deno.test("a later full-bank sync resets the no-limit bound's denominator", () => {
  const c = calibrationConfig({ mode: "shadow" });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from(
    { length: 5 * 144 },
    (_, i) => slot(at + i * SLOT_MS, 0.2, FLAGS.atCapacity),
  );
  h.readings = Array.from({ length: 5 * 48 }, (_, i) => ({ at: at + i * 1_800_000, v: 2.5 }));
  const s = initialCalibration(c, at);
  const result = updateCalibration(p, h, s, c, at + 5 * DAY, p.capacity);
  assertEquals(result.state.gapUpperBound, 0.167);
});

Deno.test("a full bank stays certified only while its lower bound stays at capacity", () => {
  // At 0.2 cores, the spare after the 0.167-core bound fills the bank in 14 slots.
  const idle = Array.from(
    { length: 20 },
    (_, i) => slot(at + i * SLOT_MS, 0.2, FLAGS.atCapacity),
  );
  // Still at capacity by the governor's charge, but draining once the bound is billed on top.
  const busy = Array.from(
    { length: 5 },
    (_, i) => slot(at + (20 + i) * SLOT_MS, 4.5, FLAGS.atCapacity),
  );
  const anchors = certifiedAnchors(p, [...idle, ...busy], 0.167);
  assertEquals(anchors.length, 7);
  assertEquals(anchors.at(-1)?.at, at + 20 * SLOT_MS);
});

Deno.test("the no-limit bound forgives shortfalls that a full bank refilled", () => {
  // A certified full bank, then two days of 12 busy hours draining 0.4 cores a second and 12 idle
  // hours that refill it. Only a gap above 0.4 cores could have emptied it within a busy half day.
  const blocks = [[15, 0.2, FLAGS.atCapacity], [72, 5.2, 0], [72, 0.2, 0], [72, 5.2, 0], [
    72,
    0.2,
    0,
  ]];
  const h = emptyHistory("test", 1, at);
  for (const [count, cores, flags] of blocks) {
    for (let i = 0; i < count; i++) h.slots.push(slot(at + h.slots.length * SLOT_MS, cores, flags));
  }
  h.readings = Array.from({ length: h.slots.length / 3 + 1 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: i ? h.slots[3 * i - 1].busy / 600 / p.vcpus * 100 : 0,
  }));
  const c = calibrationConfig({ mode: "shadow" });
  const end = at + h.slots.length * SLOT_MS;
  const result = updateCalibration(p, h, initialCalibration(c, at), c, end, p.capacity);
  assertAlmostEquals(result.state.gapUpperBound, 0.4, 0.001);
});

Deno.test("CUSUM verification keeps a persistent shift and withdraws an unverified proposal", () => {
  for (const shift of [0, 1]) {
    const c = calibrationConfig({
      mode: "shadow",
      fit: { min_pairs: 2, min_days: 1 },
      cusum: { verify_readings: 1 },
    });
    const h = emptyHistory("test", 1, at);
    h.slots = Array.from({ length: 6 }, (_, i) => slot(at + i * SLOT_MS, i < 3 ? 3 : 4));
    h.readings = [{ at, v: 0 }, { at: at + 1_800_000, v: (fit.a * 3 + fit.b) / 8 * 100 }, {
      at: at + 3_600_000,
      v: (fit.a * 4 + fit.b + shift * (fit.sigma[0] + fit.sigma[1] * 4)) / 8 * 100,
    }];
    const s = initialCalibration(c, at);
    s.fit = fit;
    s.lastPaired = at + 1_800_000;
    const hold = { mul: 1.07, add: 0.06, floor: 0.05 };
    s.pending = {
      at: at + 1_800_000,
      from: { ...c.start },
      gapFrom: c.gap_start,
      oldFit: fit,
      fit: { ...fit, a: 1.07, aHi: 1.07 },
      hold,
      readings: 0,
      z: 0,
      verified: false,
      residual: 0,
      n: 0,
    };
    const result = updateCalibration(p, h, s, c, at + 3_600_000, 1000);
    // Neither outcome touches the learned settings: a kept change holds until a fit on the readings
    // after it qualifies, and a withdrawn one leaves nothing behind.
    assertEquals(result.state.applied, c.start);
    assertEquals(result.state.pending?.verified ?? null, shift ? true : null);
    assertEquals(effectiveSettings(result.state), shift ? hold : c.start);
    assert(result.changes.some((d) => d.trigger === (shift ? "cusum-keep" : "cusum-revert")));
  }
});

Deno.test("a failed CUSUM verification keeps the whole rules-mismatch fallback", () => {
  const c = calibrationConfig({
    mode: "shadow",
    start: { mul: 1.02 },
    fit: { min_pairs: 2, min_days: 1 },
    cusum: { verify_readings: 1 },
  });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 6 }, (_, i) => slot(at + i * SLOT_MS, i < 3 ? 3 : 4));
  h.readings = [{ at, v: 0 }, { at: at + 1_800_000, v: (fit.a * 3 + fit.b) / 8 * 100 }, {
    at: at + 3_600_000,
    v: (fit.a * 4 + fit.b) / 8 * 100,
  }];
  const s = initialCalibration(c, at);
  Object.assign(s, {
    fit,
    lastPaired: at + 1_800_000,
    rulesMismatch: true,
    applied: { mul: 1.07, add: 0.08, floor: 0.05 },
    pending: {
      at,
      from: { ...c.start },
      gapFrom: c.gap_start,
      oldFit: fit,
      fit: { ...fit, a: 1.1, aHi: 1.1 },
      hold: { mul: 1.1, add: 0.08, floor: 0.05 },
      readings: 0,
      z: 0,
      verified: false,
      residual: 0,
      n: 0,
    },
  });
  const result = updateCalibration(p, h, s, c, at + 3_600_000, 1000);
  assert(result.changes.some((d) => d.trigger === "cusum-revert"));
  assert(result.state.applied.mul >= 1.05 && result.state.applied.add >= 0.08);
});

Deno.test("gap learning waits for the reading that covers t_lo, then falls back to own charges", () => {
  const c = calibrationConfig({ mode: "apply" });
  const end = at + p.recovered / 0.13 * 1000;
  const onset = end + 300_000, lift = onset + 3_600_000;
  const h = emptyHistory("test", 1, at);
  h.limits = [
    { ...record(), onset: at - 3_600_000, entry: at - 3_500_000, lift: at, class: "credit" },
    { ...record(), onset, entry: onset + 90_000, lift, class: "credit" },
  ];
  h.slots = Array.from({ length: 130 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  const readings = Array.from(
    { length: 40 },
    (_, i) => ({ at: at + i * 1_800_000, v: 4.9 / p.vcpus * 100 }),
  );
  const s = initialCalibration(c, at);
  s.pendingLimits = [onset];
  // At the lift the settled readings still end before t_lo.
  h.readings = readings.filter((r) => r.at < end - 1_800_000);
  const early = updateCalibration(p, h, s, c, lift + 600_000, 10000);
  assertEquals(early.state.pendingLimits, [onset]);
  assert(!early.changes.some((d) => d.trigger === "limit-diagnosis"));
  // Once they cover it, the readings replay learns the full gap.
  h.readings = readings.filter((r) => r.at <= lift);
  const covered = updateCalibration(p, h, early.state, c, lift + 1_200_000, 10000);
  const learned = covered.limits.find((l) => l.onset === onset)?.diagnosis;
  assertEquals(learned?.source, "readings");
  assert(covered.state.gap >= 0.03 && covered.state.gap <= 0.04, `${covered.state.gap}`);
  // Readings that never arrive give way to own charges after the stale pause.
  h.readings = readings.filter((r) => r.at < end - 1_800_000);
  const stale = updateCalibration(p, h, early.state, c, lift + 7_200_000, 10000);
  assertEquals(stale.limits.find((l) => l.onset === onset)?.diagnosis?.source, "own");
  assert(stale.state.gap <= 0.01);
  // The capped step faces only the whole-core bound: from a gap already at gap_max it raises the
  // gap past it without latching a rules mismatch.
  const atMax = calibrationConfig({ mode: "apply", gap_start: 0.2, gap_max: 0.2 });
  // At 4.6 cores the own charges alone don't empty the bank by t_lo, so the step is positive.
  const h2 = {
    ...h,
    limits: h.limits.map((l) => ({ ...l, gap: 0.2 })),
    slots: h.slots.map((x) => slot(x.at, 4.6)),
  };
  const s2 = { ...initialCalibration(atMax, at), pendingLimits: [onset] };
  assertEquals(s2.gap, 0.2);
  const own = updateCalibration(p, h2, s2, atMax, lift + 7_200_000, 10000);
  assertEquals(own.limits.find((l) => l.onset === onset)?.diagnosis?.source, "own");
  assertEquals(own.state.rulesMismatch, false);
  assert(own.state.gap > 0.2, `${own.state.gap}`);
});

Deno.test("the lift check compares recovery with the readings and latches after two mismatches", () => {
  const c = calibrationConfig({ mode: "shadow" });
  const h = emptyHistory("test", 1, at);
  // Readings of 2.4 cores earn 2.4 cores a second: 6,912 core-seconds in 2,880 seconds.
  const lifts = [at + 3 * 2_880_000, at + DAY + 3 * 2_880_000];
  h.limits = lifts.map((lift, i) => ({
    ...record(),
    onset: at + i * DAY,
    entry: at + i * DAY + 90_000,
    lift,
    class: "credit" as const,
  }));
  h.slots = Array.from(
    { length: 2 * 144 },
    (_, i) => slot(at + i * SLOT_MS, 2.4, FLAGS.limited),
  );
  h.readings = Array.from({ length: 2 * 48 + 1 }, (_, i) => ({ at: at + i * 1_800_000, v: 30 }));
  const result = updateCalibration(p, h, initialCalibration(c, at - DAY), c, at + 2 * DAY, 0);
  assertAlmostEquals(result.limits[0].liftCheck!.predicted!, 2880, 1);
  assertAlmostEquals(result.limits[0].liftCheck!.ratio!, 3, 0.01);
  const mismatches = result.changes.filter((d) => d.trigger === "rules-mismatch");
  assertEquals(mismatches.map((d) => d.inputs.latched), [false, true]);
  assert(result.state.rulesMismatch);
  assertEquals(effectiveSettings(result.state).add, 0.08);
  // A limit the readings never reached has no prediction, so one mismatch cannot latch.
  const unread = updateCalibration(
    p,
    { ...h, readings: h.readings.slice(0, 4) },
    initialCalibration(c, at - DAY),
    c,
    at + 2 * DAY,
    0,
  );
  assertAlmostEquals(unread.limits[0].liftCheck!.predicted!, 2880, 1);
  // Readings for the second recovery may still arrive; the check waits for them.
  assertEquals(unread.limits.length, 1);
  assert(!unread.state.rulesMismatch);
  h.limits[0].liftCheck = unread.limits[0].liftCheck;
  const late = updateCalibration(p, h, unread.state, c, at + 2 * DAY + 600_000, 0);
  assertEquals(late.changes.filter((d) => d.trigger === "rules-mismatch").length, 1);
  assert(late.state.rulesMismatch);
  // Once latched, a further mismatch is logged under the latch and does not alert again.
  const third = at + 2 * DAY;
  const h3 = {
    ...h,
    limits: [
      ...h.limits.map((l) => ({
        ...l,
        liftCheck: late.limits.find((u) => u.onset === l.onset)?.liftCheck ?? l.liftCheck,
      })),
      {
        ...record(),
        onset: third,
        entry: third + 90_000,
        lift: third + 3 * 2_880_000,
        class: "credit" as const,
      },
    ],
    slots: Array.from({ length: 3 * 144 }, (_, i) => slot(at + i * SLOT_MS, 2.4, FLAGS.limited)),
    readings: Array.from({ length: 3 * 48 + 1 }, (_, i) => ({ at: at + i * 1_800_000, v: 30 })),
  };
  const after = updateCalibration(p, h3, late.state, c, at + 3 * DAY, 0);
  const further = after.changes.filter((d) => d.trigger === "rules-mismatch");
  assertEquals(further.map((d) => [d.inputs.mismatches, d.inputs.latched]), [[3, false]]);
});

Deno.test("readings drift detection marks invalid are bridged with the governor's own charge", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  h.slots = Array.from({ length: 70 }, (_, i) => slot(at + i * SLOT_MS, 4));
  const normal = (fit.a * 4 + fit.b) / p.vcpus * 100;
  // Readings 8 to 11 report the whole VM busy: a feed inflated far beyond 6 sigma.
  const inflated = (i: number) => i >= 8 && i <= 11;
  h.readings = Array.from({ length: 20 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: inflated(i) ? 100 : normal,
  }));
  const now = h.readings.at(-1)!.at + 60_000;
  const s = initialCalibration(c, at);
  Object.assign(s, { fit, fitAt: now, lastPaired: at });
  const first = updateCalibration(p, h, s, c, now, 30000);
  const opened = first.state;
  // The span keeps the learned state it opened on, for a corroborated resume to start from.
  assertEquals(opened.invalidSpans, [
    { from: h.readings[8].at, to: null, applied: s.applied, gap: s.gap },
  ]);
  // Drift detection never sees an extreme residual, so the feed cannot tighten the margin.
  assertEquals(first.changes.map((d) => d.trigger), ["readings-invalid"]);
  assertEquals(opened.applied, s.applied);
  // Three normal residuals close the span at the first of them.
  const closed = updateCalibration(p, h, opened, c, now + 60_000, 30000).state;
  assertEquals(closed.invalidSpans, [{ from: h.readings[8].at, to: h.readings[12].at }]);
  assert(!closed.residualInvalid);
  const estimate = (state: typeof closed, readings = h.readings) =>
    calculateEstimates(p, { ...h, readings }, { ...state, replayBase: null }, c, now, 30000).clamp!;
  const unmarked = { ...closed, invalidSpans: [] };
  const clean = estimate(unmarked, h.readings.map((r) => ({ ...r, v: normal })));
  // Bridged with 1.05x + 0.04, the inflated stretch costs about what normal readings would.
  assertAlmostEquals(estimate(closed), clean, 500);
  // Consumed, it would pin the clamp more than 15,000 core-seconds low.
  assert(estimate(unmarked) < clean - 15000);
});

Deno.test("an extreme residual never counts toward drift verification", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 30 }, (_, i) => slot(at + i * SLOT_MS, 4));
  const normal = (fit.a * 4 + fit.b) / p.vcpus * 100;
  // Two inflated readings, one short of marking the readings invalid.
  h.readings = Array.from({ length: 9 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: i === 3 || i === 4 ? 100 : normal,
  }));
  const s = initialCalibration(c, at);
  const pending = {
    at,
    from: { ...s.applied },
    gapFrom: s.gap,
    oldFit: fit,
    fit,
    hold: { ...s.applied },
    readings: 0,
    z: 0,
    verified: false,
    residual: 0,
    n: 0,
  };
  Object.assign(s, { fit, fitAt: at + DAY, lastPaired: at, pending });
  const next = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000).state;
  assertEquals(next.pending?.readings, 6);
  assertAlmostEquals(next.pending!.z, 0, 1e-6);
  assert(!next.invalid);
});

Deno.test("tracking bridges a reading gap with the fitted meter, without the premium", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  h.slots = Array.from({ length: 40 }, (_, i) => slot(at + i * SLOT_MS, 4));
  const v = (fit.a * 4 + fit.b) / p.vcpus * 100;
  // Reading 4 is missing: 3,600 seconds that both replays bridge.
  h.readings = Array.from({ length: 11 }, (_, i) => ({ at: at + i * 1_800_000, v }))
    .filter((_, i) => i !== 4);
  const now = h.readings.at(-1)!.at + 60_000;
  const s = initialCalibration(c, at - DAY);
  Object.assign(s, { fit, fitAt: now, lastPaired: now });
  const base = updateCalibration(p, h, s, c, now, 30000).state.replayBase!;
  // The clamp bills 1.05 x 4 + 0.04 across the gap; tracking bills the fit's 1.0463 x 4 + 0.0193.
  const margin = 1.05 * 4 + 0.04, meter = fit.a * 4 + fit.b;
  assertAlmostEquals(base.track! - base.balance, 3600 * (margin - meter), 1);
});

Deno.test("time the daemon did not watch never pairs with a reading", () => {
  const readings = [{ at, v: 50 }, { at: at + 1_800_000, v: 50 }];
  const slots = [0, 1, 2].map((i) => slot(at + i * SLOT_MS, 4));
  assertEquals(pairReadings(p, readings, slots, []).length, 1);
  const stopped = slots.map((x) => ({ ...x, flags: FLAGS.unobserved | FLAGS.noEarn }));
  assertEquals(pairReadings(p, readings, stopped, []).length, 0);
  // One sample after a stop spreads its average over the whole interval.
  const sample = (unobserved: boolean) => ({
    at: at + 1_800_000,
    busy: 0.5,
    steal: 0,
    seconds: 1800,
    ...(unobserved ? { unobserved } : {}),
  });
  assertEquals(pairSamples(p, readings, [sample(false)]).length, 1);
  assertEquals(pairSamples(p, readings, [sample(true)]).length, 0);
});

Deno.test("the lift check predicts nothing from the load a lift released", () => {
  const c = calibrationConfig({ mode: "shadow" });
  const h = emptyHistory("test", 1, at);
  const lift = at + 2_880_000;
  h.limits = [{ ...record(), lift, class: "credit" }];
  // 2.6 cores while limited leave the replay at 6,336 of 6,912 core-seconds at the lift. After it, 7
  // cores drain the bank for four hours, and a lull at 0.4 cores refills it: a replay that ran on
  // would reach the lift point 18,851 seconds after onset.
  const cores = (t: number) => t <= 2_880_000 ? 2.6 : t <= 17_280_000 ? 7 : 0.4;
  const times = [0, 1_800_000, 2_880_000];
  while (times.at(-1)! < 30_000_000) times.push(times.at(-1)! + 1_800_000);
  h.readings = times.map((t) => ({ at: at + t, v: cores(t) / p.vcpus * 100 }));
  h.slots = Array.from({ length: 50 }, (_, i) => {
    const t = i * SLOT_MS;
    return slot(at + t, cores(t + SLOT_MS), t < 2_880_000 ? FLAGS.limited : 0);
  });
  const result = updateCalibration(p, h, initialCalibration(c, at - DAY), c, at + DAY, 0);
  assertEquals(result.limits[0].liftCheck, { at: at + DAY, predicted: null, ratio: null });
  assert(!result.changes.some((d) => d.trigger === "rules-mismatch"));
});

Deno.test("a flat low cap that needs an implausible gap is a rules mismatch and learns with widen", () => {
  const c = calibrationConfig({ mode: "apply" });
  const end = at + p.recovered / 0.6 * 1000;
  const onset = end + 300_000, lift = onset + 3_600_000;
  const low = (at: number) => ({ at, busy: 1.6, demand: 5, ceiling: 140, pressing: true });
  const h = emptyHistory("test", 1, at);
  h.limits = [
    { ...record(), onset: at - 3_600_000, entry: at - 3_500_000, lift: at, class: "credit" },
    { ...record(), onset, entry: onset + 90_000, lift, class: "credit", caps: [low(onset)] },
  ];
  // Readings of 4.9 cores against a guest count of 4.3: billing runs half a core above them.
  h.slots = Array.from({ length: 60 }, (_, i) => slot(at + i * SLOT_MS, 4.3));
  h.readings = Array.from({ length: 20 }, (_, i) => ({ at: at + i * 1_800_000, v: 4.9 / 8 * 100 }));
  const s = initialCalibration(c, at);
  s.pendingLimits = [onset];
  const result = updateCalibration(p, h, s, c, lift + 600_000, 10000);
  assert(result.state.rulesMismatch);
  assertEquals(result.state.gap, 0);
  // The mismatch decision carries the latch and the fallback, as a lift check's does. The diagnosis
  // changes nothing itself, so apply fires the rules-mismatch hook alone.
  const diagnosed = result.changes.find((d) => d.trigger === "limit-diagnosis")!;
  const latching = result.changes.find((d) => d.trigger === "rules-mismatch")!;
  assertEquals(diagnosed.from, diagnosed.to);
  assertEquals(latching.to, effectiveSettings(result.state));
  assert(latching.to.add > latching.from.add);
  assertEquals(
    result.changes.filter((d) => d.trigger === "rules-mismatch").map((d) => d.inputs.cap),
    ["low"],
  );
  const widened = widen({ mul: 1.05, add: 0.08 }, 5000, 50000);
  assertEquals(result.state.applied.mul, widened.mul);
  assertEquals(result.state.applied.add, widened.add);
  // Under the latch, the next mismatch is still logged, without alerting.
  const again = updateCalibration(
    p,
    h,
    { ...result.state, pendingLimits: [onset] },
    c,
    lift + 1_200_000,
    10000,
  );
  const mismatches = [...result.changes, ...again.changes].filter((d) =>
    d.trigger === "rules-mismatch"
  );
  assertEquals(mismatches.map((d) => d.inputs.latched), [true, false]);
  // Status lists every logged mismatch, alerting or not.
  const calibrations = mismatches.map((d, i) => ({
    ...d,
    at: lift + i,
    digest: "0",
    mode: "apply" as const,
  }));
  const status = calibrationSummary(c, again.state, { ...h, calibrations });
  assertEquals(status.mismatches.map((m) => [m.kind, m.onset, m.latched]), [
    ["gap", onset, true],
    ["gap", onset, false],
  ]);
});

Deno.test("a limit that no gap up to a core explains latches a rules mismatch", () => {
  // Two cores of readings never drain a bank that earns the pinned 4.8-core baseline.
  const c = calibrationConfig({ mode: "apply" });
  const onset = at + 3 * 3_600_000, lift = onset + 3_600_000;
  const h = emptyHistory("test", 1, at);
  h.limits = [
    { ...record(), onset: at - 3_600_000, entry: at - 3_500_000, lift: at, class: "credit" },
    { ...record(), onset, entry: onset + 90_000, lift, class: "credit" },
  ];
  h.slots = Array.from({ length: 30 }, (_, i) => slot(at + i * SLOT_MS, 2));
  h.readings = Array.from({ length: 10 }, (_, i) => ({ at: at + i * 1_800_000, v: 25 }));
  const diagnosis = diagnoseGap(p, h, h.limits[1], c, 0.167, null);
  assertEquals(diagnosis.beyond, true);
  const s = initialCalibration(c, at);
  s.pendingLimits = [onset];
  const result = updateCalibration(p, h, s, c, lift + 600_000, 10000).state;
  assert(result.rulesMismatch);
  assertEquals(result.gap, 0);
  assert(result.applied.mul >= 1.07 && result.applied.add >= 0.1, JSON.stringify(result.applied));
});

Deno.test("recorded sample means preserve a job transition inside a reading boundary", () => {
  const integrated = (lo: number, hi: number) =>
    Math.max(0, Math.min(1000, hi) - lo) + 7 * Math.max(0, hi - Math.max(lo, 1000));
  const slots = Array.from(
    { length: 5 },
    (_, i) => ({ ...slot(at + i * SLOT_MS, 0), busy: integrated(i * 600, (i + 1) * 600) }),
  );
  const samples = Array.from(
    { length: 100 },
    (_, i) => ({
      at: at + (i + 1) * 30_000,
      seconds: 30,
      busy: integrated(i * 30, (i + 1) * 30) / 30 / p.vcpus,
      clockValid: true,
    }),
  );
  const readings = [{ at: at + 900_000, v: 0 }, { at: at + 2_698_000, v: 80 }];
  const expected = integrated(900, 2698) / 1798;
  assert(Math.abs(pairReadings(p, readings, slots)[0].own - expected) > 0.1);
  const observed = pairSamples(p, readings, samples);
  assertAlmostEquals(observed[0].own, expected, 1e-10);
  assertAlmostEquals(pairReadings(p, readings, slots, observed)[0].own, expected, 1e-10);
  samples[40].clockValid = false;
  assertEquals(pairSamples(p, readings, samples), []);
  // A reading that settles after the sample buffer moved on still pairs, from its slots.
  const later = [...readings, { at: at + 2_698_000 + 1_800_000, v: 80 }];
  const tail = Array.from({ length: 4 }, (_, i) => slot(at + (5 + i) * SLOT_MS, 7));
  const pairs = pairReadings(p, later, [...slots, ...tail], observed);
  assertEquals(pairs.length, 2);
  assertAlmostEquals(pairs[0].own, expected, 1e-10);
});

Deno.test("invalid readings teach nothing: a diagnosis waits, then uses the guest's own count", () => {
  const c = calibrationConfig({ mode: "apply" });
  const end = at + p.recovered / 0.13 * 1000;
  const onset = end + 300_000, lift = onset + 3_600_000;
  const h = emptyHistory("test", 1, at);
  h.limits = [
    { ...record(), onset: at - 3_600_000, entry: at - 3_500_000, lift: at, class: "credit" },
    { ...record(), onset, entry: onset + 90_000, lift, class: "credit" },
  ];
  h.slots = Array.from({ length: 130 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  h.readings = Array.from({ length: 40 }, (_, i) => ({ at: at + i * 1_800_000, v: 4.9 / 8 * 100 }));
  const s = initialCalibration(c, at);
  Object.assign(s, { pendingLimits: [onset], residualInvalid: true, invalid: true });
  const early = updateCalibration(p, h, s, c, lift + 600_000, 10000);
  assert(!early.changes.some((d) => d.trigger === "limit-diagnosis"));
  const late = updateCalibration(p, h, early.state, c, lift + 7_200_000, 10000);
  assertEquals(late.limits.find((l) => l.onset === onset)?.diagnosis?.source, "own");
  assert(late.state.gap <= 0.01 && !late.state.rulesMismatch);
});

Deno.test("gap learning bridges a reading gap with the fit and counts it as estimated time", () => {
  const end = at + p.recovered / 0.13 * 1000;
  const onset = end + 300_000;
  const h = emptyHistory("test", 1, at);
  const previous = { ...record(), onset: at - 3_600_000, lift: at, class: "credit" as const };
  h.limits = [previous];
  h.slots = Array.from({ length: 100 }, (_, i) => slot(at + i * SLOT_MS, 4.7));
  const all = Array.from({ length: 35 }, (_, i) => ({ at: at + i * 1_800_000, v: 4.9 / 8 * 100 }));
  // The fit reads 4.9 cores at 4.7, as the readings do.
  const meter = { ...fit, a: 1, b: 0.2 };
  const current = { ...record(), onset };
  // One missing reading leaves a 3,600-second interval: bridged, a tenth of the span or less.
  h.readings = all.filter((_, i) => i !== 10);
  const one = diagnoseGap(p, h, current, CALIBRATION, 0.167, meter);
  assertEquals(one.source, "readings");
  assertEquals(one.bridged, 3600);
  assert(one.gap !== null && one.gap >= 0.03, `${one.gap}`);
  const unbridged = diagnoseGap(p, { ...h, readings: all }, current, CALIBRATION, 0.167, meter);
  assert(one.eta > unbridged.eta);
  // Without a fit there is nothing to bridge with; with much of the span missing, the guest's own
  // charges stand in.
  assertEquals(diagnoseGap(p, h, current, CALIBRATION, 0.167, null).source, "own");
  h.readings = all.filter((_, i) => i < 8 || i > 12);
  assertEquals(diagnoseGap(p, h, current, CALIBRATION, 0.167, meter).source, "own");
});

Deno.test("pressing after recovery began disqualifies the lift check at once", () => {
  const c = calibrationConfig({ mode: "shadow" });
  const h = emptyHistory("test", 1, at);
  const lift = at + 3 * 2_880_000;
  h.limits = [{ ...record(), onset: at, entry: at + 90_000, lift, class: "credit" }];
  h.slots = Array.from({ length: 30 }, (_, i) =>
    // Pressing at entry is expected; pressing in slot 6, after it stopped, is not.
    slot(at + i * SLOT_MS, 2.4, FLAGS.limited | (i === 0 || i === 6 ? FLAGS.pressing : 0)));
  h.readings = Array.from({ length: 10 }, (_, i) => ({ at: at + i * 1_800_000, v: 30 }));
  const result = updateCalibration(p, h, initialCalibration(c, at - DAY), c, lift + 600_000, 0);
  assertEquals(result.limits[0].liftCheck?.predicted, null);
  assert(!result.changes.some((d) => d.trigger === "rules-mismatch"));
  h.slots = h.slots.map((s, i) => i === 6 ? { ...s, flags: FLAGS.limited } : s);
  const clean = updateCalibration(p, h, initialCalibration(c, at - DAY), c, lift + 600_000, 0);
  // The pressing entry slot earns nothing: 2,880 seconds of earning plus its 600.
  assertAlmostEquals(clean.limits[0].liftCheck!.predicted!, 3480, 1);
});

Deno.test("classification reads caps that steal places, burner delivery and the steepest decline", () => {
  const credit = record();
  credit.caps = [0, 1].map((i) => ({
    at: at + i * 1_800_000,
    busy: 2.4,
    demand: 6,
    ceiling: 300,
    pressing: true,
  }));
  assertEquals(classifyLimit(p, credit), "credit");
  // A recovery hold at 0.4 cores still sees steal, but delivery within the band of demand measures
  // the demand, not the cap.
  const held = {
    ...credit,
    caps: [...credit.caps, { ...credit.caps[0], at: at + 3_600_000, busy: 0.33, demand: 0.4 }],
  };
  assertEquals(classifyLimit(p, held), "credit");
  // With only 0.2 cores of steal, burner delivery places the cap instead. A confirmed limit always
  // has it: confirmation needs a lift test whose burners ran, and the first such test records it.
  const shallow = { ...credit, caps: credit.caps.map((x) => ({ ...x, demand: 2.6 })) };
  assertEquals(classifyLimit(p, shallow), "unknown");
  assertEquals(classifyLimit(p, { ...shallow, testDelivery: { busy: 2.4, demand: 6 } }), "credit");
  // Burners that deliver 4 cores under the cap mean sustained use, with no pressing cap recorded.
  assertEquals(
    classifyLimit(p, { ...credit, caps: [], testDelivery: { busy: 4, demand: 7 } }),
    "sustained-use",
  );
  // 3.5 to 1.5 cores in half an hour, then flat for two hours: a fast drop that then holds.
  const dropped = {
    ...credit,
    caps: [3.5, 1.5, 1.5, 1.5, 1.5].map((busy, i) => ({
      ...credit.caps[0],
      at: at + i * 1_800_000,
      busy,
    })),
  };
  assertEquals(classifyLimit(p, dropped), "sustained-use");
});

Deno.test("long reading intervals are paired over the whole interval and its last half hour", () => {
  const c = calibrationConfig({ mode: "shadow" });
  const h = emptyHistory("test", 1, at);
  // Two cores for the first half hour of the long interval, then four for its last half hour.
  h.slots = Array.from({ length: 15 }, (_, i) => slot(at + i * SLOT_MS, i >= 6 && i < 9 ? 4 : 2));
  h.readings = [{ at, v: 25 }, { at: at + 1_800_000, v: 25 }, { at: at + 5_400_000, v: 33 }, {
    at: at + 7_200_000,
    v: 25,
  }];
  const pairs = pairLongIntervals(p, h.readings, h.slots, 0);
  assertEquals(pairs.length, 1);
  assertEquals(pairs[0].at, at + 5_400_000);
  assertAlmostEquals(pairs[0].own, 3, 1e-9);
  assertAlmostEquals(pairs[0].ownLast, 4, 1e-9);
  // Each long interval is reported once, then remembered.
  const first = updateCalibration(p, h, initialCalibration(c, at), c, at + 7_200_000, 0);
  assertEquals(first.longPairs.length, 1);
  assertEquals(first.state.longPairedAt, at + 5_400_000);
  assertEquals(updateCalibration(p, h, first.state, c, at + 7_800_000, 0).longPairs, []);
});

Deno.test("on KVM 1 a first cap inside the credit band stays a credit limit", () => {
  const kvm1 = plan(1);
  const capped = (busy: number) =>
    [0, 1, 2].map((i) => ({
      at: at + i * 1_800_000,
      busy,
      demand: 2,
      ceiling: 100,
      pressing: true,
    }));
  // 45% of one vCPU is 0.45 cores, inside the band of 0.4 plus or minus 0.3. Sustained use also needs
  // the first cap above the band, 0.7 cores.
  assertEquals(classifyLimit(kvm1, { ...record(), caps: capped(0.6) }), "credit");
  // The first sustained-use step on KVM 1 still clears it.
  assertEquals(classifyLimit(kvm1, { ...record(), caps: capped(0.75) }), "sustained-use");
});

Deno.test("readings at the 100% cap neither clear invalid readings nor reach drift detection", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const normal = (cores: number) => (fit.a * cores + fit.b) / p.vcpus * 100;
  // Box A's relation puts 7.7 cores at 8.08: Hostinger reports 100%, 0.7 sigma under the fit.
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 30 }, (_, i) => slot(at + i * SLOT_MS, 7.7));
  h.readings = Array.from({ length: 8 }, (_, i) => ({ at: at + i * 1_800_000, v: 100 }));
  const s = initialCalibration(c, at);
  Object.assign(s, {
    fit,
    fitAt: at + DAY,
    lastPaired: at,
    residualInvalid: true,
    invalid: true,
    invalidSpans: [{ from: at, to: null }],
  });
  const now = h.readings.at(-1)!.at + 60_000;
  // A capped reading only bounds the meter from below: it cannot show the feed recovered.
  const stuck = updateCalibration(p, h, s, c, now, 30000).state;
  assert(stuck.residualInvalid);
  assertEquals(stuck.cleanReadings, 0);
  // At 7.5 cores the fit says 7.87: a capped reading sits 1.2 sigma above it, which CUSUM would sum.
  h.slots = Array.from({ length: 30 }, (_, i) => slot(at + i * SLOT_MS, i < 12 ? 4 : 7.5));
  h.readings = Array.from(
    { length: 11 },
    (_, i) => ({ at: at + i * 1_800_000, v: i <= 4 ? normal(4) : 100 }),
  );
  const valid = initialCalibration(c, at);
  Object.assign(valid, { fit, fitAt: at + DAY, lastPaired: at });
  const tracked = updateCalibration(p, h, valid, c, h.readings.at(-1)!.at + 60_000, 30000).state;
  assertEquals(tracked.cusum.s, 0);
  assert(!tracked.invalid);
});

Deno.test("a limit whose replay crosses a reboot still raises the floor, logged as not measurable", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from(
    { length: 60 },
    (_, i) => slot(at + i * SLOT_MS, 4.7, i === 20 ? FLAGS.reboot : 0),
  );
  const onset = at + 30_300_000, lift = onset + 3_600_000;
  h.limits = [
    { ...record("apply"), onset: at - 3_600_000, entry: at - 3_510_000, lift: at, class: "credit" },
    { ...record("apply"), onset, entry: onset + 90_000, lift, class: "credit" },
  ];
  const s = initialCalibration(c, at - DAY);
  s.pendingLimits = [onset];
  const result = updateCalibration(p, h, s, c, lift + 7_200_000, 10000);
  const diagnosis = result.changes.find((d) => d.trigger === "limit-diagnosis")!;
  assertEquals(diagnosis.inputs.note, "gap not measurable");
  // The estimate at entry still measures optimism: 5,000 credits raise the floor to its maximum.
  assertEquals(result.state.applied.floor, c.floor_max);
  // In apply the governor acted on the clamped estimate it recorded, so that is its optimism.
  h.limits[1] = { ...h.limits[1], acted: 0.02 * p.capacity };
  const clamped = updateCalibration(p, h, s, c, lift + 7_200_000, 10000);
  assertAlmostEquals(clamped.state.applied.floor, c.start.floor + 0.02, 1e-9);
});

Deno.test("the mismatch check starts from the detected lift, where the bank is a lower bound", () => {
  const h = emptyHistory("test", 1, at);
  // Limited at 2 cores until the lift 40 minutes later, then 6 cores charged at 6.34 a second.
  h.slots = Array.from(
    { length: 12 },
    (_, i) => slot(at + i * SLOT_MS, i < 4 ? 2 : 6, i < 4 ? FLAGS.limited | FLAGS.pressing : 0),
  );
  h.limits = [{
    ...record(),
    onset: at - 3_600_000,
    limitedAt: at,
    lift: at + 2_400_000,
    class: "credit",
  }];
  // From the lift's 6,912 credits, a gap of 0.666 cores empties the bank 3,133 seconds later, at the
  // recorded onset, the latest plausible one; to t_lo, five minutes earlier, it would take 0.9. From
  // the last limited test, the recovery before the lift would need more than a whole core.
  const current = { ...record(), onset: at + (2400 + 2833 + 300) * 1000 };
  const d = diagnoseGap(p, h, current, CALIBRATION, 0.167, null, { useReadings: false });
  assertEquals(d.source, "own");
  assert(!d.beyond);
  assertAlmostEquals(d.lower!, 6912 / 3133 - 1.54, 0.01);
  // The recorded inputs keep the earlier limit, so a rerun after history dropped it still agrees.
  const options = { useReadings: false, invalid: [], fullOwnStep: false };
  const evidence = diagnosisEvidence(h, CALIBRATION, 0.167, null, d, options);
  assertEquals(evidence.limits!.map((l) => l.onset), [at - 3_600_000]);
  const rerun = (limits: typeof h.limits) =>
    diagnoseGap(
      p,
      { ...h, limits, slots: evidence.slots, readings: evidence.readings },
      current,
      CALIBRATION,
      0.167,
      null,
      { ...options, anchor: evidence.anchor },
    );
  assertEquals(rerun(evidence.limits!), d);
  assert(rerun([]).lower !== d.lower);
});

Deno.test("the whole-core mismatch test replays to the recorded onset too", () => {
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from(
    { length: 12 },
    (_, i) => slot(at + i * SLOT_MS, i < 4 ? 2 : 6, i < 4 ? FLAGS.limited | FLAGS.pressing : 0),
  );
  h.limits = [{
    ...record(),
    onset: at - 3_600_000,
    limitedAt: at,
    lift: at + 2_400_000,
    class: "credit",
  }];
  // A whole core empties the lift's 6,912 credits 2,721 seconds on: after t_lo, before the recorded
  // onset 2,900 seconds on. To t_lo, the test found it beyond any gap and latched; to the onset it
  // takes 0.843 cores.
  const current = { ...record(), onset: at + (2400 + 2900) * 1000 };
  const d = diagnoseGap(p, h, current, CALIBRATION, 0.167, null, { useReadings: false });
  assertEquals(d.source, "own");
  assert(!d.beyond);
  assertAlmostEquals(d.lower!, 6912 / 2900 - 1.54, 0.01);
  // The same from an anchor that isn't a lift, such as a certified-full bank: learning's own
  // replay, to t_lo, set the tests' estimate.
  h.slots = Array.from({ length: 12 }, (_, i) => slot(at + i * SLOT_MS, 6));
  h.limits = [];
  const exact = { at, balance: 6912, exact: true };
  const from = { ...record(), onset: at + 2_900_000 };
  const e = diagnoseGap(p, h, from, CALIBRATION, 0.167, null, {
    useReadings: false,
    anchor: exact,
  });
  assert(!e.beyond);
  assertAlmostEquals(e.lower!, 6912 / 2900 - 1.54, 0.01);
});

Deno.test("the clamp bridges clock-invalid time with the governor's own count", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  const steady = Array.from({ length: 36 }, (_, i) => slot(at + i * SLOT_MS, 3));
  h.readings = Array.from(
    { length: 12 },
    (_, i) => ({ at: at + i * 1_800_000, v: (fit.a * 3 + fit.b) / p.vcpus * 100 }),
  );
  const now = h.readings.at(-1)!.at + 600_000;
  const s = { ...initialCalibration(c, at), fit, replayBase: null };
  const reference = calculateEstimates(p, { ...h, slots: steady }, s, c, now, 30000).clamp!;
  // An hour forward and back: the first hour has no slots, the next hour's hold the counts.
  h.slots = steady.map((x, i) =>
    i >= 10 && i < 16 ? null : i >= 16 && i < 22 ? { ...x, flags: FLAGS.clockInvalid } : x
  ).filter((x) => x !== null);
  const bridged = calculateEstimates(p, h, s, c, now, 30000).clamp;
  assert(bridged !== null);
  // Two hours billed at 1.05x + 0.04 instead of their readings: 0.03 cores more.
  assertAlmostEquals(bridged, reference, 300);
});

Deno.test("a verified drift change ends with a fit on the readings after it, against the margin before it", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  const cores = (j: number) => 3 + j % 3;
  h.slots = Array.from({ length: 160 }, (_, j) => slot(at + j * SLOT_MS, cores(Math.floor(j / 3))));
  // 0.5 cores more at every load from `at`: an offset, not a slope.
  h.readings = Array.from({ length: 53 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: (fit.a * cores(i - 1) + fit.b + 0.5) / p.vcpus * 100,
  }));
  const s = initialCalibration(c, at - 14 * DAY);
  const before = { ...c.start };
  Object.assign(s, {
    fit,
    fitAt: at,
    lastPaired: h.readings.at(-1)!.at,
    gap: 0.05,
    // Meanwhile a limit taught a gap, and something raised the multiplier.
    applied: { mul: 1.1, add: 0.3, floor: 0.08 },
    pending: {
      at,
      from: before,
      gapFrom: 0,
      oldFit: fit,
      fit: { ...fit, b: fit.b + 0.5 },
      hold: { mul: 1.1, add: 0.6, floor: 0.05 },
      readings: 48,
      z: 400,
      verified: true,
      residual: 0,
      n: 0,
    },
  });
  const result = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000).state;
  assertEquals(result.pending, null);
  assertEquals(result.fitSince, at);
  assertAlmostEquals(result.fit!.b, fit.b + 0.5, 1e-6);
  // The fit carries the change, so what limits taught during it is superseded; the floor stays.
  assertEquals(result.gap, 0);
  assertEquals(result.applied.mul, 1.05);
  assertAlmostEquals(result.applied.add, 0.504, 0.005);
  assertEquals(result.applied.floor, 0.08);
});

Deno.test("refits after a drift change replace an early split into slope and offset", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  const cores = (j: number) => 3 + j % 3;
  h.slots = Array.from({ length: 300 }, (_, j) => slot(at + j * SLOT_MS, cores(Math.floor(j / 3))));
  // The meter's slope rose to 1.07 at `at`; nothing changed in its offset.
  h.readings = Array.from({ length: 100 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: (1.07 * cores(i - 1) + fit.b) / p.vcpus * 100,
  }));
  const s = initialCalibration(c, at - 14 * DAY);
  Object.assign(s, {
    // The fit that ended the change saw too little load range and read part of it as an offset.
    fit: { ...fit, a: 1.0586, b: 0.074, aHi: 1.0586 },
    fitAt: at,
    fitSince: at - 1,
    fitFrom: { ...c.start },
    lastPaired: at,
    applied: { mul: 1.059, add: 0.115, floor: 0.05 },
  });
  const result = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000).state;
  // More readings after the change show a slope: the offset reading does not stay beside it.
  assertAlmostEquals(result.fit!.a, 1.07, 1e-6);
  assertAlmostEquals(result.applied.mul, 1.07, 0.0011);
  assertEquals(result.applied.add, c.start.add);
  assertEquals(result.applied.floor, 0.05);
});

Deno.test("a repeat under the stale fallback holds the charges it was billed at, plus the step", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  // The fallback's 1.05x + 0.08 was in force: the governor charged 0.04 cores more than the start.
  const fallback = { mul: 1.05, add: 0.08, floor: 0.05 };
  h.slots = Array.from(
    { length: 60 },
    (_, i) => ({ ...slot(at + i * SLOT_MS, 4.7), charged: (1.05 * 4.7 + 0.08) * 600 }),
  );
  const onset = at + 30_300_000, lift = onset + 3_600_000;
  h.limits = [
    { ...record("apply"), onset: at - 3_600_000, entry: at - 3_510_000, lift: at },
    { ...record("apply"), onset, entry: onset + 90_000, lift, settings: fallback },
  ].map((l) => ({ ...l, class: "credit" as const }));
  const s = initialCalibration(c, at - 30 * DAY);
  s.pendingLimits = [onset];
  const held = updateCalibration(p, h, s, c, lift + 7_200_000, 10000).state.ownHold!;
  // The own-count step is billing above those charges, so the hold keeps their 0.08 under it.
  assert(held.settings.add >= 0.08 + held.gap - 1e-9, `${held.settings.add} ${held.gap}`);
});

Deno.test("a reset during a residual alarm ends it, and the next fit judges new readings", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const s = {
    ...initialCalibration(c, at - 3 * DAY),
    fit,
    fitAt: at - DAY,
    fitSince: at - 2 * DAY,
    fitFrom: { ...c.start },
    residualInvalid: true,
    invalid: true,
    extreme: 3,
    invalidSpans: [{ from: at - DAY, to: null, applied: { ...c.start }, gap: 0 }],
  };
  const reset = resetCalibration(c, s, at);
  assertEquals(reset.fit, null);
  assertEquals(reset.residualInvalid, false);
  // The readings the alarm marked stay out of fits and replays.
  assertEquals(reset.invalidSpans, [{ from: at - DAY, to: at }]);
  // The meter's change point stays, so the next fit can't mix the meters either side of it; the
  // margin from before the change goes with the learned settings.
  assertEquals(reset.fitSince, at - 2 * DAY);
  assert(!("fitAt" in reset) && !("fitFrom" in reset));
  assert(validCalibrationState(reset));
  // A reset returns the floor to the start, so nothing is left for a corroboration to undo.
  assertEquals(resetCalibration(c, { ...s, provisionalFloor: 0.05 }, at).provisionalFloor, null);
  assert(validCalibrationState({ ...reset, provisionalFloor: 0.05 }));
  assert(!validCalibrationState({ ...reset, provisionalFloor: "0.05" }));
  // persist.json and history drop absent keys; the digest explain verifies must not see them.
  assertEquals(inputsDigest({ a: 1, b: undefined }), inputsDigest({ a: 1 }));
  assertEquals(inputsDigest(reset), inputsDigest(JSON.parse(JSON.stringify(reset))));
  // Valid readings after the reset fit the meter again and count as usable.
  const h = emptyHistory("test", 1, at - 3 * DAY);
  const cores = (j: number) => 3 + j % 3;
  h.slots = Array.from({ length: 160 }, (_, j) => slot(at + j * SLOT_MS, cores(Math.floor(j / 3))));
  h.readings = Array.from({ length: 53 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: (fit.a * cores(i - 1) + fit.b) / p.vcpus * 100,
  }));
  const now = h.readings.at(-1)!.at + 600_000;
  const result = updateCalibration(p, h, reset, c, now, 10000);
  assert(result.state.fit !== null);
  assertEquals(result.state.invalid, false);
  assert(result.changes.some((d) => d.trigger === "readings-resumed"));
});

Deno.test("a reset keeps a verified drift change's point for the next fit", () => {
  const c = calibrationConfig({ mode: "apply" });
  const pending = {
    at: at - DAY,
    from: { ...c.start },
    gapFrom: 0,
    oldFit: fit,
    fit: { ...fit, b: fit.b + 0.3 },
    hold: { ...c.start, add: 0.36 },
    readings: 6,
    z: 20,
    verified: true,
    residual: 0,
    n: 0,
  };
  const s = { ...initialCalibration(c, at - 3 * DAY), fit, pending };
  const reset = resetCalibration(c, s, at);
  assertEquals([reset.pending, reset.fitSince], [null, at - DAY]);
  assert(validCalibrationState(reset));
  // An alarm still unverified is no change point yet.
  const alarm = resetCalibration(c, { ...s, pending: { ...pending, verified: false } }, at);
  assertEquals(alarm.fitSince, undefined);
});

Deno.test("readings that come back broken after an outage keep the holds", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 6 * 24 * 3 }, (_, i) => slot(at + i * SLOT_MS, 3));
  const normal = (fit.a * 3 + fit.b) / p.vcpus * 100;
  // A day of readings, then two days without any.
  h.readings = Array.from({ length: 48 }, (_, i) => ({ at: at + i * 1_800_000, v: normal }));
  const s = { ...initialCalibration(c, at), fit };
  const seen = updateCalibration(p, h, s, c, at + DAY, 1000).state;
  // Repeat limits during the outage raised the own-count hold.
  seen.ownHold = { gap: 0.3, settings: { mul: 1.05, add: 0.36, floor: 0.05 } };
  const outage = updateCalibration(p, h, seen, c, at + 3 * DAY - 3_600_000, 1000).state;
  assertEquals(outage.hold?.reason, "stale");
  const held = effectiveSettings(outage);
  assertEquals(held.add, 0.36);
  // They return at 8x the meter: first one at a time, then a batch.
  for (const count of [1, 3]) {
    const back = {
      ...h,
      readings: [
        ...h.readings,
        ...Array.from({ length: count }, (_, i) => ({
          at: at + 3 * DAY - (count - i) * 1_800_000 + 1_800_000 - 600_000,
          v: Math.min(100, normal * 8),
        })),
      ],
    };
    const result = updateCalibration(p, back, outage, c, at + 3 * DAY - 1, 1000);
    const triggers = result.changes.map((d) => d.trigger);
    assert(!triggers.includes("readings-resumed"), `${count}: ${triggers}`);
    assertEquals(effectiveSettings(result.state), held, `${count}`);
    // The fallback's clock keeps running from the outage.
    assertEquals(result.state.apiStaleSince, outage.apiStaleSince, `${count}`);
  }
});

Deno.test("readings that come back with the rise the own-count hold measured end it", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 6 * 24 * 3 }, (_, i) => slot(at + i * SLOT_MS, 3));
  const cores = (rise: number) => (fit.a * 3 + fit.b + rise) / p.vcpus * 100;
  h.readings = Array.from({ length: 48 }, (_, i) => ({ at: at + i * 1_800_000, v: cores(0) }));
  const seen =
    updateCalibration(p, h, { ...initialCalibration(c, at), fit }, c, at + DAY, 1000).state;
  // Limits during the outage measured a 0.5-core rise; the hold adds its allowance on top. The
  // first of them left optimism the margin then in force didn't explain, raising the floor.
  seen.ownHold = { gap: 0.8, central: 0.5, settings: { mul: 1.05, add: 0.88, floor: 0.05 } };
  seen.applied = { ...seen.applied, floor: 0.1 };
  seen.provisionalFloor = 0.05;
  const outage = updateCalibration(p, h, seen, c, at + 3 * DAY - 3_600_000, 1000).state;
  assertEquals(outage.provisionalFloor, 0.05);
  const back = (rise: number) => ({
    ...h,
    readings: [
      ...h.readings,
      ...Array.from({ length: 4 }, (_, i) => ({
        at: at + 3 * DAY - (4 - i) * 1_800_000 + 1_800_000 - 600_000,
        v: cores(rise),
      })),
    ],
  });
  // The meter really rose by half a core: the readings agree, count again, and the holds end.
  const agreed = updateCalibration(p, back(0.5), outage, c, at + 3 * DAY - 1, 1000);
  const triggers = agreed.changes.map((d) => d.trigger);
  assert(triggers.includes("readings-corroborated"), `${triggers}`);
  assert(triggers.includes("readings-resumed"), `${triggers}`);
  assertEquals([agreed.state.hold, agreed.state.ownHold], [null, null]);
  assertEquals(agreed.state.pending?.verified, true);
  // The meter change explains that optimism, so the floor goes back.
  assertEquals([agreed.state.applied.floor, agreed.state.provisionalFloor], [0.05, null]);
  // Within half of each other, either way: 0.7 cores agrees with the 0.5 the limits measured, 0.9
  // doesn't, though 0.5 is within half of 0.9.
  const corroborated = (rise: number) =>
    updateCalibration(p, back(rise), outage, c, at + 3 * DAY - 1, 1000).changes.some((d) =>
      d.trigger === "readings-corroborated"
    );
  assertEquals([corroborated(0.7), corroborated(0.9)], [true, false]);
  // A feed that rose by far more than any limit measured stays invalid, under both holds.
  const broken = updateCalibration(p, back(2.5), outage, c, at + 3 * DAY - 1, 1000);
  assert(!broken.changes.some((d) => d.trigger === "readings-resumed"));
  assertEquals(broken.state.ownHold, outage.ownHold);
  assertEquals([broken.state.applied.floor, broken.state.provisionalFloor], [0.1, 0.05]);
  // Readings that come back normal show no meter change: the optimism was real, and the floor stays.
  const normal = updateCalibration(p, back(0), outage, c, at + 3 * DAY - 1, 1000);
  assert(normal.changes.some((d) => d.trigger === "readings-resumed"));
  assertEquals([normal.state.applied.floor, normal.state.provisionalFloor], [0.1, null]);
});

Deno.test("valid but stale readings keep the own-count hold", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  // A metric that was invalid is valid again, but no settled reading arrived for three hours.
  const s = {
    ...initialCalibration(c, at),
    invalid: true,
    ownHold: { gap: 0.3, settings: { mul: 1.05, add: 0.36, floor: 0.05 } },
  };
  const result = updateCalibration(p, h, s, c, at + 3 * 3_600_000, 1000);
  assertEquals(result.state.ownHold, s.ownHold);
  assert(!result.changes.some((d) => d.trigger === "readings-resumed"));
});

Deno.test("long reading intervals report their mean residuals in cores and in sigma", () => {
  const h = emptyHistory("test", 1, at);
  h.longPairs = [{
    at: at + 3_600_000,
    from: at,
    host: fit.a * 4 + fit.b + 0.1,
    own: 4,
    ownLast: 3,
  }];
  const s = { ...initialCalibration(CALIBRATION, at), fit };
  const long = calibrationSummary(CALIBRATION, s, h).longIntervals!;
  assertEquals(long.count, 1);
  assertAlmostEquals(long.whole!, 0.1, 1e-9);
  assertAlmostEquals(long.lastHalfHour!, 0.1 + fit.a, 1e-9);
  assertAlmostEquals(long.zWhole!, 0.1 / (fit.sigma[0] + fit.sigma[1] * 4), 1e-9);
});

Deno.test("a tick's tail keeps a clock-invalid run whole, so its clamp equals the evaluation's", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.limits = [{ ...record(), onset: at - 3_600_000, lift: at, class: "credit" }];
  // A clock-invalid run, slots 20 to 27, whose first half ran at 6 cores and the rest at 4.7.
  h.slots = Array.from(
    { length: 36 },
    (_, i) =>
      i >= 20 && i < 28
        ? slot(at + i * SLOT_MS, i < 24 ? 6 : 4.7, FLAGS.clockInvalid)
        : slot(at + i * SLOT_MS, 4.7),
  );
  h.readings = Array.from({ length: 9 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: (fit.a * 4.7 + fit.b) / 8 * 100,
  }));
  const now = at + 36 * SLOT_MS - 1;
  const s = updateCalibration(p, h, { ...initialCalibration(c, at), fit }, c, now, 30000).state;
  const base = s.replayBase!;
  // The replay base falls inside the run.
  assert(base.at > h.slots[20].at && base.at < h.slots[27].at, `${base.at}`);
  const tail = { ...h, readings: [h.readings.at(-1)!] };
  const full = calculateEstimates(p, h, s, c, now, 30000).clamp!;
  assertEquals(
    calculateEstimates(p, { ...tail, slots: tailSlots(h.slots, base.at) }, s, c, now, 30000).clamp,
    full,
  );
  // Cut at the base, the run bills at the rate of its second half alone.
  const cut = h.slots.slice(h.slots.findIndex((x) => x.at + SLOT_MS > base.at));
  assert(
    Math.abs(calculateEstimates(p, { ...tail, slots: cut }, s, c, now, 30000).clamp! - full) > 100,
  );
});

Deno.test("under a rules mismatch, the fit that ends a drift change keeps widen() steps", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  const cores = (j: number) => 3 + j % 3;
  h.slots = Array.from({ length: 160 }, (_, j) => slot(at + j * SLOT_MS, cores(Math.floor(j / 3))));
  h.readings = Array.from({ length: 53 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: (fit.a * cores(i - 1) + fit.b + 0.1) / p.vcpus * 100,
  }));
  const s = initialCalibration(c, at - 14 * DAY);
  // Limits under the latch widened the margin from 1.07 + 0.10 to 1.11 + 0.14 while it held.
  Object.assign(s, {
    fit,
    fitAt: at,
    lastPaired: h.readings.at(-1)!.at,
    rulesMismatch: true,
    applied: { mul: 1.11, add: 0.14, floor: 0.05 },
    pending: {
      at,
      from: { mul: 1.07, add: 0.10, floor: 0.05 },
      gapFrom: 0,
      oldFit: fit,
      fit: { ...fit, b: fit.b + 0.1 },
      hold: { mul: 1.07, add: 0.2, floor: 0.05 },
      readings: 48,
      z: 400,
      verified: true,
      residual: 0,
      n: 0,
    },
  });
  const r = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000);
  assertEquals(r.state.pending, null);
  assert(
    r.state.applied.mul >= 1.11 && r.state.applied.add >= 0.14,
    JSON.stringify(r.state.applied),
  );
});

Deno.test("an outage counts as staleness, not spacing, so resumed readings are usable", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  // A 13-hour hole, then eleven hours of readings every 30 minutes.
  const resumed = at + 13 * 3_600_000;
  h.readings = [
    { at, v: 30 },
    ...Array.from({ length: 23 }, (_, i) => ({ at: resumed + i * 1_800_000, v: 30 })),
  ];
  const now = h.readings.at(-1)!.at + 600_000;
  const s = {
    ...initialCalibration(c, at),
    lastSettled: h.readings.at(-2)!.at,
    settledSeenAt: now,
  };
  const result = updateCalibration(p, h, s, c, now, 1000);
  assertEquals(result.state.invalid, false);
  assert(!result.changes.some((d) => d.trigger === "readings-invalid"));
  // Hourly readings are still a spacing problem.
  h.readings = Array.from({ length: 25 }, (_, i) => ({ at: at + i * 3_600_000, v: 30 }));
  const hourly = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 600_000, 1000);
  assertEquals(hourly.changes.find((d) => d.trigger === "readings-invalid")?.inputs.reasons, [
    "spacing",
  ]);
  // A 7-hour outage, then 16 hours of readings 50 minutes apart: the outage is left out, and the
  // bad spacing is still most of the day. Requiring 20 counted hours never judged it.
  h.readings = [
    { at, v: 30 },
    ...Array.from({ length: 21 }, (_, i) => ({ at: at + 7 * 3_600_000 + i * 3_000_000, v: 30 })),
  ];
  const outage = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 600_000, 1000);
  assertEquals(outage.changes.find((d) => d.trigger === "readings-invalid")?.inputs.reasons, [
    "spacing",
  ]);
});

Deno.test("a corroboration bills its rise only from where the readings turned extreme", () => {
  // Five cores bill above the baseline, so the bank drains and every billed second shows.
  const slots = Array.from({ length: 36 }, (_, i) => slot(at + i * SLOT_MS, 5));
  const v = (fit.a * 5 + fit.b) / p.vcpus * 100;
  // Readings every 30 minutes for six hours, with none from the first hour to the third.
  const readings = Array.from({ length: 13 }, (_, i) => ({ at: at + i * 1_800_000, v }))
    .filter((r) => r.at <= at + 3_600_000 || r.at >= at + 3 * 3_600_000);
  const anchor = { at, balance: p.capacity, exact: true };
  const replay = (bridge: Bridge) =>
    replaySettled(p, readings, slots, anchor, { to: at + 6 * 3_600_000, bridge }).balance;
  const risen = { fit, rise: { from: at + 4 * 3_600_000, by: 0.5 } };
  // The gap before the change crossed the old meter. Billed with the rise, two hours of it cost
  // 3,600 core-seconds more.
  assertAlmostEquals(replay(risen), replay({ fit }), 1e-6);
  assertAlmostEquals(replay(risen) - replay({ fit: { ...fit, b: fit.b + 0.5 } }), 3600, 1);
});

Deno.test("an onset margin of 0 is a valid configuration, with no allowance", () => {
  validateCalibration({ learning: { onset_margin_s: 0 } });
  assertThrows(() => validateCalibration({ learning: { onset_margin_s: -1 } }));
});

Deno.test("a raised configured start applies over saved settings, and an unchanged one changes nothing", () => {
  const saved = initialCalibration(CALIBRATION, at);
  assertEquals(withStart(p, CALIBRATION, saved), saved);
  const fitted = { ...saved, fit, applied: marginFromFit(p, fit, 0, CALIBRATION.start) };
  assertEquals(withStart(p, CALIBRATION, fitted), fitted);
  const c = calibrationConfig({ start: { mul: 1.07, add: 0.06, floor: 0.08 }, gap_start: 0.02 });
  const raised = withStart(p, c, saved);
  assertEquals(raised.gap, 0.02);
  assertEquals(raised.applied.mul, 1.07);
  assertEquals(raised.applied.floor, 0.08);
  assertAlmostEquals(raised.applied.add, 0.06 + 0.02 * 1.07, 1e-12);
  // With a fit, the gap and start go through the margin from the fit.
  assertEquals(
    withStart(p, c, fitted).applied,
    marginFromFit(p, fit, 0.02, { mul: 1.07, add: 0.06, floor: 0.08 }, c),
  );
  // A learned margin above the new start stays.
  const learned = { ...saved, applied: { mul: 1.09, add: 0.15, floor: 0.09 } };
  assertEquals(withStart(p, c, learned).applied, { mul: 1.09, add: 0.15, floor: 0.09 });
});

Deno.test("the clamp keeps its replay once its only anchor ages out of the 90-day history", () => {
  const c = calibrationConfig({ mode: "apply" });
  // A busy box whose bank certifies full only on the first night.
  const build = (days: number) => {
    const end = at + days * DAY;
    const h = emptyHistory("test", 1, at);
    for (let t = at; t < end; t += SLOT_MS) {
      const idle = t < at + 4 * 3_600_000;
      h.slots.push(slot(t, idle ? 0.05 : 4.6, idle ? FLAGS.atCapacity : 0));
    }
    for (let t = at; t < end - 3_600_000; t += 1_800_000) {
      const u = t <= at + 4 * 3_600_000 ? 0.05 : 4.6;
      h.readings.push({ at: t, v: Math.round((fit.a * u + fit.b) / 8 * 10000) / 100 });
    }
    boundHistory(h, end);
    return { h, end };
  };
  const before = build(89);
  const kept = updateCalibration(p, before.h, initialCalibration(c, at), c, before.end, 20000);
  assert(kept.state.estimates.clamp !== null);
  const after = build(90.5);
  assert(after.h.slots[0].at > at + 4 * 3_600_000);
  // The next evaluation continues from the last base; a fresh state has nothing to replay from.
  const next = updateCalibration(p, after.h, kept.state, c, after.end, 20000);
  assert(next.state.estimates.clamp !== null);
  assert(next.state.estimates.acted < 20000);
  const fresh = updateCalibration(p, after.h, initialCalibration(c, at), c, after.end, 20000);
  assertEquals(fresh.state.estimates.clamp, null);
  // Most evaluations, at a slot's close, bring no new reading. They keep the base.
  const later = { ...after.h, slots: [...after.h.slots, slot(after.end, 4.6)] };
  const quiet = updateCalibration(p, later, next.state, c, after.end + SLOT_MS, 20000);
  assertEquals(quiet.state.replayBase, next.state.replayBase);
  assert(quiet.state.estimates.clamp !== null);
  // The next reading continues the replay from it.
  const last = later.readings.at(-1)!;
  const more = { ...later, readings: [...later.readings, { at: last.at + 1_800_000, v: last.v }] };
  const resumed = updateCalibration(p, more, quiet.state, c, after.end + SLOT_MS, 20000);
  assert(resumed.state.replayBase!.at > next.state.replayBase!.at);
  assert(resumed.state.estimates.clamp !== null);
});

Deno.test("a hole local samples don't cover stops the replay from an older anchor, not the clamp", () => {
  const c = calibrationConfig({ mode: "apply" });
  // A bank at capacity on the first night, then busy days.
  const h = emptyHistory("test", 1, at);
  for (let t = at; t < at + 3 * DAY; t += SLOT_MS) {
    const idle = t < at + 4 * 3_600_000;
    h.slots.push(slot(t, idle ? 0.05 : 4.6, idle ? FLAGS.atCapacity : 0));
  }
  for (let t = at; t < at + 3 * DAY - 3_600_000; t += 1_800_000) {
    const u = t <= at + 4 * 3_600_000 ? 0.05 : 4.6;
    h.readings.push({ at: t, v: Math.round((fit.a * u + fit.b) / 8 * 10000) / 100 });
  }
  const upTo = (end: number) => ({
    ...h,
    slots: h.slots.filter((x) => x.at < end),
    readings: h.readings.filter((r) => r.at <= end - 3_600_000),
  });
  const day2 = updateCalibration(
    p,
    upTo(at + 2 * DAY),
    initialCalibration(c, at),
    c,
    at + 2 * DAY - 1,
    20000,
  );
  assert(day2.state.replayBase !== null);
  // Then a slot on day one goes missing, before day two's base.
  const holed = { ...h, slots: h.slots.filter((x) => x.at !== at + DAY) };
  const fresh = updateCalibration(p, holed, initialCalibration(c, at), c, at + 3 * DAY - 1, 20000);
  assertEquals(fresh.state.estimates.clamp, null);
  const kept = updateCalibration(p, holed, day2.state, c, at + 3 * DAY - 1, 20000);
  assert(kept.state.replayBase!.at > day2.state.replayBase!.at);
  assert(kept.state.estimates.clamp !== null);
});

Deno.test("an operator's seed anchors the clamp when history holds no anchor", () => {
  const c = calibrationConfig({ mode: "apply" });
  // Busy throughout: the bank never certifies full, and no limit lifts.
  const h = emptyHistory("test", 1, at);
  const v = Math.round((fit.a * 4.6 + fit.b) / 8 * 10000) / 100;
  const grow = (until: number) => {
    for (let t = (h.slots.at(-1)?.at ?? at - SLOT_MS) + SLOT_MS; t < until; t += SLOT_MS) {
      h.slots.push(slot(t, 4.6));
    }
    for (let t = (h.readings.at(-1)?.at ?? at - 1_800_000) + 1_800_000; t <= until - 3_600_000;) {
      h.readings.push({ at: t, v });
      t += 1_800_000;
    }
  };
  grow(at + DAY);
  const now = at + DAY - 1;
  const unseeded = updateCalibration(p, h, initialCalibration(c, at), c, now, 20000).state;
  assertEquals(unseeded.estimates.clamp, null);
  // A seed sets the base at its own time, after the newest reading: nothing to replay yet.
  const seeded: CalibrationState = {
    ...unseeded,
    replayBase: { at: now, balance: 20000, exact: false, gap: unseeded.gap },
  };
  const held = updateCalibration(p, h, seeded, c, now, 20000).state;
  assertEquals(held.replayBase, seeded.replayBase);
  assertEquals(held.estimates.clamp, 20000);
  // Readings after the seed continue the replay from it.
  grow(at + 2 * DAY);
  const next = updateCalibration(p, h, held, c, at + 2 * DAY - 1, 20000).state;
  assert(next.replayBase!.at > now);
  assert(next.estimates.clamp !== null);
});

Deno.test("an operator's seed goes before an older anchor in history until a newer one", () => {
  const c = calibrationConfig({ mode: "apply" });
  // A bank at capacity on the first night, then busy days.
  const h = emptyHistory("test", 1, at);
  const v = (u: number) => Math.round((fit.a * u + fit.b) / 8 * 10000) / 100;
  for (let t = at; t < at + 3 * DAY; t += SLOT_MS) {
    const idle = t < at + 4 * 3_600_000;
    h.slots.push(slot(t, idle ? 0.05 : 4.6, idle ? FLAGS.atCapacity : 0));
  }
  for (let t = at; t < at + 3 * DAY - 3_600_000; t += 1_800_000) {
    h.readings.push({ at: t, v: v(t <= at + 4 * 3_600_000 ? 0.05 : 4.6) });
  }
  const upTo = (end: number) => ({
    ...h,
    slots: h.slots.filter((x) => x.at < end),
    readings: h.readings.filter((r) => r.at <= end - 3_600_000),
  });
  const day2 = updateCalibration(
    p,
    upTo(at + 2 * DAY),
    initialCalibration(c, at),
    c,
    at + 2 * DAY,
    0,
  );
  // The operator seeds a full bank on day two, which the night's anchor would have replayed lower.
  const seededAt = at + 2 * DAY;
  const seeded: CalibrationState = {
    ...day2.state,
    replayBase: { at: seededAt, balance: p.capacity, exact: false, gap: 0, origin: seededAt },
  };
  const later = updateCalibration(
    p,
    upTo(seededAt + 2 * 3_600_000),
    seeded,
    c,
    seededAt + 2 * 3_600_000 - 1,
    p.capacity,
  );
  // Two hours on, a reading after the seed continues from it, not from the night's anchor.
  assert(later.state.replayBase!.at > seededAt);
  assertEquals(later.state.replayBase!.origin, seededAt);
  const fromNight = updateCalibration(
    p,
    upTo(at + 3 * DAY),
    day2.state,
    c,
    at + 3 * DAY - 1,
    p.capacity,
  );
  assert(later.state.estimates.clamp! > fromNight.state.estimates.clamp!);
});

Deno.test("tracking earns for the time a limited slot didn't press, where the clamp doesn't", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  // A bank at capacity at night, then load above the baseline, and three limited slots that each
  // pressed for 30 s, so neither bank sits at a bound.
  const end = at + 8 * 3_600_000, limitedFrom = at + 6 * 3_600_000;
  const cores = (t: number) => t < at + 4 * 3_600_000 ? 0.05 : 5.5;
  for (let t = at; t < end; t += SLOT_MS) {
    const limited = t >= limitedFrom && t < limitedFrom + 3 * SLOT_MS;
    h.slots.push(
      limited
        ? { ...slot(t, cores(t), FLAGS.limited | FLAGS.pressing), pressed: 30 }
        : slot(t, cores(t), cores(t) < 1 ? FLAGS.atCapacity : 0),
    );
  }
  for (let t = at; t < end; t += 1_800_000) {
    h.readings.push({ at: t, v: Math.round((fit.a * cores(t - 1) + fit.b) / 8 * 10000) / 100 });
  }
  const s = updateCalibration(p, h, { ...initialCalibration(c, at), fit }, c, end - 1, 0).state;
  const base = s.replayBase!;
  assert(base.balance > 0 && base.track! < p.capacity, JSON.stringify(base));
  // Each slot earned the baseline for 570 s in Hostinger's count; the clamp gave it nothing.
  assertAlmostEquals(base.track! - base.balance, 3 * 570 * p.baseline, 0.05 * 3 * 570 * p.baseline);
});

Deno.test("replaying the governor's own estimate earns for the rest of a slot with a probe in it", () => {
  const anchor = { at, balance: 10000, exact: true };
  const probed = { ...slot(at, 2), flags: FLAGS.noEarn, quiet: 30 };
  const earned = replayOwn(p, [probed], anchor, null, at + SLOT_MS).balance;
  assertAlmostEquals(earned - 10000, p.baseline * 570 - probed.charged, 1e-6);
  // A slot from before quiet seconds were kept counts whole, as it did.
  const { quiet: _, ...old } = probed;
  assertAlmostEquals(
    replayOwn(p, [old], anchor, null, at + SLOT_MS).balance,
    10000 - old.charged,
    1e-6,
  );
  // Hostinger's rule earns through a probe either way.
  assertAlmostEquals(
    replayOwn(p, [probed], anchor, null, at + SLOT_MS, 0, true).balance - 10000,
    p.baseline * 600 - probed.charged,
    1e-6,
  );
  // The clamp, a lower bound, still counts a limited slot it didn't earn in as earning nothing.
  const tested = { ...probed, flags: FLAGS.noEarn | FLAGS.limited };
  assertAlmostEquals(
    replayOwn(p, [tested], anchor, null, at + SLOT_MS, 0, false, true).balance,
    10000 - tested.charged,
    1e-6,
  );
});

Deno.test("after a reboot the clamp's empty bank waits for the first whole slot back", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 30 }, (_, i) => slot(at + i * SLOT_MS, 2));
  // The box went down during slot 10 and the daemon came back halfway through slot 11.
  h.slots[10] = { ...h.slots[10], seconds: 200, busy: 400, flags: FLAGS.reboot };
  h.slots[11] = { ...h.slots[11], seconds: 300, busy: 600 };
  // Readings every 30 minutes, one a minute into slot 11, before local samples resumed.
  h.readings = Array.from({ length: 10 }, (_, i) => ({
    at: at + 11 * SLOT_MS + 60_000 + (i - 4) * 1_800_000,
    v: (fit.a * 2 + fit.b) / 8 * 100,
  }));
  const anchors = certifiedAnchorsAndReboots(h);
  // Not the reading a minute into slot 11, whose interval local samples don't cover.
  assertEquals(anchors, [{ at: at + 11 * SLOT_MS + 60_000 + 1_800_000, balance: 0, exact: false }]);
  const s = updateCalibration(p, h, initialCalibration(c, at), c, at + 30 * SLOT_MS - 1, 20000);
  assert(s.state.estimates.clamp !== null);
});

Deno.test("a drift alarm at near-idle load reads the change as an offset, not a steep slope", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  // Four busy hours, then near-idle load, where billing rises by 0.1 cores.
  const cores = (i: number) => i < 24 ? 4 : 0.1;
  h.slots = Array.from({ length: 120 }, (_, i) => slot(at + i * SLOT_MS, cores(i)));
  const all = Array.from({ length: 40 }, (_, i) => {
    const u = cores(Math.max(0, 3 * i - 1));
    return { at: at + i * 1_800_000, v: (fit.a * u + fit.b + (u < 1 ? 0.1 : 0)) / 8 * 100 };
  });
  let s: CalibrationState = {
    ...initialCalibration(c, at),
    fit,
    fitAt: at + 30 * DAY,
    lastPaired: at,
  };
  let alarm: Record<string, unknown> | undefined;
  for (let k = 2; k <= all.length && !alarm; k++) {
    h.readings = all.slice(0, k);
    const r = updateCalibration(p, h, s, c, all[k - 1].at + 60_000, 30000);
    alarm = r.changes.find((d) => d.trigger === "cusum-alarm")?.inputs;
    s = r.state;
  }
  // Read as a slope, 0.1 cores over 0.1 own cores was a multiplier of about 2.
  assert(alarm);
  assert((alarm.a as number) < 1.06, `${alarm.a}`);
  assert(s.pending!.hold.mul < 1.06, `${s.pending!.hold.mul}`);
  assertAlmostEquals(alarm.offset as number, 0.1, 0.02);
});

Deno.test("idle noise is at least what the light-load pairs show", () => {
  // Noise flat at light load and growing above 2 cores: the line through |residual| reaches zero
  // at idle, and every ordinary idle residual would count as extreme.
  const r = seeded(7);
  const pairs = Array.from({ length: 400 }, (_, i) => {
    const own = i % 2 ? 0.1 + r() * 0.5 : 2 + r() * 5;
    const noise = own < 2 ? 0.004 : 0.004 + 0.03 * (own - 2);
    return {
      at: at + i * 1_800_000,
      own,
      host: fit.a * own + fit.b + noise * (2 * r() - 1) * Math.sqrt(3),
    };
  });
  const fitted = fitMeter(pairs)!;
  const light = pairs.filter((x) => x.own < 3)
    .map((x) => Math.abs(x.host - fitted.a * x.own - fitted.b));
  const floor = Math.sqrt(Math.PI / 2) * light.reduce((a, b) => a + b, 0) / light.length;
  assertAlmostEquals(fitted.sigmaFloor!, floor, 1e-12);
  // At idle the line alone gives almost nothing; the floor holds there, and not under load.
  assert(fitted.sigma[0] + fitted.sigma[1] * 0.1 < floor / 2, JSON.stringify(fitted));
  assertEquals(sigmaAt(fitted, 0.1), fitted.sigmaFloor);
  assertEquals(sigmaAt(fitted, 6), fitted.sigma[0] + fitted.sigma[1] * 6);
});

Deno.test("readings turned invalid in this evaluation don't diagnose a limit in it", () => {
  const c = calibrationConfig({ mode: "apply", fit: { min_pairs: 2, min_days: 1 } });
  const h = emptyHistory("test", 1, at);
  h.slots = Array.from({ length: 70 }, (_, i) => slot(at + i * SLOT_MS, 4));
  const normal = (fit.a * 4 + fit.b) / p.vcpus * 100;
  // Readings 10 to 12 report the whole VM busy; the third makes the readings invalid.
  h.readings = Array.from(
    { length: 13 },
    (_, i) => ({ at: at + i * 1_800_000, v: i >= 10 ? 100 : normal }),
  );
  const onset = at + 5 * 3_600_000;
  h.limits = [{
    ...record("apply"),
    onset,
    entry: onset + 90_000,
    lift: onset + 1_800_000,
    class: "credit",
  }];
  const s = initialCalibration(c, at);
  Object.assign(s, {
    fit,
    fitAt: at + 30 * DAY,
    lastPaired: h.readings[9].at,
    pendingLimits: [onset],
  });
  const r = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000);
  assert(r.changes.some((d) => d.trigger === "readings-invalid"));
  // It waits for the next evaluation, which can corroborate the readings or use the own count.
  assert(!r.changes.some((d) => d.trigger === "limit-diagnosis"));
  assertEquals(r.state.pendingLimits, [onset]);
});

Deno.test("the fit after a drift change keeps a configured gap_start", () => {
  const c = calibrationConfig({
    mode: "apply",
    gap_start: 0.02,
    fit: { min_pairs: 2, min_days: 1 },
  });
  const h = emptyHistory("test", 1, at);
  const cores = (j: number) => 3 + j % 3;
  h.slots = Array.from({ length: 160 }, (_, j) => slot(at + j * SLOT_MS, cores(Math.floor(j / 3))));
  h.readings = Array.from({ length: 53 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: (fit.a * cores(i - 1) + fit.b + 0.1) / p.vcpus * 100,
  }));
  const s = initialCalibration(c, at - 14 * DAY);
  // gap_start was raised while the change held, after it opened at a gap of 0.
  Object.assign(s, {
    fit,
    fitAt: at,
    lastPaired: h.readings.at(-1)!.at,
    gap: 0.05,
    pending: {
      at,
      from: { ...c.start },
      gapFrom: 0,
      oldFit: fit,
      fit: { ...fit, b: fit.b + 0.1 },
      hold: { mul: 1.05, add: 0.2, floor: 0.05 },
      readings: 48,
      z: 400,
      verified: true,
      residual: 0,
      n: 0,
    },
  });
  const r = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000);
  assertEquals(r.state.pending, null);
  assertEquals(r.state.gap, 0.02);
});

Deno.test("a lift test presses for part of its slot, so the slot still earns and recovery predicts", () => {
  const h = emptyHistory("test", 1, at);
  const lift = at + 3 * 2_880_000;
  const limit = { ...record(), lift, class: "credit" as const };
  h.readings = Array.from({ length: 49 }, (_, i) => ({ at: at + i * 1_800_000, v: 30 }));
  // Every recovery slot holds a 30-second lift test that pressed on the limit.
  const tested = (pressed?: number) =>
    Array.from({ length: 144 }, (_, i) => ({
      ...slot(at + i * SLOT_MS, 2.4, FLAGS.limited | FLAGS.pressing | FLAGS.test),
      ...(pressed === undefined ? {} : { pressed }),
    }));
  const predicted = (slots: ReturnType<typeof tested>) =>
    predictRecovery(p, { ...h, slots }, limit, 0, null, []).predicted;
  const seconds = predicted(tested(30))!;
  // The baseline earns for 570 of each 600 seconds while readings bill 2.4 cores.
  assertAlmostEquals(seconds, p.recovered / (p.baseline * 570 / 600 - 2.4), 1);
  // Counted as pressing throughout, as before pressing seconds were kept, it never predicts.
  assertEquals(predicted(tested()), null);
  // The clamp, a lower bound, still takes a slot that pressed at all as earning nothing.
  const anchor = { at, balance: 0, exact: true };
  const replay = (wholeSlots: boolean) =>
    replaySettled(p, h.readings, tested(30), anchor, { wholeSlots }).balance;
  assert(replay(true) < replay(false), `${replay(true)} ${replay(false)}`);
  assertEquals(replay(true), 0);
});

Deno.test("a clock-invalid run bridged during a limit keeps the limit and its pressing share", () => {
  const slots = [
    slot(at, 3, FLAGS.limited),
    { ...slot(at + SLOT_MS, 3, FLAGS.limited | FLAGS.pressing | FLAGS.clockInvalid), pressed: 300 },
    slot(at + 3 * SLOT_MS, 3, FLAGS.limited),
  ];
  const { slots: bridged } = clockBridged(slots);
  // The run and the hole after it become whole slots that still earn nothing for half their time.
  const run = bridged.filter((x) => x.at >= at + SLOT_MS && x.at < at + 3 * SLOT_MS);
  assertEquals(run.length, 2);
  for (const x of run) {
    assert(x.flags & FLAGS.limited);
    assertAlmostEquals(x.pressed!, 300, 1e-9);
  }
});

Deno.test("a fit catches a broken feed even when the box has gone too idle to refit", () => {
  const c = calibrationConfig({ mode: "apply" });
  const h = emptyHistory("test", 1, at);
  // Fourteen idle days: no pair at 3 cores or more, so the window no longer qualifies.
  h.slots = Array.from({ length: 30 }, (_, i) => slot(at + i * SLOT_MS, 0.2));
  h.readings = Array.from({ length: 10 }, (_, i) => ({
    at: at + i * 1_800_000,
    v: i >= 6 ? 90 : (fit.a * 0.2 + fit.b) / p.vcpus * 100,
  }));
  const s = { ...initialCalibration(c, at), fit, fitAt: at + 30 * DAY, lastPaired: at };
  const r = updateCalibration(p, h, s, c, h.readings.at(-1)!.at + 60_000, 30000);
  assertEquals(r.changes.find((d) => d.trigger === "readings-invalid")?.inputs.reasons, [
    "residuals",
  ]);
});

// The clamp's anchors in a history without limits or a bank at capacity: reboots alone.
function certifiedAnchorsAndReboots(h: History) {
  return historyAnchors(p, h, 0);
}
