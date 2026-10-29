// governor calibrate --explain: the text shows what the JSON shows (ACCESSIBILITY.md), and a file it
// can't read is explained in plain words.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { explainCalibration, explainText } from "../src/explain.ts";
import {
  calibrationConfig,
  calibrationSummary,
  initialCalibration,
  type MeterFit,
} from "../src/calibration.ts";
import type { Config } from "../src/governor.ts";
import { emptyHistory, planKey } from "../src/history.ts";
import { fixture, p, start } from "./governor-fixture.ts";
import { testDirectory } from "./temp.ts";
import { cliArguments } from "./cli.ts";

type Explained = Parameters<typeof explainText>[0];
const c = calibrationConfig({ mode: "apply" });
const fit: MeterFit = {
  a: 1.0463,
  b: 0.0193,
  aHi: 1.051,
  sigma: [0.0214, 0.0119],
  sigmaFloor: 0.012,
  pairs: 222,
  days: 10,
};
const summary = () =>
  calibrationSummary(c, initialCalibration(c, start), emptyHistory(planKey(p), 1, start));
const explained = (overrides: Partial<Explained>): Explained =>
  ({
    ...summary(),
    evidence: { at: start, digest: "0000abcd" },
    ...overrides,
  }) as Explained;

Deno.test("explain text shows the fit's noise and its floor", () => {
  const text = explainText(explained({ fit }));
  assertStringIncludes(text, "sigma 0.0214 + 0.0119 per own core, at least 0.012, 222 pairs");
  const { sigmaFloor: _, ...line } = fit;
  const without = explainText(explained({ fit: line }));
  assertStringIncludes(without, "sigma 0.0214 + 0.0119 per own core, 222 pairs");
});

