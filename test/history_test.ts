import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  accumulateSlot,
  addSlots,
  boundHistory,
  DAY,
  DECISIONS_KEPT,
  decodeHistory,
  decodeHistoryFiles,
  decodeSnapshot,
  emptyHistory,
  encodeHistory,
  FLAGS,
  HistoryStore,
  type LimitRecord,
  LIMITS_KEPT,
  logPath,
  mergeFetchReadings,
  mergeReadings,
  newestFinal,
  pruneQuarantine,
  readHistory,
  readHistoryFiles,
  REVISIONS_KEPT,
  roundedSlot,
  SLOT_MS,
  validLimit,
  withOpenSlot,
} from "../src/history.ts";
import { writeText } from "../src/storage.ts";
import {
  CALIBRATION,
  calibrationConfig,
  initialCalibration,
  inputsDigest,
  seeded,
  updateCalibration,
} from "../src/calibration.ts";
import { recordedEvidence } from "../src/governor.ts";
import { plan } from "../src/plans.ts";
import { testDirectory } from "./temp.ts";

const at = Date.parse("2026-10-12T00:00:00Z");
Deno.test("history merge deduplicates timestamps and records revisions above 0.01 points", () => {
  const h = emptyHistory("8:4.8:34560", 123, at);
  mergeReadings(h, [{ at, v: 30 }, { at: at + 1_800_000, v: 40 }], at + DAY);
  mergeReadings(h, [{ at, v: 30.01 }, { at: at + 1_800_000, v: 41 }], at + DAY);
  assertEquals(h.readings.length, 2);
  assertEquals(h.revisions, [{ at: at + 1_800_000, old: 40, new: 41, seenAt: at + DAY }]);
  assertEquals(decodeHistory(encodeHistory(h), h.planKey, 123), h);
});

Deno.test("a newest reading that settles at another value is a revision, and newestFinal needs evidence", () => {
  const h = emptyHistory("k", 1, at);
  const fetch = (newest: number, v: number, now: number) =>
    mergeFetchReadings(h, [{ at, v: 30 }, { at: newest, v }], now);
  fetch(at + 1_800_000, 10, at + 1_900_000);
  // Seven days without revisions mean nothing until newest readings have been seen again.
  assertEquals(newestFinal(h, at + 8 * DAY), false);
  mergeFetchReadings(
    h,
    [{ at, v: 30 }, { at: at + 1_800_000, v: 50 }, { at: at + 3_600_000, v: 20 }],
    at + 3_700_000,
  );
  assertEquals(h.revisions, [{ at: at + 1_800_000, old: 10, new: 50, seenAt: at + 3_700_000 }]);
  assertEquals(h.readings.at(-1), { at: at + 1_800_000, v: 50 });
  assertEquals(newestFinal(h, at + 3_700_000 + 7 * DAY - 1), false);
  assertEquals(newestFinal(h, at + 3_700_000 + 7 * DAY), true);
  // Seeing the newest value again unchanged counts as evidence without a revision.
  const quiet = emptyHistory("k", 1, at);
  mergeFetchReadings(quiet, [{ at, v: 30 }, { at: at + 1_800_000, v: 10 }], at + 1_900_000);
  mergeFetchReadings(
    quiet,
    [{ at, v: 30 }, { at: at + 1_800_000, v: 10 }, { at: at + 3_600_000, v: 20 }],
    at + 3_700_000,
  );
  assertEquals(quiet.revisions, []);
  assertEquals(quiet.newestSince, at + 3_700_000);
  assertEquals(newestFinal(quiet, at + 3_700_000 + 7 * DAY), true);
});

Deno.test("UTC slots split samples and retain all observed CPU", () => {
  const r = accumulateSlot(undefined, {
    from: at + 590_000,
    to: at + 620_000,
    seconds: 30,
    busy: 60,
    steal: 3,
    managed: 45,
    outside: 15,
    charged: 64,
    flags: 0,
  });
  assertEquals(r.closed.length, 1);
  assertEquals(r.closed[0].at, at);
  assertEquals(r.closed[0].seconds + r.open!.seconds, 30);
  assertEquals(r.closed[0].busy + r.open!.busy, 60);
  const invalid = accumulateSlot(r.open, {
    from: at,
    to: at - 3_600_000,
    seconds: 30,
    busy: 0,
    steal: 0,
    managed: 0,
    outside: 0,
    charged: 0,
    flags: 0,
  });
  assert(invalid.closed[0].flags & FLAGS.clockInvalid);
});

Deno.test("a slot keeps the seconds the governor's estimate didn't earn, through the file", () => {
  // A 30-second probe inside an otherwise earning slot.
  const open = accumulateSlot(undefined, {
    from: at,
    to: at + 570_000,
    seconds: 570,
    busy: 570,
    steal: 0,
    managed: 570,
    outside: 0,
    charged: 600,
    flags: 0,
  }).open;
  const closed = accumulateSlot(open, {
    from: at + 570_000,
    to: at + 600_000,
    seconds: 30,
    busy: 30,
    steal: 0,
    managed: 30,
    outside: 0,
    charged: 32,
    flags: FLAGS.noEarn,
  }).closed;
  assertEquals(closed[0].quiet, 30);
  assert(closed[0].flags & FLAGS.noEarn);
  const h = emptyHistory("k", 1, at);
  addSlots(h, closed);
  assertEquals(decodeHistory(encodeHistory(h), "k", 1).slots, h.slots);
});

Deno.test("history keeps 90 days of rows, the last 50 limits and the last 100 decisions", () => {
  const h = emptyHistory("8:4.8:34560", 123, at);
  h.slots = Array.from({ length: 90 * 144 }, (_, i) => ({
    at: at + i * SLOT_MS,
    seconds: 600,
    busy: 4711.12,
    steal: 111.11,
    managed: 4521.32,
    outside: 189.8,
    charged: 4995.21,
    // Every flag at once, the unobserved mark after a long stop included.
    flags: Object.values(FLAGS).reduce((a, b) => a | b, 0),
  }));
  h.readings = Array.from({ length: 90 * 48 }, (_, i) => ({ at: at + i * 1_800_000, v: 99.99 }));
  h.meterPairs = h.readings.slice(1).map((r, i) => ({
    at: r.at,
    from: h.readings[i].at,
    own: 4,
    seconds: 1800,
  }));
  h.revisions = [at, at + 2 * DAY].map((seenAt) => ({ at: seenAt, old: 1, new: 2, seenAt }));
  const limit = (onset: number) => ({
    onset,
    entry: onset,
    path: "evident" as const,
    balance: 0,
    used: 0,
    settings: { mul: 1.05, add: 0.04, floor: 0.05 },
    gap: 0,
    mode: "apply" as const,
    track: null,
    caps: [],
    confirmed: false,
    learn: false,
  });
  h.limits = Array.from({ length: 60 }, (_, i) => limit(at + i));
  h.calibrations = Array.from({ length: 120 }, (_, i) => ({
    at: at + i,
    trigger: "fit" as const,
    inputs: {},
    digest: "0",
    from: { mul: 1.05, add: 0.04, floor: 0.05 },
    to: { mul: 1.05, add: 0.04, floor: 0.05 },
    mode: "apply" as const,
  }));
  boundHistory(h, at + 91 * DAY);
  assertEquals(h.slots.length, 89 * 144);
  assertEquals(h.readings.length, 89 * 48);
  assertEquals(h.meterPairs.length, 89 * 48);
  assertEquals(h.revisions.map((r) => r.seenAt), [at + 2 * DAY]);
  assertEquals(h.limits.map((r) => r.onset), Array.from({ length: 50 }, (_, i) => at + 10 + i));
  assertEquals(h.calibrations.length, 100);
  assertEquals(h.calibrations[0].at, at + 20);
  assertEquals(decodeHistory(encodeHistory(h), h.planKey, 123), h);
});

