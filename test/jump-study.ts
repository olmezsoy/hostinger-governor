// Meter-jump study (#13 §8): a real jump in Hostinger's meter from day 7, over several seeds, next
// to the same seed without the jump and with a broken feed that reports 8x the meter. Each run is
// 21 days of the calibration studies' CI workload, and the owner's criteria for v0.3.0 are checked
// at the end. Jumps of 0.75 cores and more also run during a three-day API outage from day 7, where
// no readings can corroborate the rise and the own-count hold carries it; those are reported only.
//
//   deno task sim:jumps                        0.25, 0.5, 0.75 and 1 core over seeds 1-10
//   deno task sim:jumps 0.75,1 1-20            chosen jumps and seeds
//   deno task sim:jumps 1 1-10 --calibration='{"learning":{"hold_sigmas":2}}'
//   deno task sim:jumps --json                 one JSON line per run instead of the tables
import { CALIBRATION, type CalibrationOptions } from "../src/calibration.ts";
import type { Governor } from "../src/governor.ts";
import { plan } from "../src/plans.ts";
import { study } from "./calibration-sim.ts";

const DAYS = 21, JUMP_S = 7 * 86400;
const JUMPS = [0.25, 0.5, 0.75, 1];
// The limits each jump may cost: one for jumps drift detection sees, and no more than the hold
// version's 3 and 4 for the larger ones.
const LIMITS: Record<string, number> = { "0.25": 1, "0.5": 1, "0.75": 3, "1": 4 };
// What a margin should allow at the baseline: box A's relation, the jump and the reference premium.
const BOX_A = { a: 1.0463, b: 0.0193 }, BASELINE = plan(8).baseline;

type Case = { kind: "jump" | "outage" | "control" | "feed"; jump: number; seed: number };
type Run = Case & {
  limits: number;
  // CPU the guest got over the run, in core-hours.
  cpu: number;
  applied: { mul: number; add: number; floor: number };
  // The slope upper bound of the last fit after a drift change, on readings after it alone.
  postAHi: number | null;
  aHi: number | null;
  mismatch: boolean;
  // Hours under each temporary hold: a drift change before and after verification, the own-count
  // hold, and the stale or invalid fallback.
  hours: { drift: number; verified: number; own: number; fallback: number };
  // Learned settings at the first pass of day 7, when the jump or the broken feed starts.
  learnedAtJump: { mul: number; add: number; floor: number } | null;
  // Whether any evaluation from day 7 on held learned settings above those of day 7.
  tightenedAfterJump: boolean;
  triggers: Record<string, number>;
};

async function runCase(c: Case, calibration: CalibrationOptions): Promise<Run> {
  const passes = { drift: 0, verified: 0, own: 0, fallback: 0 };
  let learnedAtJump: Run["learnedAtJump"] = null, last: Governor | null = null;
  let postAHi: number | null = null, tightenedAfterJump = false;
  const r = await study({
    id: `${c.kind}-${c.jump}-${c.seed}`,
    days: DAYS,
    seed: c.seed,
    calibration,
    ...(c.kind === "jump"
      ? { meterJump: c.jump }
      : c.kind === "outage"
      ? { meterJump: c.jump, outage: { from: 7, to: 10 } }
      : c.kind === "feed"
      ? { readingScale: 8 }
      : {}),
    observe(g, t) {
      const s = g.calibration;
      if (s.pending) passes[s.pending.verified ? "verified" : "drift"]++;
      if (s.ownHold) passes.own++;
      if (s.hold) passes.fallback++;
      if (t >= JUMP_S && !learnedAtJump) learnedAtJump = { ...s.applied };
      const at = learnedAtJump as Run["learnedAtJump"];
      if (at && (["mul", "add", "floor"] as const).some((k) => s.applied[k] > at[k] + 1e-9)) {
        tightenedAfterJump = true;
      }
      postAHi = s.fitSince !== undefined && s.fit ? s.fit.aHi : null;
      last = g;
    },
  });
  const triggers: Record<string, number> = {};
  for (const d of r.decisions) triggers[d.trigger] = (triggers[d.trigger] ?? 0) + 1;
  return {
    ...c,
    limits: r.creditLimits,
    cpu: r.cpuCoreHours,
    applied: r.applied,
    postAHi,
    aHi: r.fit?.aHi ?? null,
    mismatch: !!(last as Governor | null)?.calibration.rulesMismatch,
    hours: Object.fromEntries(
      Object.entries(passes).map(([k, n]) => [k, +(n * 30 / 3600).toFixed(1)]),
    ) as Run["hours"],
    learnedAtJump,
    tightenedAfterJump,
    triggers,
  };
}

