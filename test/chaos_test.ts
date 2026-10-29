// Random sequences of what a box goes through, checked against the rules that must hold after any of
// them, rather than after one scenario at a time: the acted estimate never exceeds the open one,
// learned settings never loosen on their own, a restart or a lost persist.json gives back exactly
// what calibration was doing, and explain equals the daemon's state (#13 rules 3 and 5, §1, §14).
import { assert, assertEquals } from "@std/assert";
import { flush } from "./async.ts";
import { type Config, Governor, openGovernor } from "../src/governor.ts";
import { explainCalibration } from "../src/explain.ts";
import { CALIBRATION, seeded } from "../src/calibration.ts";
import type { Settings } from "../src/history.ts";
import { fixture, p, start } from "./governor-fixture.ts";
import { testDirectory } from "./temp.ts";

const TICK_S = 300, READING_MS = 1_800_000;
const config = (mode: "off" | "apply", useNewest = false): Config => ({
  vcpus: 8,
  tick_seconds: TICK_S,
  hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
  calibration: { mode, fit: { min_pairs: 8, min_days: 1 } },
  ...(useNewest ? { readings: { use_newest: true } } : {}),
});
// A number JSON can't hold comes back as null, so a restart reads something else.
const unsaved = (v: unknown, path = "s"): string | null => {
  if (typeof v === "number") return Number.isFinite(v) ? null : path;
  if (!v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    const found = unsaved(x, `${path}.${k}`);
    if (found) return found;
  }
  return null;
};
// What a restart must give back, and what may only tighten.
const learnedState = (g: Governor) => {
  const c = g.calibration;
  return {
    margin: g.s.margin,
    startedAt: c.startedAt,
    applied: c.applied,
    gap: c.gap,
    rulesMismatch: c.rulesMismatch,
    pending: c.pending,
    fit: c.fit,
    lastPaired: c.lastPaired,
    invalidSpans: c.invalidSpans,
    cooldownUntil: c.cooldownUntil,
    // A limit open across a restart stays open, under the record it began with.
    limit: g.s.limit?.record?.onset ?? null,
  };
};
const looser = (a: Settings, b: Settings) =>
  a.mul < b.mul - 1e-9 || a.add < b.add - 1e-9 || a.floor < b.floor - 1e-9;