Deno.test("every field of a limit record has its type, so explain can print it", () => {
  const c = calibrationConfig({ mode: "apply" });
  const diagnosis = {
    gap: 0.0312,
    source: "readings" as const,
    anchor: { at: at - DAY, balance: 6912, exact: true },
    onset: at,
    eta: 1234.4,
    explained: false,
    left: 812.6,
    beyond: false,
    bridged: 1800,
    held: 0.31,
    lower: 0.021,
  };
  const record: LimitRecord = {
    onset: at,
    entry: at + 90_000,
    path: "probe",
    balance: 2000,
    used: 50000,
    settings: { ...c.start },
    gap: 0.03,
    mode: "apply",
    track: 1500,
    caps: [{ at: at + 90_000, busy: 1.2, demand: 1.9, ceiling: 120, pressing: true }],
    firstTest: "limited",
    testDelivery: { busy: 1.2, demand: 1.8 },
    testCandidate: { busy: 4, demand: 5 },
    legacyLearned: true,
    confirmed: true,
    learn: true,
    limitedAt: at + 3_600_000,
    lift: at + 7_200_000,
    recovery: { elapsedSeconds: 7000, estimatedRecoverySeconds: null, estimatedPausedSeconds: 30 },
    class: "credit",
    diagnosis,
    heldGap: 0.31,
    acted: 1800,
    restored: true,
    liftCheck: { at: at + 7_300_000, predicted: 6800, ratio: 1.03 },
  };
  assert(validLimit(record));
  assert(validLimit({ ...record, track: null, liftCheck: { at, predicted: null, ratio: null } }));
  assert(
    validLimit({ ...record, diagnosis: { ...diagnosis, gap: null, anchor: null, left: null } }),
  );
  const { track: _, ...carried } = record;
  assert(validLimit(carried as LimitRecord));
  // The earlier records a diagnosis read come with its inputs, without their own.
  const earlier = { limits: [{ ...record, onset: at - DAY }], future: true };
  assert(validLimit({ ...record, diagnosisEvidence: earlier } as unknown as LimitRecord));
  const bad: [string, unknown][] = [
    ["track", "1500"],
    ["firstTest", "maybe"],
    ["testDelivery", { busy: 1.2 }],
    ["testCandidate", { busy: "4", demand: 5 }],
    ["legacyLearned", 1],
    ["restored", "yes"],
    ["diagnosis", { ...diagnosis, anchor: "yesterday" }],
    ["diagnosis", { ...diagnosis, anchor: { at, balance: 6912 } }],
    ["diagnosis", { ...diagnosis, source: "\u001b[2Jreadings" }],
    ["diagnosis", { ...diagnosis, eta: null }],
    ["diagnosis", { ...diagnosis, explained: "no" }],
    ["diagnosis", { ...diagnosis, bridged: "1800" }],
    ["diagnosis", { ...diagnosis, beyond: 1 }],
    ["diagnosisEvidence", "inputs"],
    ["diagnosisEvidence", { limits: [{ ...record, confirmed: "yes" }] }],
    ["diagnosisEvidence", { limits: "earlier" }],
    ["liftCheck", { at, predicted: "6800", ratio: null }],
    ["recovery", {
      elapsedSeconds: 7000,
      estimatedRecoverySeconds: "x",
      estimatedPausedSeconds: 0,
    }],
  ];
  for (const [key, value] of bad) {
    assert(!validLimit({ ...record, [key]: value } as LimitRecord), key);
  }
  // In the file, a record with a malformed diagnosis is dropped alone.
  const h = emptyHistory("k", 1, at);
  h.limits = [
    { ...record, onset: at - 1 },
    { ...record, diagnosis: { ...diagnosis, anchor: "yesterday" as unknown as null } },
  ];
  const { history, dropped } = decodeHistoryFiles({ snapshot: encodeHistory(h), log: "" }, "k", 1);
  assertEquals(history.limits, [h.limits[0]]);
  assertEquals(dropped, ["limit records (1)"]);
});