// deno-lint-ignore no-explicit-any
const worker = typeof (globalThis as any).WorkerGlobalScope !== "undefined";
if (worker) {
  const scope = self as unknown as {
    onmessage: (e: MessageEvent<{ c: Case; calibration: CalibrationOptions }>) => void;
    postMessage(run: Run): void;
  };
  scope.onmessage = async (e) => {
    console.log = () => {};
    scope.postMessage(await runCase(e.data.c, e.data.calibration));
  };
}

const allowed = (m: Run["applied"]) => (BASELINE - m.add) / m.mul;
const correct = (jump: number) => (BASELINE - BOX_A.b - jump - CALIBRATION.premium_ref) / BOX_A.a;
const allowedPct = (r: Run) => (allowed(r.applied) / correct(r.jump) - 1) * 100;
// No inflation, two ways. #13's bound: the multiplier ends no higher than the post-change fit's
// slope bound, rounded up to 0.001 as the margin rounds it, box A's 1.051, or the multiplier
// learned before the change. It catches a drift hold's steeper slope left in the learned margin,
// but the post-change fit itself sets the multiplier, so it can't catch a fit whose bound came out
// wide. The stricter bound can: the multiplier the same seed ends with without the jump, or the
// one learned before the change, since fits after a change tighten only against that margin.
const REFERENCE_AHI = 1.051;
const ceil3 = (n: number) => Math.ceil(n * 1000 - 1e-9) / 1000;
const specBound = (r: Run) =>
  Math.max(r.postAHi === null ? 0 : ceil3(r.postAHi), REFERENCE_AHI, r.learnedAtJump?.mul ?? 0);
const mulBound = (r: Run, control: Run) => Math.max(control.applied.mul, r.learnedAtJump?.mul ?? 0);
// A broken feed tightens nothing from day 7, when it starts, at any evaluation, not only at the end.
const tightened = (r: Run) => r.tightenedAfterJump;

function seedList(arg: string | undefined): number[] {
  if (!arg) return Array.from({ length: 10 }, (_, i) => i + 1);
  return arg.split(",").flatMap((part) => {
    const [lo, hi] = part.split("-").map(Number);
    return hi === undefined ? [lo] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });
}

async function runAll(cases: Case[], calibration: CalibrationOptions): Promise<Run[]> {
  const results: Run[] = [];
  let next = 0;
  const lanes = Math.max(1, Math.min(cases.length, navigator.hardwareConcurrency - 1));
  await Promise.all(Array.from({ length: lanes }, async () => {
    const w = new Worker(import.meta.url, { type: "module" });
    try {
      while (next < cases.length) {
        const c = cases[next++];
        const done = new Promise<Run>((resolve, reject) => {
          w.onmessage = (e) => resolve(e.data);
          w.onerror = (e) => reject(e.error ?? new Error(e.message));
        });
        w.postMessage({ c, calibration });
        results.push(await done);
      }
    } finally {
      w.terminate();
    }
  }));
  return results;
}

// The v0.3.0 criteria, judged apart from how the runs are shown, so every output mode fails a
// failing run.
function failuresOf(runs: Run[], jumps: number[], seeds: number[]): string[] {
  const control = new Map(runs.filter((r) => r.kind === "control").map((r) => [r.seed, r]));
  const failures: string[] = [];
  for (const jump of jumps) {
    for (const seed of seeds) {
      const r = runs.find((x) => x.kind === "jump" && x.jump === jump && x.seed === seed)!;
      const pct = allowedPct(r), most = LIMITS[String(jump)];
      if (most !== undefined && r.limits > most) {
        failures.push(`jump ${jump} seed ${seed}: ${r.limits} limits`);
      }
      if (Math.abs(pct) > 2) failures.push(`jump ${jump} seed ${seed}: allows ${pct.toFixed(2)}%`);
      const bounds = { "#13": specBound(r), control: mulBound(r, control.get(seed)!) };
      for (const [name, bound] of Object.entries(bounds)) {
        if (r.applied.mul > bound + 1e-9) {
          failures.push(
            `jump ${jump} seed ${seed}: mul ${r.applied.mul} above the ${name} bound ${bound}`,
          );
        }
      }
    }
  }
  for (const r of runs.filter((x) => x.kind === "feed")) {
    if (tightened(r)) failures.push(`feed seed ${r.seed}: learned settings tightened`);
    if (!r.triggers["readings-invalid"]) {
      failures.push(`feed seed ${r.seed}: no readings-invalid alert`);
    }
  }
  return failures;
}

const fmt = (n: number, d = 2) => n.toFixed(d);
const margin = (m: Run["applied"]) => `${fmt(m.mul, 3)}x + ${fmt(m.add, 3)}`;