async function run(
  seed: number,
  steps: number,
  mode: "off" | "apply" = "apply",
  useNewest = false,
) {
  const cfg = config(mode, useNewest);
  const dir = await testDirectory(`chaos-${seed}-`);
  const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
  await Deno.mkdir(paths.run);
  await Deno.mkdir(paths.lib);
  const r = seeded(seed), noise = seeded(seed + 1000);
  // Guest load, constant over each 30-minute reading interval: CI-like days and quiet nights.
  const loads: number[] = [];
  const load = (at: number) => {
    const k = Math.floor((at - start) / READING_MS);
    while (loads.length <= k) {
      const hour = (start + loads.length * READING_MS) / 3_600_000 % 24;
      loads.push(hour >= 6 && hour < 22 ? 1 + r() * 5 : 0.05 + r() * 0.4);
    }
    return loads[k];
  };
  // Box A's meter with reading noise; a reading covers the 30 minutes before it. Partway through,
  // the meter jumps by 0.3 cores, so drift detection, its holds and their recovery take part.
  const errors: number[] = [], jumpAt = start + (2 + r() * 2) * 86_400_000;
  const reading = (k: number) => {
    while (errors.length <= k) errors.push((noise() - 0.5) * 0.04);
    const at = start + k * READING_MS, u = load(at - READING_MS);
    const host = 1.0463 * u + 0.0193 + errors[k] + (at > jumpAt ? 0.3 : 0);
    return { at, v: host / p.vcpus * 100 };
  };
  const f = fixture(cfg, paths);
  let now = start;
  f.io.readings = (_h, _id, from, to = now) => {
    const out = [];
    for (
      let k = Math.max(1, Math.ceil((from - start) / READING_MS));
      start + k * READING_MS <= to;
      k++
    ) {
      out.push(reading(k));
    }
    return Promise.resolve(out);
  };
  // The daemon's own start-up protocol, so a restart here recovers exactly as one on a box does.
  const open = () => openGovernor(cfg, p, now, f.io, paths);
  const stop = async (g: Governor) => {
    await g.save(now);
    await g.closeDiagnostics();
    await g.closeHistory();
  };
  const request = async (g: Governor, body: Record<string, unknown>) => {
    g.io.requestInfo = () =>
      Promise.resolve({ uid: 0, mode: 0o644, isFile: true, isSymlink: false, size: 100 });
    g.io.requestBody = () => Promise.resolve(JSON.stringify(body));
    return g.request("/chaos/request", await g.io.clock());
  };
  let g = f.g;
  await g.loadHistory(now);
  let floor = learnedState(g).applied, passes = 0;
  const events: string[] = [];
  // Credit limits come and go, so restarts, crashes and lost files land inside them too: Hostinger
  // takes most of the demand, and the lift tests' burners find the limit until it lifts. Passes
  // come every minute meanwhile, so detection has the samples it needs.
  let limitedUntil = -Infinity;
  const limited = () => now < limitedUntil;
  f.io.demand = () =>
    Promise.resolve(
      limited()
        ? { busy: 2.4 / p.vcpus, steal: 0.5, seconds: 25 }
        : { busy: 6 / p.vcpus, steal: 0, seconds: 25 },
    );
  // Explain compares with what the daemon published, which only a pass does.
  let passed = false;
  try {
    for (let step = 0; step < steps; step++) {
      const x = r(), stepFrom = now;
      const pass = async (seconds = limited() ? 60 : TICK_S, wall = seconds) => {
        const busy = load(now) / p.vcpus;
        f.elapse(seconds, busy, limited() ? 2 * busy : 0, undefined, wall);
        now += wall * 1000;
        await g.tick();
        await flush();
        passes++;
        passed = true;
      };
      if (!limited() && r() < 0.003) {
        events.push(`limit@${step}`);
        limitedUntil = now + (1 + 2 * r()) * 3_600_000;
      }
      if (x < 0.9) await pass();
      else if (x < 0.92) {
        events.push(`stop@${step}`);
        await pass(3 * 3600);
      } else if (x < 0.93) {
        events.push(`clock@${step}`);
        await pass(TICK_S, TICK_S + 3600);
      } else if (x < 0.94) {
        events.push(`reboot@${step}`);
        await stop(g);
        f.reboot();
        now += 10_800_000;
        g = await open();
        passed = false;
        await g.tick();
        passed = true;
      } else if (x < 0.97) {
        const kind = x < 0.945 ? "restart" : x < 0.95 ? "crash" : x < 0.96 ? "lose" : "corrupt";
        events.push(`${kind}@${step}${g.s.limit ? " limited" : ""}`);
        // A crash lands between the two writes: history holds the last pass, persist.json the one
        // before it.
        const behind = kind === "crash"
          ? await Deno.readTextFile(`${paths.lib}/persist.json`).catch(() => null)
          : null;
        if (kind === "crash") await pass();
        await stop(g);
        const before = learnedState(g);
        if (behind !== null) await Deno.writeTextFile(`${paths.lib}/persist.json`, behind);
        if (kind === "lose") await Deno.remove(`${paths.lib}/persist.json`);
        if (kind === "corrupt") await Deno.writeTextFile(`${paths.lib}/persist.json`, "{ torn");
        g = await open();
        passed = false;
        // A restart reads it back; a crash catches up with the newer evaluation; a lost or
        // corrupt file is recovered from the recorded evaluation. Each holds the same state.
        assertEquals(learnedState(g), before, `seed ${seed}: ${events.join(" ")}`);
      } else if (x < 0.98) {
        events.push(`reset@${step}`);
        await request(g, { action: "calibration-reset" });
        floor = CALIBRATION.start;
        // Often `sudo governor tick` follows at once, inside the same measured interval.
        await pass(r() < 0.5 ? 2 : TICK_S);
      } else {
        events.push(`seed@${step}`);
        await request(g, { action: "seed", balance: r() * p.capacity });
        await pass(r() < 0.5 ? 2 : TICK_S);
      }
      const context = `seed ${seed} step ${step}: ${events.slice(-5).join(" ")}`;
      assertEquals(unsaved(g.s), null, context);
      // Readings can only lower the balance the governor acts on.
      const estimates = g.calibration.estimates;
      assert(estimates.acted <= estimates.open + 1e-6, context);
      const settings = g.settings;
      assert(
        settings.mul >= 1 && settings.mul <= 1.3 && settings.add >= 0 && settings.add <= 0.5,
        context,
      );
      // Learned settings only tighten, apart from a reset and the fit after a meter change, made
      // in this step.
      const learned = learnedState(g).applied;
      const refitChange = g.history.calibrations.some((d) =>
        d.at >= stepFrom && d.trigger === "fit" && d.inputs.since !== undefined
      );
      if (!refitChange) {
        assert(!looser(learned, floor), `${context}: ${JSON.stringify([floor, learned])}`);
      }
      floor = learned;
      // Explain reruns the recorded evaluation and must equal the daemon's state, after any pass:
      // an evaluation, one in between, or the pass after a request.
      if ((r() < 0.08 || x >= 0.97) && g.history.checkpoint && passed) {
        await g.save(now);
        await g.closeHistory();
        const explained = await explainCalibration(cfg, paths.lib);
        const status = g.calibrationStatus();
        // It replays the daemon's newest evaluation, not an older one still on disk.
        assertEquals(explained.evidence.at, g.calibration.evaluatedAt, context);
        assertEquals(
          [explained.applied, explained.learned, explained.gap, explained.estimates],
          [status.applied, status.learned, status.gap, status.estimates],
          context,
        );
      }
    }
  } finally {
    await stop(g).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
  return { events, passes };
}

Deno.test("random restarts, recoveries, stops and clock jumps keep the calibration rules", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const inside: string[] = [];
    // Seed 3 counts the newest reading of each fetch, which the passes between evaluations replay
    // apart from the rest.
    for (const seed of [1, 2, 3]) {
      const { events } = await run(seed, 1200, "apply", seed === 3);
      assert(events.length > 20, `seed ${seed}: ${events.length} events`);
      inside.push(...events.filter((e) => e.endsWith(" limited")));
    }
    // Some restarts, crashes or losses land while the box is limited.
    assert(inside.length > 0, "no restart during a limit");
    // Off, the default on every upgraded box: its legacy margin must survive the same.
    const { events } = await run(4, 1200, "off");
    assert(events.length > 20, `off: ${events.length} events`);
  } finally {
    console.log = log;
  }
});