Deno.test("a log left without its snapshot is set aside, not emptied", async () => {
  const dir = await testDirectory("history-orphan-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    await Deno.writeTextFile(logPath(path), '{"generation":1,"seq":1}\n');
    const store = new HistoryStore(path, (s) => logs.push(s));
    const h = await store.load("k", 1, at);
    assertEquals(h.readings, []);
    assertEquals(logs, ["history rebuilt: missing", "history log without a snapshot set aside"]);
    store.write(h, at);
    await store.close();
    assertEquals(
      await Deno.readTextFile(`${logPath(path)}.bad-${at / 1000}`),
      '{"generation":1,"seq":1}\n',
    );
    assertEquals(await Deno.readTextFile(logPath(path)), "");
    // A first start has no log to set aside.
    const first = `${dir}/first.json`, quiet: string[] = [];
    await new HistoryStore(first, (s) => quiet.push(s)).load("k", 1, at);
    assertEquals(quiet, ["history rebuilt: missing"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("history store writes mode 0600 and rebuilds corrupt and mismatched files", async () => {
  const dir = await testDirectory("history-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const store = new HistoryStore(path, (s) => logs.push(s));
    const h = await store.load("plan-a", 1, at);
    store.write(h, at);
    await store.close();
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(await store.load("plan-a", 1, at), h);
    await Deno.writeTextFile(path, "broken");
    assertEquals((await store.load("plan-a", 1, at)).readings, []);
    assert((await Deno.stat(`${path}.bad-${at / 1000}`)).isFile);
    store.write(h, at);
    await store.close();
    assertEquals((await store.load("plan-a", 2, at + 1000)).vmId, 2);
    assertEquals(logs.length, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshots replace the file through a temporary file and rename", async () => {
  const dir = await testDirectory("history-atomic-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const store = new HistoryStore(path, (s) => logs.push(s));
    const h = emptyHistory("k", 1, at);
    store.write(h, at);
    await store.close();
    const before = await Deno.readTextFile(path);
    // A day later the store compacts. One that cannot replace its temporary file, here a directory
    // holding a file, leaves the previous snapshot intact, and the next write tries again.
    await Deno.mkdir(`${path}.tmp`);
    await Deno.writeTextFile(`${path}.tmp/held`, "");
    mergeReadings(h, [{ at, v: 30 }], at);
    store.write(h, at + DAY);
    await store.close();
    assertEquals(await Deno.readTextFile(path), before);
    assert(logs.some((s) => s.startsWith("history write failed")));
    await Deno.remove(`${path}.tmp`, { recursive: true });
    assert(!store.durable);
    // The whole snapshot is tried again after 10 minutes, not on every pass.
    store.write(h, at + DAY + 300_000);
    await store.close();
    assertEquals(await Deno.readTextFile(path), before);
    store.write(h, at + DAY + 600_000);
    await store.close();
    assert(store.durable);
    assertEquals((await store.load("k", 1, at)).readings, [{ at, v: 30 }]);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a moving newest timestamp never becomes a phantom settled reading", () => {
  const h = emptyHistory("k", 1, at);
  mergeFetchReadings(h, [{ at, v: 30 }, { at: at + 1_000_000, v: 99 }], at + 1_000_000);
  mergeFetchReadings(
    h,
    [{ at, v: 30 }, { at: at + 1_800_000, v: 31 }, { at: at + 2_000_000, v: 70 }],
    at + 2_000_000,
  );
  assertEquals(h.readings, [{ at, v: 30 }, { at: at + 1_800_000, v: 31 }]);
  assertEquals(h.unsettled, { at: at + 2_000_000, v: 70 });
  mergeFetchReadings(
    h,
    [{ at, v: 30 }, { at: at + 1_800_000, v: 31 }, { at: at + 2_000_000, v: 71 }],
    at + 2_100_000,
  );
  assertEquals(h.revisions.at(-1), {
    at: at + 2_000_000,
    old: 70,
    new: 71,
    seenAt: at + 2_100_000,
  });
});

Deno.test("the full 90-day store including revisions, limits, decisions and replay inputs fits 1 MB", () => {
  const h = emptyHistory("8:4.8:34560", 123, at);
  const random = seeded(91);
  const round = (n: number) => Math.round(n * 100) / 100;
  // As the daemon stores them: observed seconds to 10 ms, readings 1,520 to 2,080 s apart on whole
  // seconds, and meter pairs at full precision over their observed seconds.
  h.slots = Array.from({ length: 90 * 144 }, (_, i) => {
    const busy = round(random() * 4800), outside = round(random() * 120);
    return {
      at: at + i * SLOT_MS,
      seconds: round(599 + random() * 2),
      busy,
      steal: round(random() * 60),
      managed: round(Math.max(0, busy - outside)),
      outside,
      charged: round(1.05 * busy + 24),
      flags: 0,
    };
  });
  for (let t = at; t < at + 90 * DAY; t += Math.round(1520 + random() * 560) * 1000) {
    h.readings.push({ at: t, v: round(random() * 100) });
  }
  h.meterPairs = h.readings.slice(1).map((r, i) => ({
    at: r.at,
    from: h.readings[i].at,
    own: random() * 8,
    seconds: (r.at - h.readings[i].at) / 1000 * (0.995 + random() * 0.01),
  }));
  h.revisions = h.readings.map((r) => ({
    at: r.at,
    old: round(random() * 100),
    new: r.v,
    seenAt: r.at + 1_800_000,
  }));
  const c = calibrationConfig({ mode: "apply" });
  h.limits = Array.from({ length: 50 }, (_, i) => ({
    onset: at + i * DAY,
    entry: at + i * DAY + 90_000,
    path: "evident",
    balance: 2000,
    used: 50000,
    settings: { ...c.start },
    gap: 0.03,
    mode: "apply",
    track: 1000,
    caps: Array.from(
      { length: 6 },
      (_, j) => ({
        at: at + i * DAY + j * 1_800_000,
        busy: 2.4,
        demand: 6,
        ceiling: 200,
        pressing: true,
      }),
    ),
    confirmed: true,
    learn: true,
    lift: at + i * DAY + 7_200_000,
    class: "credit",
  }));
  h.calibrations = Array.from(
    { length: 100 },
    (_, i) => ({
      at: at + i * 1_800_000,
      trigger: "fit",
      inputs: {
        gap: 0.03,
        fit: { a: 1.0463, b: 0.0193, aHi: 1.051, sigma: [0.0214, 0.0119], pairs: 672, days: 14 },
      },
      digest: "12345678",
      from: { ...c.start },
      to: { ...c.start, mul: 1.051 },
      mode: "apply",
    }),
  );
  for (const [i, limit] of h.limits.entries()) {
    limit.diagnosisEvidence = {
      config: c,
      upper: 0.167,
      fit: null,
      anchor: i ? { at: h.limits[i - 1].lift!, balance: plan(8).recovered, exact: true } : null,
      readings: i ? h.readings.slice((i - 1) * 48 + 4, i * 48 + 2) : [],
      slots: i ? h.slots.slice((i - 1) * 144 + 12, i * 144 + 3) : [],
    };
  }
  const evidence = structuredClone(h), before = initialCalibration(c, at), now = at + 90 * DAY;
  h.checkpoint = {
    at: now,
    open: 10000,
    config: c,
    before,
    history: evidence,
    digest: inputsDigest(updateCalibration(plan(8), evidence, before, c, now, 10000)),
  };
  const encoded = encodeHistory(h);
  const bytes = new TextEncoder().encode(encoded).length;
  assert(bytes < 1_000_000, `${bytes} bytes including all retained evidence`);
  const decoded = decodeHistory(encoded, h.planKey, 123);
  assertEquals(decoded.revisions, h.revisions);
  assertEquals(decoded.limits, h.limits);
  assertEquals(decoded.calibrations, h.calibrations);
  assertEquals(decoded.checkpoint, h.checkpoint);
});

Deno.test("checkpoint references preserve evidence across pruning, revisions and clock flags", () => {
  const h = emptyHistory("k", 1, at), c = calibrationConfig({ mode: "shadow" });
  h.slots = Array.from(
    { length: 3 },
    (_, i) => ({
      at: at + i * SLOT_MS,
      seconds: 600,
      busy: 1200,
      steal: 0,
      managed: 1200,
      outside: 0,
      charged: 1284,
      flags: 0,
    }),
  );
  h.readings = [{ at, v: 25 }, { at: at + 1_800_000, v: 25 }];
  h.meterPairs = [{ at: at + 1_800_000, from: at, own: 2, seconds: 1800 }];
  const evidence = structuredClone(h), before = initialCalibration(c, at), now = at + 1_800_000;
  h.checkpoint = {
    at: now,
    open: 10000,
    config: c,
    before,
    history: evidence,
    digest: inputsDigest(updateCalibration(plan(8), evidence, before, c, now, 10000)),
  };
  h.slots.shift();
  h.slots[0].flags |= FLAGS.clockInvalid;
  h.readings[1].v = 30;
  h.readings.splice(1, 0, { at: at + 900_000, v: 26 });
  h.meterPairs[0].own = 3;
  const restored = decodeHistory(encodeHistory(h), "k", 1);
  assertEquals(restored.checkpoint?.history, evidence);
  restored.slots[0].flags = 0;
  assertEquals(restored.checkpoint?.history, evidence);
});

Deno.test("history files of another version, plan or VM are rejected", () => {
  const h = emptyHistory("k", 1, at);
  const file = JSON.parse(encodeHistory(h));
  assertEquals(decodeHistory(JSON.stringify(file), "k", 1), h);
  for (const changed of [{ version: 2 }, { planKey: "other" }, { vmId: 2 }, { data: 1 }]) {
    assertThrows(() => decodeHistory(JSON.stringify({ ...file, ...changed }), "k", 1));
  }
  assertThrows(() => decodeHistory(JSON.stringify({ ...h, readings: [] }), "k", 1));
  // History gathered without a VM had no readings: it binds to the one configured, as rollout step 2
  // adds it. History bound to a VM stays bound when the config names none.
  const unbound = encodeHistory(emptyHistory("k", null, at));
  assertEquals(decodeSnapshot(unbound, "k", 1).history.vmId, 1);
  assertEquals(decodeSnapshot(unbound, "k", 1).rebound, true);
  assertEquals(decodeSnapshot(JSON.stringify(file), "k", null).history.vmId, 1);
  assertEquals(decodeSnapshot(JSON.stringify(file), "k", null).rebound, false);
});

Deno.test("history bound to a VM on its first start with one is compacted at once", async () => {
  const dir = await testDirectory("history-bind-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const store = new HistoryStore(path, (line) => logs.push(line));
    const h = emptyHistory("k", null, at);
    h.slots.push({
      at,
      seconds: 600,
      busy: 60,
      steal: 0,
      managed: 60,
      outside: 0,
      charged: 64,
      flags: 0,
    });
    store.write(h, at);
    await store.close();
    const bound = new HistoryStore(path, (line) => logs.push(line));
    const loaded = await bound.load("k", 7, at);
    assertEquals([loaded.vmId, loaded.slots.length], [7, 1]);
    bound.write(loaded, at + 1);
    await bound.close();
    // The snapshot says VM 7 now, so another VM can't adopt what VM 7's readings joined.
    assertEquals(JSON.parse(await Deno.readTextFile(path)).vmId, 7);
    assertThrows(() => decodeSnapshot(Deno.readTextFileSync(path), "k", 8));
    assert(logs.some((line) => line.includes("bound to VM 7")), logs.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A day of the writes the daemon makes, each checked against what a restart would read back.
Deno.test("between daily compactions history only appends, and the files always equal memory", async () => {
  const dir = await testDirectory("history-log-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const store = new HistoryStore(path, (s) => logs.push(s));
    const c = calibrationConfig({ mode: "shadow" });
    const h = emptyHistory("k", 1, at);
    const slot = (t: number, flags = 0) => ({
      at: t,
      seconds: 600,
      busy: 1200,
      steal: 0,
      managed: 1200,
      outside: 0,
      charged: 1284,
      flags,
    });
    for (let t = at; t < at + 6 * SLOT_MS; t += SLOT_MS) addSlots(h, [slot(t)]);
    mergeFetchReadings(h, [{ at, v: 25 }, { at: at + 1_800_000, v: 25 }], at + 1_900_000);
    store.write(h, at + 1_900_000);
    await store.close();
    const snapshot = await Deno.readTextFile(path);
    let log = "";
    const checkpoint = (now: number) => {
      const evidence = structuredClone({ ...h, calibrations: [], revisions: [] });
      delete evidence.checkpoint;
      h.checkpoint = {
        at: now,
        open: 1000,
        config: c,
        before: initialCalibration(c, now),
        history: evidence,
        digest: "0",
      };
    };
    const record = (onset: number) => ({
      onset,
      entry: onset + 90_000,
      path: "evident" as const,
      balance: 2000,
      used: 50000,
      settings: { ...c.start },
      gap: 0,
      mode: "shadow" as const,
      track: null,
      caps: [{ at: onset + 90_000, busy: 2.4, demand: 6, ceiling: 200, pressing: true }],
      confirmed: false,
      learn: true,
    });
    const steps: ((now: number) => void)[] = [
      // The first slot after a long stop is unobserved.
      (now) => addSlots(h, [slot(now - SLOT_MS, FLAGS.unobserved | FLAGS.noEarn)]),
      // A fetch revises a stored reading and settles a newer one.
      (now) =>
        mergeFetchReadings(h, [{ at, v: 26 }, { at: at + 1_800_000, v: 25 }, {
          at: at + 3_600_000,
          v: 30,
        }, { at: now, v: 31 }], now),
      // A late duplicate marks an existing slot's clock invalid in place.
      () => addSlots(h, [slot(at + SLOT_MS)]),
      (now) => {
        h.limits.push(record(now - 600_000));
        checkpoint(now);
      },
      (now) => {
        const r = h.limits[0];
        r.caps.push({ at: now, busy: 2.3, demand: 6, ceiling: 200, pressing: false });
        r.lift = now;
        r.confirmed = true;
        r.class = "credit";
        h.calibrations.push({
          at: now,
          trigger: "limit-classified",
          inputs: { onset: r.onset },
          digest: "1",
          from: { ...c.start },
          to: { ...c.start },
          mode: "shadow",
        });
      },
      (now) => {
        checkpoint(now);
        // A fetch lands between the evaluation and the write.
        mergeFetchReadings(h, [{ at: at + 3_600_000, v: 30 }, { at: now, v: 33 }], now);
        h.limits[0].diagnosisEvidence = {
          config: c,
          upper: 0.167,
          fit: null,
          anchor: { at, balance: 34560, exact: true },
          readings: structuredClone(h.readings),
          slots: structuredClone(h.slots),
        };
      },
      (now) => {
        h.limits.push({ ...record(now - 300_000), class: "credit", lift: now });
        h.limits[1].diagnosisEvidence = {
          ...h.limits[0].diagnosisEvidence!,
          slots: structuredClone(h.slots.slice(2)),
        };
        delete h.limits[0].diagnosisEvidence;
        h.meterPairs = [{ at: at + 3_600_000, from: at + 1_800_000, own: 2, seconds: 1800 }];
      },
      (now) => {
        h.since = at - DAY;
        addSlots(h, [slot(now - SLOT_MS)]);
        checkpoint(now);
      },
    ];
    let now = at + 1_900_000;
    for (const step of steps) {
      now += 1_800_000;
      step(now);
      store.write(h, now);
      await store.close();
      assertEquals(await Deno.readTextFile(path), snapshot);
      const next = await Deno.readTextFile(logPath(path));
      assert(next.startsWith(log) && next.length > log.length);
      log = next;
      const disk = await readHistory(path, "k", 1);
      assert(disk.clean);
      assertEquals(disk.history, h);
    }
    // A day after the last compaction, the snapshot absorbs the log.
    store.write(h, at + 1_900_000 + DAY);
    await store.close();
    assert(await Deno.readTextFile(path) !== snapshot);
    assertEquals(await Deno.readTextFile(logPath(path)), "");
    assertEquals((await readHistory(path, "k", 1)).history, h);
    assertEquals(logs, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a crash mid-append or mid-compaction loses at most the write in flight", async () => {
  const dir = await testDirectory("history-crash-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const store = new HistoryStore(path, (s) => logs.push(s));
    const h = emptyHistory("k", 1, at);
    store.write(h, at);
    for (let i = 1; i <= 3; i++) {
      mergeReadings(h, [{ at: at + i * 1_800_000, v: 20 + i }], at + i * 1_800_000);
      store.write(h, at + i * 1_800_000);
    }
    await store.close();
    // A torn last line ends the replay; the next write compacts what was read.
    const full = await Deno.readTextFile(logPath(path));
    await Deno.writeTextFile(logPath(path), full.slice(0, -10));
    const torn = await store.load("k", 1, at + 4 * 1_800_000);
    assertEquals(torn.readings.map((r) => r.v), [21, 22]);
    assert(logs.includes("history log ends early; compacting on the next write"));
    store.write(torn, at + 4 * 1_800_000);
    await store.close();
    assertEquals(await Deno.readTextFile(logPath(path)), "");
    // Lines from the previous generation, left when a crash skips the log reset, are ignored.
    const stale = '{"generation":0,"seq":1,"readings":[[' + at / 1000 + ",9999]]}\n";
    await Deno.writeTextFile(logPath(path), stale);
    const restored = await store.load("k", 1, at + 5 * 1_800_000);
    assertEquals(restored.readings.map((r) => r.v), [21, 22]);
    // An unreadable line in the middle keeps the lines before it.
    mergeReadings(restored, [{ at: at + 3 * 1_800_000, v: 23 }], at + 5 * 1_800_000);
    store.write(restored, at + 5 * 1_800_000);
    await store.close();
    await Deno.writeTextFile(logPath(path), "not json\n", { append: true });
    const prefix = await readHistory(path, "k", 1);
    assertEquals(prefix.clean, false);
    assertEquals(prefix.history.readings.map((r) => r.v), [21, 22, 23]);
    // A last line that lost only its newline still reads, but the next write compacts rather than
    // append onto it, so everything after it reads back too.
    const kept = await store.load("k", 1, at + 6 * 1_800_000);
    store.write(kept, at + 6 * 1_800_000);
    mergeReadings(kept, [{ at: at + 4 * 1_800_000, v: 24 }], at + 6 * 1_800_000);
    store.write(kept, at + 6 * 1_800_000);
    await store.close();
    const log = await Deno.readTextFile(logPath(path));
    await Deno.writeTextFile(logPath(path), log.slice(0, -1));
    const unterminated = await store.load("k", 1, at + 6 * 1_800_000);
    assertEquals(unterminated.readings.map((r) => r.v), [21, 22, 23, 24]);
    mergeReadings(unterminated, [{ at: at + 5 * 1_800_000, v: 25 }], at + 6 * 1_800_000);
    store.write(unterminated, at + 6 * 1_800_000);
    await store.close();
    const reread = await readHistory(path, "k", 1);
    assertEquals(reread.history.readings.map((r) => r.v), [21, 22, 23, 24, 25]);
    // A line whose newestSince isn't a time ends the replay there, without costing the file.
    await Deno.writeTextFile(
      logPath(path),
      JSON.stringify({
        generation: reread.meta.generation,
        seq: reread.meta.seq + 1,
        newestSince: "x",
      }) +
        "\n",
      { append: true },
    );
    const badField = await readHistory(path, "k", 1);
    assertEquals(badField.clean, false);
    assertEquals(badField.history.readings.map((r) => r.v), [21, 22, 23, 24, 25]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a history file this run cannot read stays in place and is not written over", async () => {
  const dir = await testDirectory("history-unreadable-");
  const path = `${dir}/history.json`;
  try {
    // Root reads a mode-000 file anyway, so only an unprivileged run can stage an unreadable file.
    const probe = `${dir}/mode-000`;
    await Deno.writeTextFile(probe, "");
    await Deno.chmod(probe, 0o000);
    if (await Deno.readTextFile(probe).then(() => true, () => false)) return;
    const store = new HistoryStore(path, () => {});
    const h = await store.load("plan-a", 1, at);
    mergeFetchReadings(h, [{ at, v: 25 }, { at: at + 1_800_000, v: 25 }], at + 1_900_000);
    store.write(h, at + 1_900_000);
    await store.close();
    const before = await Deno.readTextFile(path);
    await Deno.chmod(path, 0o000);
    const logs: string[] = [];
    const later = new HistoryStore(path, (m) => logs.push(m));
    assertEquals((await later.load("plan-a", 1, at + DAY)).readings, []);
    later.write(emptyHistory("plan-a", 1, at + DAY), at + DAY);
    await later.close();
    await Deno.chmod(path, 0o600);
    // Not quarantined and not replaced: the next run reads it again.
    assertEquals(await Deno.readTextFile(path), before);
    assert(logs.some((m) => m.includes("unreadable")), logs.join("; "));
    await assertRejects(() => Deno.stat(`${path}.bad-${(at + DAY) / 1000}`));
  } finally {
    await Deno.chmod(path, 0o600).catch(() => {});
    await Deno.chmod(`${dir}/mode-000`, 0o600).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every history reader keeps the daemon's last 100 decisions and 50 limits", async () => {
  const dir = await testDirectory("history-retention-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = await store.load("plan-a", 1, at);
    const decision = (i: number) => ({
      at: at + i,
      trigger: "fit" as const,
      inputs: { i },
      digest: "0",
      from: { mul: 1.05, add: 0.04, floor: 0.05 },
      to: { mul: 1.05, add: 0.04, floor: 0.05 },
      mode: "shadow" as const,
    });
    h.calibrations = Array.from({ length: 100 }, (_, i) => decision(i));
    store.write(h, at);
    // The 101st decision only reaches the log; the daemon's own history drops the oldest.
    h.calibrations = [...h.calibrations.slice(1), decision(100)];
    store.write(h, at + 1000);
    await store.close();
    const { history } = await readHistory(path, "plan-a", 1);
    assertEquals(history.calibrations.length, 100);
    assertEquals(history.calibrations[0].inputs, { i: 1 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a clock-invalid observation closes a rounded slot and keeps a reboot mark", () => {
  const open = {
    at,
    seconds: 300.123456,
    busy: 600.987654,
    steal: 0,
    managed: 600.987654,
    outside: 0,
    charged: 640.555555,
    flags: 0,
  };
  const { closed, open: next } = accumulateSlot(open, {
    from: at + 300_000,
    to: at + 4_000_000,
    seconds: 30,
    busy: 60,
    steal: 0,
    managed: 60,
    outside: 0,
    charged: 64,
    flags: FLAGS.reboot,
  });
  assertEquals(closed[0].busy, 600.99);
  assertEquals(closed[0].seconds, 300.12);
  assertEquals(closed[0].flags, FLAGS.clockInvalid);
  assertEquals(next!.flags, FLAGS.clockInvalid | FLAGS.reboot);
});

Deno.test("quarantine keeps only the newest three rejected history files", async () => {
  const dir = await testDirectory("history-quarantine-");
  try {
    const path = `${dir}/history.json`;
    for (let i = 1; i <= 5; i++) await Deno.writeTextFile(`${path}.bad-${i}`, "old");
    await Deno.writeTextFile(path, "broken");
    await new HistoryStore(path, () => {}).load("k", 1, at);
    const names = (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
    assertEquals(
      names,
      [
        "history.json.bad-4",
        "history.json.bad-5",
        `history.json.bad-${at / 1000}`,
      ].sort(),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the open slot joins the closed ones as it will when it closes", () => {
  const closed = [0, 1, 2].map((i) => ({
    at: at + i * SLOT_MS,
    seconds: 600,
    busy: 1200,
    steal: 0,
    managed: 1200,
    outside: 0,
    charged: 1284,
    flags: 0,
  }));
  const open = { ...closed[0], at: at + 3 * SLOT_MS, seconds: 300, busy: 600 };
  assertEquals(withOpenSlot(closed, open), [...closed, open]);
  // After a backward clock step the open slot reopens a closed one: that slot turns clock-invalid,
  // as addSlots marks it at the close, instead of appearing twice out of order.
  const reopened = withOpenSlot(closed, { ...open, at: at + SLOT_MS });
  assertEquals(reopened.map((s) => s.at), closed.map((s) => s.at));
  assertEquals(reopened[1].flags, FLAGS.clockInvalid);
  assertEquals(closed[1].flags, 0);
  const h = emptyHistory("k", 1, at);
  addSlots(h, structuredClone(closed));
  addSlots(h, [{ ...open, at: at + SLOT_MS }]);
  assertEquals(h.slots, reopened);
});

Deno.test("a leftover temporary file the daemon cannot open does not stop writes", async () => {
  const dir = await testDirectory("history-leftover-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    // As a root run can leave it: read-only to the daemon, in the daemon's own directory.
    await Deno.writeTextFile(`${path}.tmp`, "stale");
    await Deno.chmod(`${path}.tmp`, 0o444);
    const store = new HistoryStore(path, (s) => logs.push(s));
    const h = await store.load("k", 1, at);
    mergeReadings(h, [{ at, v: 30 }], at);
    store.write(h, at);
    await store.close();
    assertEquals(logs, ["history rebuilt: missing"]);
    assertEquals((await readHistory(path, "k", 1)).history, h);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    await assertRejects(() => Deno.stat(`${path}.tmp`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a compaction made with the clock ahead does not hold off the next one", async () => {
  const dir = await testDirectory("history-clock-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = emptyHistory("k", 1, at);
    // Compacted while the wall clock read a year ahead, then corrected.
    store.write(h, at + 365 * DAY);
    await store.close();
    const ahead = await Deno.readTextFile(path);
    mergeReadings(h, [{ at, v: 30 }], at);
    store.write(h, at + SLOT_MS);
    await store.close();
    assert(await Deno.readTextFile(path) !== ahead);
    assertEquals(await Deno.readTextFile(logPath(path)), "");
    // From then on it appends again, and compacts a day later.
    mergeReadings(h, [{ at: at + 1_800_000, v: 31 }], at + 1_800_000);
    store.write(h, at + 2 * SLOT_MS);
    await store.close();
    assert((await Deno.readTextFile(logPath(path))).length > 0);
    assertEquals((await readHistory(path, "k", 1)).history, h);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a bad record in the snapshot drops that record, not the history", async () => {
  const dir = await testDirectory("history-record-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const c = calibrationConfig({ mode: "apply" });
    const h = emptyHistory("k", 1, at);
    assertEquals(h.meterPairs, []);
    mergeReadings(h, [{ at, v: 30 }, { at: at + 1_800_000, v: 31 }], at + 1_800_000);
    const record = {
      onset: at,
      entry: at + 90_000,
      path: "evident" as const,
      balance: 2000,
      used: 50000,
      settings: { ...c.start },
      gap: 0,
      mode: "apply" as const,
      track: null,
      caps: [],
      confirmed: true,
      learn: true,
    };
    const decision = {
      at,
      trigger: "fit" as const,
      inputs: {},
      digest: "0",
      from: { ...c.start },
      to: { ...c.start },
      mode: "apply" as const,
    };
    const span = { from: at, to: at + 1_800_000, applied: { ...c.start }, gap: 0 };
    h.limits = [record, { ...record, onset: at + 1, confirmed: "yes" as unknown as boolean }];
    h.calibrations = [
      { ...decision, activated: true, invalidSpans: [span, { from: at, to: null }] },
      { ...decision, at: at + 1, activated: false as unknown as true },
      { ...decision, at: at + 2, invalidSpans: [{ ...span, to: at - 1 }] },
      // Status reads a decision's inputs by key, so they must be an object.
      { ...decision, at: at + 3, inputs: "bad" as unknown as Record<string, unknown> },
    ];
    h.meterPairs = [
      { at: at + 1_800_000, from: at, own: 2, seconds: 1800 },
      { at: at + 1_800_000, from: at + 1_800_000, own: 2, seconds: 0 },
    ];
    // Nothing checks records as they are written, so a daemon bug reaches the file.
    await Deno.writeTextFile(path, encodeHistory(h));
    const store = new HistoryStore(path, (s) => logs.push(s));
    const loaded = await store.load("k", 1, at + 1_800_000);
    assertEquals(loaded.readings, h.readings);
    assertEquals(loaded.limits, [record]);
    assertEquals(loaded.calibrations, [h.calibrations[0]]);
    assertEquals(loaded.meterPairs, [h.meterPairs[0]]);
    assertEquals(logs, [
      "history: dropped invalid limit records (1), decisions (3), meter pairs (1); compacting on the next write",
    ]);
    await assertRejects(() => Deno.stat(`${path}.bad-${(at + 1_800_000) / 1000}`));
    // The next write compacts what was kept.
    store.write(loaded, at + 1_800_000);
    await store.close();
    const reread = await readHistory(path, "k", 1);
    assert(reread.clean);
    assertEquals(reread.history, loaded);
    // A malformed row tuple still rejects the whole file.
    const envelope = JSON.parse(encodeHistory(h));
    const data = JSON.parse(gunzipSync(Buffer.from(envelope.data, "base64")).toString());
    data.slots = [[0, 600, 1, 1, 1, 1, 1, 1 << 12]];
    envelope.data = gzipSync(JSON.stringify(data)).toString("base64");
    assertThrows(() => decodeHistory(JSON.stringify(envelope), "k", 1));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a reader beside the daemon reads again across a compaction", async () => {
  const dir = await testDirectory("history-race-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = emptyHistory("k", 1, at);
    store.write(h, at);
    await store.close();
    const old = await Deno.readTextFile(path);
    mergeReadings(h, [{ at, v: 30 }], at);
    store.write(h, at + SLOT_MS);
    await store.close();
    // The day's compaction lands just after the reader took the old snapshot.
    mergeReadings(h, [{ at: at + 1_800_000, v: 31 }], at + 1_800_000);
    store.write(h, at + DAY);
    mergeReadings(h, [{ at: at + 3_600_000, v: 32 }], at + 3_600_000);
    store.write(h, at + DAY + SLOT_MS);
    await store.close();
    let first = true;
    const read = (p: string) => {
      if (p === path && first) {
        first = false;
        return Promise.resolve(old);
      }
      return Deno.readTextFile(p);
    };
    const files = await readHistoryFiles(path, read);
    const { history, clean } = decodeHistoryFiles(files, "k", 1);
    assert(clean);
    assertEquals(history, h);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rows that age out by the time history loads leave the files too", async () => {
  const dir = await testDirectory("history-load-cutoff-");
  try {
    const path = `${dir}/history.json`;
    const row = (t: number) => ({
      at: t,
      seconds: 600,
      busy: 1200,
      steal: 0,
      managed: 1200,
      outside: 0,
      charged: 1284,
      flags: 0,
    });
    const t0 = at + 100 * DAY;
    const h = emptyHistory("k", 1, at);
    addSlots(h, [row(t0 - 90 * DAY + 60_000), row(t0 - SLOT_MS)]);
    const store = new HistoryStore(path, () => {});
    store.write(h, t0);
    await store.close();
    // Two minutes later the oldest slot is past the cutoff, before the daily compaction.
    const later = new HistoryStore(path, () => {});
    const loaded = await later.load("k", 1, t0 + 120_000);
    assertEquals(loaded.slots.length, 1);
    later.write(loaded, t0 + 120_000);
    await later.close();
    assertEquals((await readHistory(path, "k", 1)).history.slots, loaded.slots);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("across the 90-day cutoff the files keep equal to memory as rows are pruned", async () => {
  const dir = await testDirectory("history-cutoff-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = emptyHistory("k", 1, at);
    const slot = (t: number) => ({
      at: t,
      seconds: 600,
      busy: 1200,
      steal: 0,
      managed: 1200,
      outside: 0,
      charged: 1284,
      flags: 0,
    });
    for (let t = at; t < at + 89 * DAY; t += 6 * SLOT_MS) addSlots(h, [slot(t)]);
    for (let t = at; t < at + 89 * DAY; t += 2 * 1_800_000) h.readings.push({ at: t, v: 30 });
    h.meterPairs = h.readings.slice(1).map((r, i) => ({
      at: r.at,
      from: h.readings[i].at,
      own: 2,
      seconds: (r.at - h.readings[i].at) / 1000,
    }));
    let now = at + 89 * DAY;
    boundHistory(h, now);
    store.write(h, now);
    await store.close();
    // Two days of slots and fetches, a compaction among them, while the oldest rows age out.
    for (let i = 0; i < 2 * 144; i++) {
      now += SLOT_MS;
      addSlots(h, [slot(now - SLOT_MS)]);
      if (i % 3 === 0) mergeReadings(h, [{ at: now, v: 40 }], now);
      boundHistory(h, now);
      store.write(h, now);
      await store.close();
      if (i % 24 === 0 || i === 2 * 144 - 1) {
        assertEquals((await readHistory(path, "k", 1)).history, h);
      }
    }
    const cutoff = now - 90 * DAY;
    assert(h.slots[0].at >= cutoff && h.slots[0].at > at);
    assert(h.readings[0].at >= cutoff && h.meterPairs![0].at >= cutoff);
    const { history } = await readHistory(path, "k", 1);
    assertEquals(history.slots[0].at, h.slots[0].at);
    assertEquals(history, h);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("daemon-like writes in random order always read back equal to memory", async () => {
  const dir = await testDirectory("history-fuzz-");
  try {
    const c = calibrationConfig({ mode: "shadow" });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    for (let seed = 1; seed <= 4; seed++) {
      const path = `${dir}/history-${seed}.json`, logs: string[] = [];
      const random = seeded(seed);
      const t0 = Date.parse("2026-01-01T00:00:00Z");
      // Sparse rows from t0, so the 90-day cutoff starts pruning a day in.
      let now = t0 + 89 * DAY;
      const h = emptyHistory("k", 1, t0);
      const slot = (t: number, flags = 0) => ({
        at: t,
        seconds: 600,
        busy: r2(random() * 4000),
        steal: 0,
        managed: 100,
        outside: 0,
        charged: 1284,
        flags,
      });
      for (let t = t0; t < now; t += 36 * SLOT_MS) h.slots.push(slot(t));
      for (let t = t0 + 1_800_000; t < now - 3_600_000; t += 6 * 3_600_000) {
        h.readings.push({ at: t, v: r2(random() * 100) });
      }
      const store = new HistoryStore(path, (s) => logs.push(s));
      store.write(h, now);
      await store.close();
      let last = h.slots.at(-1)!.at;
      const record = (onset: number) => ({
        onset,
        entry: onset + 90_000,
        path: "evident" as const,
        balance: 2000,
        used: 50000,
        settings: { ...c.start },
        gap: 0,
        mode: "shadow" as const,
        track: null,
        caps: [] as LimitRecord["caps"],
        confirmed: false,
        learn: true,
      });
      for (let step = 0; step < 250; step++) {
        now += SLOT_MS;
        last += SLOT_MS;
        addSlots(h, [slot(last, random() < 0.05 ? FLAGS.reboot : 0)]);
        const op = random();
        if (op < 0.3) {
          // A fetch: the last three again, sometimes revised, and two new ones.
          const end = h.readings.at(-1)?.at ?? now - 7_200_000;
          const fetch = [
            ...h.readings.slice(-3).map((r) => ({
              ...r,
              v: random() < 0.2 ? r2(random() * 100) : r.v,
            })),
            { at: end + 1_800_000, v: r2(random() * 100) },
            { at: Math.min(now, end + 3_600_000), v: r2(random() * 100) },
          ];
          mergeFetchReadings(h, fetch.filter((r) => r.at <= now), now);
          const rd = h.readings;
          if (rd.length > 1) {
            const pair = {
              at: rd.at(-1)!.at,
              from: rd.at(-2)!.at,
              own: random() * 8,
              seconds: (rd.at(-1)!.at - rd.at(-2)!.at) / 1000,
            };
            h.meterPairs = [...h.meterPairs!.filter((p) => p.at !== pair.at), pair];
          }
        } else if (op < 0.35) {
          h.limits = [...h.limits, record(now - 300_000 - step)].slice(-LIMITS_KEPT);
        } else if (op < 0.45 && h.limits.length) {
          const l = h.limits[Math.floor(random() * h.limits.length)];
          l.caps.push({ at: now, busy: 2.4, demand: 6, ceiling: 200, pressing: random() < 0.5 });
          if (random() < 0.5) {
            for (const o of h.limits) delete o.diagnosisEvidence;
            l.diagnosisEvidence = {
              config: c,
              upper: 0.167,
              fit: null,
              anchor: null,
              readings: structuredClone(h.readings.slice(-Math.floor(random() * 200))),
              slots: structuredClone(h.slots.slice(-Math.floor(random() * 600))),
            };
          }
        } else if (op < 0.5) {
          h.calibrations.push({
            at: now,
            trigger: "fit",
            inputs: { step },
            digest: "0",
            from: { ...c.start },
            to: { ...c.start },
            mode: "shadow",
          });
          h.calibrations = h.calibrations.slice(-DECISIONS_KEPT);
        } else if (op < 0.52) {
          // A late duplicate marks a slot clock-invalid in place.
          addSlots(h, [slot(h.slots[h.slots.length - 5].at)]);
        }
        if (random() < 0.7) {
          h.checkpoint = {
            at: now,
            open: 1,
            config: c,
            before: initialCalibration(c, now),
            history: recordedEvidence(h),
            digest: String(step),
          };
        }
        boundHistory(h, now);
        store.write(h, now);
        await store.close();
        const disk = await readHistory(path, "k", 1);
        assert(disk.clean, `seed ${seed} step ${step}`);
        assertEquals(disk.history, h, `seed ${seed} step ${step}`);
      }
      assert(h.slots[0].at > t0, "the cutoff pruned rows");
      assertEquals(logs, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a log torn at any byte reads back as the last complete write", async () => {
  const dir = await testDirectory("history-torn-");
  try {
    const path = `${dir}/history.json`;
    const c = calibrationConfig({ mode: "shadow" });
    const random = seeded(7);
    let now = at;
    const h = emptyHistory("k", 1, at);
    const store = new HistoryStore(path, () => {});
    store.write(h, now);
    await store.close();
    const snapshot = await Deno.readTextFile(path);
    const states: { now: number; json: string; length: number }[] = [];
    for (let i = 0; i < 100; i++) {
      now += SLOT_MS;
      addSlots(h, [{
        at: now - SLOT_MS,
        seconds: 600,
        busy: Math.round(random() * 400000) / 100,
        steal: 0,
        managed: 100,
        outside: 0,
        charged: 1284,
        flags: 0,
      }]);
      if (i % 3 === 0) {
        mergeFetchReadings(h, [
          { at: now - 1_800_000, v: Math.round(random() * 10000) / 100 },
          { at: now, v: 5 },
        ], now);
      }
      if (i % 7 === 0) {
        h.limits.push({
          onset: now,
          entry: now,
          path: "evident",
          balance: 1,
          used: 1,
          settings: { ...c.start },
          gap: 0,
          mode: "shadow",
          track: null,
          caps: [],
          confirmed: false,
          learn: true,
        });
      }
      h.checkpoint = {
        at: now,
        open: 1,
        config: c,
        before: initialCalibration(c, now),
        history: recordedEvidence(h),
        digest: String(i),
      };
      store.write(h, now);
      await store.close();
      states.push({ now, json: JSON.stringify(h), length: (await Deno.stat(logPath(path))).size });
    }
    assertEquals(await Deno.readTextFile(path), snapshot);
    const full = await Deno.readTextFile(logPath(path));
    for (let trial = 0; trial < 200; trial++) {
      const cut = Math.floor(random() * full.length);
      await Deno.writeTextFile(logPath(path), full.slice(0, cut));
      const k = states.findLastIndex((s) => s.length <= cut);
      const { history } = await readHistory(path, "k", 1);
      const expected = k >= 0 ? JSON.parse(states[k].json) : JSON.parse(JSON.stringify(
        emptyHistory("k", 1, at),
      ));
      assertEquals(JSON.parse(JSON.stringify(history)), expected, `cut at ${cut}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the store writes a late clock flag and appended rows, reading only what's new", async () => {
  const dir = await testDirectory("history-rows-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = emptyHistory("k", 1, at);
    const slot = (t: number) => ({
      at: t,
      seconds: 600,
      busy: 60,
      steal: 0,
      managed: 60,
      outside: 0,
      charged: 64,
      flags: 0,
    });
    addSlots(h, [slot(at), slot(at + SLOT_MS)]);
    store.write(h, at);
    await store.close();
    // A slot closing at a start history already holds marks the older one, as after a clock step.
    addSlots(h, [slot(at + 2 * SLOT_MS), slot(at)]);
    assertEquals(h.slots.length, 3);
    store.write(h, at + SLOT_MS);
    await store.close();
    const { history } = await readHistory(path, "k", 1);
    assertEquals(history.slots, h.slots);
    assert(history.slots[0].flags & FLAGS.clockInvalid);
    // A clock stepped back into a hole: the slot sorts in before the newest one. Sorted in place, the
    // array looked appended to, and the store logged an old slot instead of it.
    addSlots(h, [slot(at + 4 * SLOT_MS)]);
    store.write(h, at + 5 * SLOT_MS);
    await store.close();
    addSlots(h, [slot(at + 3 * SLOT_MS)]);
    assertEquals(h.slots.map((x) => x.at), [0, 1, 2, 3, 4].map((i) => at + i * SLOT_MS));
    store.write(h, at + 5 * SLOT_MS + 1);
    await store.close();
    assertEquals((await readHistory(path, "k", 1)).history.slots, h.slots);
    // So does a row array changed in place some other way: its known part no longer ends the same.
    h.slots.splice(1, 1);
    h.slots.push(slot(at + 5 * SLOT_MS));
    store.write(h, at + 6 * SLOT_MS);
    await store.close();
    assertEquals((await readHistory(path, "k", 1)).history.slots, h.slots);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a slot keeps the seconds it pressed, split and stored like its seconds", async () => {
  const observation = {
    busy: 60,
    steal: 3,
    managed: 45,
    outside: 15,
    charged: 64,
  };
  // A 30-second lift test that presses across a slot boundary, then a quiet pass.
  const tested = accumulateSlot(undefined, {
    ...observation,
    from: at + 590_000,
    to: at + 620_000,
    seconds: 30,
    flags: FLAGS.limited | FLAGS.test | FLAGS.pressing,
  });
  assertEquals(tested.closed[0].pressed, 10);
  assertEquals(tested.open!.pressed, 20);
  const quiet = accumulateSlot(tested.open, {
    ...observation,
    from: at + 620_000,
    to: at + 650_000,
    seconds: 30,
    flags: FLAGS.limited,
  });
  assertEquals(quiet.open!.pressed, 20);
  assertEquals(quiet.open!.seconds, 50);
  // The slot stays flagged as pressing; pressed tells how long. Without any, the field is absent.
  assert(quiet.open!.flags & FLAGS.pressing);
  assertEquals("pressed" in roundedSlot({ ...quiet.open!, pressed: 0 }), false);
  assertEquals(roundedSlot({ ...quiet.open!, pressed: 20.004 }).pressed, 20);
  // Pressing that rounds to nothing keeps the smallest step: a pressing slot without its seconds
  // counts as pressing throughout, which a 4 ms press once cost the whole slot's earning.
  assertEquals(roundedSlot({ ...quiet.open!, pressed: 0.004 }).pressed, 0.01);
  assertEquals(roundedSlot({ ...quiet.open!, quiet: 0.004 }).quiet, 0.01);
  assertEquals(withOpenSlot([], quiet.open).at(-1)!.pressed, 20);
  // Snapshot and log both carry it, as a trailing tuple element.
  const dir = await testDirectory("history-pressed-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = emptyHistory("k", 1, at);
    h.slots = [tested.closed[0], roundedSlot({ ...quiet.open!, at: at + SLOT_MS })];
    store.write(h, at);
    await store.close();
    assertEquals((await readHistory(path, "k", 1)).history, h);
    // A change to pressed alone is a change. Rows are replaced with their array, never in place.
    h.slots = h.slots.with(1, { ...h.slots[1], pressed: 30 });
    store.write(h, at + SLOT_MS);
    await store.close();
    assert((await Deno.readTextFile(logPath(path))).includes(",30]"));
    assertEquals((await readHistory(path, "k", 1)).history, h);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // More pressed seconds than the slot holds is corruption.
  const bad = emptyHistory("k", 1, at);
  bad.slots = [{ ...tested.closed[0], pressed: 30 }];
  assertThrows(() => decodeHistory(encodeHistory(bad), "k", 1));
});

Deno.test("a bad record in a log line drops that record, not the lines after it", async () => {
  const dir = await testDirectory("history-line-record-");
  try {
    const path = `${dir}/history.json`, logs: string[] = [];
    const store = new HistoryStore(path, (s) => logs.push(s));
    const h = emptyHistory("k", 1, at);
    const slot = (t: number) => ({
      at: t,
      seconds: 600,
      busy: 1200,
      steal: 0,
      managed: 1200,
      outside: 0,
      charged: 1284,
      flags: 0,
    });
    store.write(h, at);
    await store.close();
    let now = at;
    for (let i = 0; i < 3; i++) {
      now += SLOT_MS;
      h.slots.push(slot(now - SLOT_MS));
      store.write(h, now);
      await store.close();
    }
    // A daemon bug: one limit record with a field of the wrong type.
    h.limits.push({
      onset: now,
      entry: now,
      path: "evident",
      balance: 1,
      used: 1,
      settings: { mul: 1.05, add: 0.04, floor: 0.05 },
      gap: 0,
      mode: "apply",
      track: null,
      caps: [],
      confirmed: "yes" as unknown as boolean,
      learn: true,
    });
    for (let i = 0; i < 20; i++) {
      now += SLOT_MS;
      h.slots.push(slot(now - SLOT_MS));
      store.write(h, now);
      await store.close();
    }
    const disk = await readHistory(path, "k", 1);
    assertEquals(disk.history.slots, h.slots);
    assertEquals(disk.history.limits, []);
    assertEquals(disk.clean, false);
    assertEquals(disk.dropped, ["limit records (1)"]);
    // Evidence that decodes but fails its check goes alone too, the record staying. At the end of
    // the replay it once failed the whole history, which was then set aside.
    const valid = { ...h.limits[0], confirmed: true };
    h.limits = [{
      ...valid,
      diagnosisEvidence: {
        config: CALIBRATION,
        upper: 0.167,
        fit: null,
        anchor: null,
        readings: [],
        slots: [],
        limits: [{ onset: "bad" } as unknown as LimitRecord],
      },
    }];
    now += SLOT_MS;
    store.write(h, now);
    await store.close();
    const evidence = await readHistory(path, "k", 1);
    assertEquals(evidence.history.slots, h.slots);
    assertEquals(evidence.history.limits, [valid]);
    assertEquals(evidence.dropped, ["limit records (1)", "diagnosis inputs (1)"]);
    // The store says what it dropped and compacts on its next write.
    const reloaded = new HistoryStore(path, (s) => logs.push(s));
    await reloaded.load("k", 1, now);
    assert(logs.at(-1)!.includes("dropped invalid limit records (1)"), logs.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("revisions keep only the newest, so a feed revising every fetch stays bounded", async () => {
  const dir = await testDirectory("history-revisions-");
  try {
    const path = `${dir}/history.json`;
    const store = new HistoryStore(path, () => {});
    const h = emptyHistory("8:4.8:34560", 1, at);
    const random = seeded(7);
    let now = at + 2 * DAY;
    // Three days of fetches that revise every reading of the 48-hour window.
    for (let i = 0; i < 3 * 48; i++, now += 1_800_000) {
      const fetch = [];
      for (let t = now - 48 * 3_600_000; t <= now; t += 1_800_000) {
        fetch.push({ at: t, v: Math.round((30 + random() * 40) * 100) / 100 });
      }
      mergeFetchReadings(h, fetch, now);
      store.write(h, now);
      await store.close();
    }
    assertEquals(h.revisions.length, REVISIONS_KEPT);
    assertEquals(h.revisions.at(-1)!.seenAt, now - 1_800_000);
    assertEquals(newestFinal(h, now), false);
    assertEquals((await readHistory(path, h.planKey, 1)).history, h);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a temporary file planted after the leftover is removed is not followed", async () => {
  const dir = await testDirectory("storage-planted-");
  const deno = Deno as unknown as { remove: typeof Deno.remove };
  const remove = deno.remove;
  try {
    const path = `${dir}/persist.json`, target = `${await Deno.realPath(dir)}/target`;
    await Deno.writeTextFile(target, "keep");
    // Between the removal and the open, a symlink appears at the temporary path.
    deno.remove = async (p, options) => {
      try {
        await remove(p, options);
      } finally {
        if (String(p).endsWith(".tmp")) await Deno.symlink(target, String(p));
      }
    };
    await assertRejects(() => writeText(path, "new", 0o600));
    deno.remove = remove;
    assertEquals(await Deno.readTextFile(target), "keep");
    // The next write removes it and goes through.
    await writeText(path, "new", 0o600);
    assertEquals(await Deno.readTextFile(path), "new");
  } finally {
    deno.remove = remove;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("quarantine pruning keeps the newest three copies of any file", async () => {
  const dir = await testDirectory("quarantine-persist-");
  try {
    const path = `${dir}/persist.json`;
    for (const stamp of [5, 1, 4, 2, 3]) {
      await Deno.writeTextFile(`${path}.bad-${stamp}`, "old");
    }
    await Deno.writeTextFile(`${dir}/history.json.bad-1`, "other");
    await pruneQuarantine(path);
    const names = (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
    assertEquals(names, [
      "history.json.bad-1",
      "persist.json.bad-3",
      "persist.json.bad-4",
      "persist.json.bad-5",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