if (import.meta.main && !worker) {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  const option = Deno.args.find((a) => a.startsWith("--calibration="));
  const calibration: CalibrationOptions = option
    ? JSON.parse(option.slice("--calibration=".length))
    : {};
  const jumps = args[0] ? args[0].split(",").map(Number) : JUMPS;
  const seeds = seedList(args[1]);
  const cases: Case[] = [
    ...jumps.flatMap((jump) => seeds.map((seed) => ({ kind: "jump" as const, jump, seed }))),
    ...jumps.filter((jump) => jump >= 0.75).flatMap((jump) =>
      seeds.map((seed) => ({ kind: "outage" as const, jump, seed }))
    ),
    ...seeds.map((seed) => ({ kind: "control" as const, jump: 0, seed })),
    ...seeds.map((seed) => ({ kind: "feed" as const, jump: 0, seed })),
  ];
  const runs = await runAll(cases, calibration);
  const failures = failuresOf(runs, jumps, seeds);
  if (Deno.args.includes("--json")) {
    for (const r of runs) console.log(JSON.stringify(r));
    if (failures.length) console.error(`${failures.length} failed:\n${failures.join("\n")}`);
    Deno.exit(failures.length ? 1 : 0);
  }
  const control = new Map(runs.filter((r) => r.kind === "control").map((r) => [r.seed, r]));
  for (const jump of jumps) {
    console.log(`\njump ${jump} cores (at most ${LIMITS[String(jump)] ?? "?"} limits)`);
    console.log(
      "seed  limits  control  final margin       allowed  #13 bound  mul bound  control mul  floor  drift h  verified h  own h  mismatch",
    );
    for (const seed of seeds) {
      const r = runs.find((x) => x.kind === "jump" && x.jump === jump && x.seed === seed)!;
      const base = control.get(seed)!;
      const pct = allowedPct(r), bound = mulBound(r, base);
      console.log(
        [
          String(seed).padStart(4),
          String(r.limits).padStart(6),
          String(base.limits).padStart(7),
          margin(r.applied).padStart(16),
          `${fmt(pct)}%`.padStart(8),
          fmt(specBound(r), 3).padStart(9),
          fmt(bound, 3).padStart(9),
          fmt(base.applied.mul, 3).padStart(11),
          fmt(r.applied.floor, 3).padStart(5),
          fmt(r.hours.drift, 1).padStart(7),
          fmt(r.hours.verified, 1).padStart(10),
          fmt(r.hours.own, 1).padStart(5),
          (r.mismatch ? "latched" : "-").padStart(9),
        ].join("  "),
      );
    }
  }
  for (const jump of jumps.filter((j) => j >= 0.75)) {
    console.log(`\njump ${jump} cores during an outage from day 7 to 10 (reported only)`);
    console.log(
      "seed  limits  final margin       floor  own h  fallback h  cpu core-h  control core-h",
    );
    for (const seed of seeds) {
      const r = runs.find((x) => x.kind === "outage" && x.jump === jump && x.seed === seed)!;
      console.log(
        [
          String(seed).padStart(4),
          String(r.limits).padStart(6),
          margin(r.applied).padStart(16),
          fmt(r.applied.floor, 3).padStart(5),
          fmt(r.hours.own, 1).padStart(5),
          fmt(r.hours.fallback, 1).padStart(10),
          fmt(r.cpu, 1).padStart(10),
          fmt(control.get(seed)!.cpu, 1).padStart(14),
        ].join("  "),
      );
    }
    const sum = (k: Run["kind"]) =>
      runs.filter((x) => x.kind === k && x.jump === jump).reduce((n, x) => n + x.limits, 0);
    console.log(`limits over ${seeds.length} seeds: ${sum("outage")}`);
  }
  console.log("\nfeed at 8x the meter from day 7");
  console.log(
    "seed  limits  control  learned at day 7    final learned      floor          invalid alerts",
  );
  for (const seed of seeds) {
    const r = runs.find((x) => x.kind === "feed" && x.seed === seed)!;
    const base = control.get(seed)!;
    const invalid = r.triggers["readings-invalid"] ?? 0;
    console.log(
      [
        String(seed).padStart(4),
        String(r.limits).padStart(6),
        String(base.limits).padStart(7),
        (r.learnedAtJump ? margin(r.learnedAtJump) : "-").padStart(17),
        margin(r.applied).padStart(16),
        `${fmt(r.learnedAtJump?.floor ?? 0, 3)} -> ${fmt(r.applied.floor, 3)}`,
        String(invalid).padStart(14),
      ].join("  "),
    );
  }
  console.log(
    failures.length ? `\n${failures.length} failed:\n${failures.join("\n")}` : "\nall pass",
  );
  Deno.exit(failures.length ? 1 : 0);
}