Deno.test("explain text shows the settings each hold gives", () => {
  const status = summary();
  const pending = {
    at: start,
    from: { ...c.start },
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
  const text = explainText(explained({
    ownHold: { gap: 0.3, settings: { mul: 1.05, add: 0.36, floor: 0.05 } },
    cusum: { ...status.cusum, pending },
  }));
  assertStringIncludes(
    text,
    "Hold settings own-count x1.05 +0.36 cores, floor 5%; drift change x1.06 +0.1 cores, floor 5%",
  );
  assert(!explainText(explained({})).includes("Hold settings"));
});

Deno.test("explain text shows what shadow learned and the fallback a failing evaluation holds", () => {
  // Off and shadow actuate the legacy margin, so the learned settings differ from those in force
  // with no hold at all: the JSON had them and the text didn't.
  const learned = { mul: 1.052, add: 0.046, floor: 0.05 };
  const shadow = explainText(explained({
    mode: "shadow",
    applied: { mul: 1.05, add: 0.08, floor: 0.2 },
    learned,
  }));
  assertStringIncludes(shadow, "Learned x1.052 +0.046 cores, floor 5%, not applied");
  assert(!explainText(explained({})).includes("Learned"));
  const failing = explainText(explained({ failing: { since: start, behind: 1000 } }));
  assertStringIncludes(failing, "holding the fallback while calibration fails");
  assertStringIncludes(failing, "acting 1000 core-seconds below the open estimate");
});

Deno.test("explain text shows a diagnosis that found no gap", () => {
  const limit = (diagnosis: NonNullable<Explained["lastLimit"]>["diagnosis"]) =>
    explainText(explained({
      lastLimit: { class: "credit", onset: start, lift: start + 3_600_000, diagnosis },
    }));
  const base = { anchor: null, onset: start, eta: 0, explained: false, left: 0 };
  assertStringIncludes(
    limit({ ...base, gap: null, source: "unavailable" }),
    ", diagnosis unavailable",
  );
  assertStringIncludes(
    limit({ ...base, gap: 1, source: "readings", beyond: true }),
    ", diagnosed beyond a whole core from readings",
  );
  assertStringIncludes(
    limit({ ...base, gap: 0.02, source: "readings", explained: true }),
    ", explained by readings with the gap at 0.02 cores",
  );
  assertStringIncludes(
    limit({ ...base, gap: 0.0312, source: "own" }),
    ", diagnosed 0.0312 cores from own",
  );
  assert(!limit(null).includes("diagnos"));
});

Deno.test("explain text shows a drift change's verification and what it holds against", () => {
  const status = summary();
  const pending = {
    at: start,
    from: { mul: 1.05, add: 0.06, floor: 0.05 },
    gapFrom: 0.02,
    oldFit: fit,
    fit: { ...fit, b: 0.1193, aHi: 1.06 },
    hold: { mul: 1.06, add: 0.16, floor: 0.05 },
    readings: 4,
    z: 6,
    verified: false,
    residual: 0.3,
    n: 3,
  };
  const text = explainText(explained({ cusum: { ...status.cusum, pending } }));
  assertStringIncludes(
    text,
    `Drift change since ${
      new Date(start).toISOString()
    }: 4 verification readings at mean 1.5 sigma; before it x1.05 +0.06 cores, floor 5%, gap 0.02 cores; fit a=1.0463, b=0.1193, aHi=1.06 against the old a=1.0463, b=0.0193; residual 0.3 cores summed over 3 pairs since`,
  );
  const none = explainText(
    explained({ cusum: { ...status.cusum, pending: { ...pending, readings: 0, z: 0 } } }),
  );
  assertStringIncludes(none, ": 0 verification readings; before it");
  assert(!explainText(explained({})).includes("Drift change since"));
});

Deno.test("explain text shows the settings and gap each invalid span began under", () => {
  const text = explainText(explained({
    invalidSpans: [
      {
        from: start,
        to: start + 3_600_000,
        applied: { mul: 1.05, add: 0.04, floor: 0.05 },
        gap: 0,
      },
      { from: start + 7_200_000, to: null },
    ],
  }));
  assertStringIncludes(
    text,
    `Readings invalid and bridged: ${new Date(start).toISOString()} to ${
      new Date(start + 3_600_000).toISOString()
    } (learned x1.05 +0.04 cores, floor 5%, gap 0 cores when it began); ${
      new Date(start + 7_200_000).toISOString()
    } to now`,
  );
});

Deno.test("explain text shows what the last diagnosis replayed besides its gap", () => {
  const anchor = { at: start - 86_400_000, balance: 6912, exact: true };
  const text = explainText(explained({
    lastLimit: {
      class: "credit",
      onset: start,
      lift: start + 3_600_000,
      diagnosis: {
        gap: 0.0312,
        source: "readings",
        anchor,
        onset: start - 300_000,
        eta: 1234.4,
        explained: false,
        left: 812.6,
        lower: 0.021,
        held: 0.31,
        bridged: 1800,
      },
    },
  }));
  assertStringIncludes(
    text,
    `Last diagnosis replayed from ${new Date(anchor.at).toISOString()} at 6912 core-seconds to ${
      new Date(start - 300_000).toISOString()
    }: allowance 1234 core-seconds, 813 core-seconds left, lower estimate 0.021 cores, hold gap 0.31 cores, 1800 seconds bridged`,
  );
  const bare = explainText(explained({
    lastLimit: {
      class: "unknown",
      onset: start,
      lift: null,
      diagnosis: {
        gap: null,
        source: "unavailable",
        anchor: { ...anchor, exact: false },
        onset: start - 300_000,
        eta: 0,
        explained: false,
        left: null,
      },
    },
  }));
  assertStringIncludes(bare, "at 6912 core-seconds, a bound to ");
  assertStringIncludes(bare, ": allowance 0 core-seconds, nothing left");
  assert(!bare.includes("lower estimate") && !bare.includes("bridged"));
  assert(!explainText(explained({})).includes("Last diagnosis"));
});

Deno.test("explain says in plain words why it can't read the daemon's files", async () => {
  const dir = await testDirectory("explain-");
  const cfg: Config = {
    vcpus: p.vcpus,
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" },
  };
  const persist = `${dir}/persist.json`;
  try {
    await assertRejects(
      () => explainCalibration(cfg, dir),
      Error,
      `${persist} does not exist yet: the daemon has not saved its state`,
    );
    await Deno.writeTextFile(persist, "{ torn");
    await assertRejects(() => explainCalibration(cfg, dir), Error, `${persist} does not parse`);
    await Deno.writeTextFile(persist, JSON.stringify({ planKey: planKey(p) }));
    await assertRejects(
      () => explainCalibration(cfg, dir),
      Error,
      `${dir}/history.json does not exist yet: the daemon has not saved its state`,
    );
    await Deno.chmod(persist, 0o000);
    // Root reads the file anyway, so the refusal can only be seen as another user.
    const readable = await Deno.readTextFile(persist).then(() => true, () => false);
    if (!readable) {
      await assertRejects(
        () => explainCalibration(cfg, dir),
        Error,
        `cannot read ${persist}: calibrate --explain needs root or the governor user`,
      );
    }
  } finally {
    await Deno.chmod(persist, 0o600).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("explain text drops control characters the daemon's files could carry", () => {
  const anchor = { at: start - 86_400_000, balance: 6912, exact: true };
  const planted =
    "readings\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[2J\nRecorded evaluation forged\u009b";
  const text = explainText(explained({
    hold: { since: start, reason: "stale\u001b[31m" as "stale" },
    lastLimit: {
      class: "credit",
      onset: start,
      lift: null,
      diagnosis: {
        gap: 0.03,
        source: planted as "readings",
        anchor,
        onset: start,
        eta: 1,
        explained: false,
        left: 1,
      },
    },
  }));
  // deno-lint-ignore no-control-regex
  assert(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text));
  assertEquals(text.split("\n").filter((l) => l.startsWith("Recorded evaluation")).length, 1);
  assertStringIncludes(text, "diagnosed 0.03 cores from readings]52;c;cm0gLXJmIH4=[2JRecorded");
  assertStringIncludes(text, "the stale[31m readings fallback");
  // The JSON form escapes them instead.
  assertStringIncludes(JSON.stringify({ source: planted }), "\\u001b");
});

Deno.test("explain reads the daemon's files again when a save lands between them", async () => {
  const dir = await testDirectory("explain-race-");
  const cfg: Config = {
    vcpus: p.vcpus,
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" },
  };
  const lib = `${dir}/lib`, names = ["persist.json", "history.json", "history.log"];
  const files = async () =>
    Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await Deno.readTextFile(`${lib}/${n}`)])),
    ) as Record<string, string>;
  try {
    await Deno.mkdir(`${dir}/run`);
    await Deno.mkdir(lib);
    const f = fixture(cfg, { run: `${dir}/run`, lib });
    await f.g.loadHistory(start);
    await f.g.tick();
    for (let i = 0; i < 22; i++) await f.advance(30, 0.3);
    await f.g.closeHistory();
    await f.g.save(start + 660_000);
    const before = await files();
    // A slot closes in between, so the second save holds a newer evaluation.
    for (let i = 0; i < 20; i++) await f.advance(30, 0.3);
    await f.g.closeHistory();
    await f.g.save(start + 1_260_000);
    const after = await files();
    const serial = (text: string) => JSON.parse(text).calibration.serial;
    assert(serial(before["persist.json"]) < serial(after["persist.json"]));
    const current = await explainCalibration(cfg, lib);
    // Each file as `serve` picks it, from the files of one save or the other.
    const reader = (serve: (name: string) => Record<string, string>) => (path: string) =>
      Promise.resolve(serve(path.slice(lib.length + 1))[path.slice(lib.length + 1)]);
    // A save lands between the reads of persist.json and history: explain reads them again and
    // matches the files as they now are.
    let saved = false;
    assertEquals(
      await explainCalibration(
        cfg,
        lib,
        reader((name) => {
          if (name === "history.json") saved = true;
          return saved ? after : before;
        }),
      ),
      current,
    );
    // History written and persist.json not yet, on every read: the serials differ, so it reads
    // again, and then says so instead of mixing the two.
    await assertRejects(
      () =>
        explainCalibration(
          cfg,
          lib,
          reader((name) => name === "persist.json" ? before : after),
        ),
      Error,
      `persist.json holds evaluation ${serial(before["persist.json"])} and history evaluation ${
        serial(after["persist.json"])
      }; run it again`,
    );
    // A save during every read: persist.json differs on each side of history.
    let reads = 0;
    await assertRejects(
      () =>
        explainCalibration(
          cfg,
          lib,
          reader((name) => name !== "persist.json" || ++reads % 2 ? after : before),
        ),
      Error,
      "the daemon saved during every read of its files; run it again",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("calibrate --explain takes --json before or after it, and nothing else", async () => {
  for (
    const [args, usage] of [
      [["--explain", "--json"], false],
      [["--json", "--explain"], false],
      [["--json"], true],
      [["--explain", "--explain"], true],
      [["--explain", "--reset"], true],
    ] as const
  ) {
    const out = await new Deno.Command(Deno.execPath(), {
      args: cliArguments("tick-consumer", ["calibrate", ...args]),
      stdout: "piped",
      stderr: "piped",
    }).output();
    // Past the arguments, it fails reading the config this test can't read.
    assertEquals(out.code, usage ? 2 : 1, args.join(" "));
  }
});
