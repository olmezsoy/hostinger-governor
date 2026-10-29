// Daemon CPU with a full history: one simulated day of 30-second control passes, each taking
// requests, ticking and saving as controlPass does, on top of 90 days of evidence. Run it the way
// release binaries run, without the JIT:
//
//   deno task bench:cpu              # the last credit-limit anchor 30 days back
//   deno task bench:cpu 90           # the last anchor 90 days back, where history starts: the
//                                    # longest replay
//
// Only GovernorIO is faked, so this measures the governor's own work. Reading /proc and cgroup files
// and running the cap helper come on top; the v0.2.5 daemon measured 0.03-0.04% of a core with them.
import process from "node:process";
import { Governor, type GovernorIO, readPersisted } from "../src/governor.ts";
import {
  DAY,
  emptyHistory,
  HistoryStore,
  type LimitRecord,
  planKey,
  SLOT_MS,
} from "../src/history.ts";
import { CALIBRATION } from "../src/calibration.ts";
import { plan } from "../src/plans.ts";
import { testDirectory } from "./temp.ts";

const p = plan(8);
// A Monday, 90 days after the history starts.
const start = Date.parse("2026-10-12T00:00:00Z");
const from = start - 90 * DAY;
// CI-shaped days at about twice box A's load: busy weekday daytime, quiet nights and weekends.
const cores = (t: number) => {
  const day = Math.floor((t - from) / DAY), hour = (t % DAY) / 3_600_000;
  const working = (day + 7 - 90 % 7) % 7 < 5 && hour >= 6 && hour < 22;
  return working ? 4.4 + 0.3 * Math.sin(t / 3_000_000) : 1.2 + 0.2 * Math.sin(t / 700_000);
};
const reading = (at: number) => {
  let sum = 0;
  for (let t = at - 1_800_000; t < at; t += 60_000) sum += 1.0463 * cores(t) + 0.0193;
  return { at, v: sum / 30 / p.vcpus * 100 };
};

export async function measure(anchorDays = 30) {
  const h = emptyHistory(planKey(p), 1, from);
  for (let t = from; t < start; t += SLOT_MS) {
    const c = cores(t);
    h.slots.push({
      at: t,
      seconds: 600,
      busy: Math.round(c * 60000) / 100,
      steal: 0,
      managed: Math.round(c * 60000) / 100,
      outside: 0,
      charged: Math.round((1.05 * c + 0.04) * 60000) / 100,
      flags: 0,
    });
  }
  for (let t = from + 1_800_000; t < start; t += 1_800_000) h.readings.push(reading(t));
  h.meterPairs = h.readings.slice(1).map((r, i) => ({
    at: r.at,
    from: h.readings[i].at,
    own: cores(r.at - 900_000),
    seconds: 1800,
  }));
  // Fifty retained credit limits, the newest anchoring replays `anchorDays` back.
  const limit = (onset: number): LimitRecord => ({
    onset,
    entry: onset + 90_000,
    lift: onset + 3_600_000,
    path: "evident",
    balance: 3000,
    used: 40000,
    settings: { ...CALIBRATION.start },
    gap: 0,
    mode: "apply",
    track: null,
    caps: [{ at: onset + 90_000, busy: 2.4, demand: 5, ceiling: 200, pressing: true }],
    confirmed: true,
    learn: false,
    firstTest: "limited",
    class: "credit",
  });
  h.limits = Array.from(
    { length: 50 },
    (_, i) => limit(start - anchorDays * DAY - (49 - i) * 3_600_000 * 2),
  );

  const dir = await testDirectory("daemon-cpu-");
  const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
  await Deno.mkdir(paths.run);
  await Deno.mkdir(paths.lib);
  const store = new HistoryStore(`${paths.lib}/history.json`, () => {});
  store.write(h, start);
  await store.close();

  let at = start, uptime = 1_000_000;
  const counters = { busy: 0, steal: 0, total: 1000 };
  let cap = 800, usage = 0;
  const io: Partial<GovernorIO> = {
    clock: () => Promise.resolve({ at, uptime, bootId: "a" }),
    counters: () => Promise.resolve({ ...counters }),
    usage: (_slice, at) => Promise.resolve({ at, total: usage, usage: {} }),
    cap: (_slice, n) => {
      cap = n;
      return Promise.resolve(true);
    },
    ceiling: () => Promise.resolve(cap),
    readings: (_src, _id, lo, hi) => {
      const out = [];
      for (let t = Math.ceil(lo / 1_800_000) * 1_800_000; t <= (hi ?? at); t += 1_800_000) {
        out.push(reading(t));
      }
      return Promise.resolve(out);
    },
    hooks: () => Promise.resolve(),
    snapshot: () => Promise.resolve(),
  };
  const cfg = {
    vcpus: 8,
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" as const },
  };
  const log = console.log;
  console.log = () => {};
  // A daemon restarting with its persist.json intact, so the clamp replays from history's anchor
  // `anchorDays` back. The first run only writes that persist.json; a start without one would
  // anchor the clamp at its own start instead.
  const first = new Governor(cfg, p, undefined, io, paths);
  await first.loadHistory(at);
  await first.tick();
  await first.save(at);
  await first.closeHistory();
  await first.closeDiagnostics();
  const saved = (await readPersisted(`${paths.lib}/persist.json`)).saved!;
  delete saved.rebootPending;
  const g = new Governor(cfg, p, saved, io, paths);
  const pass = async () => {
    const clock = await g.io.clock();
    await g.takeRequests(clock);
    await g.tick(clock);
    await g.save(at);
  };
  try {
    await g.loadHistory(at);
    await pass();
    const written = g.historyWritten;
    const passes = DAY / 30_000;
    let clamped = 0;
    const cpu = process.cpuUsage(), wall = performance.now();
    for (let i = 0; i < passes; i++) {
      const c = cores(at);
      at += 30_000;
      uptime += 30_000;
      counters.total += 1000;
      counters.busy += c / p.vcpus * 1000;
      usage += c * 30 * 1_000_000;
      await pass();
      if (g.calibration.estimates.clamp !== null) clamped++;
      // Let background fetches publish.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await g.closeHistory();
    const used = process.cpuUsage(cpu);
    const ms = (used.user + used.system) / 1000;
    return {
      anchorDays,
      passes,
      cpuMs: Math.round(ms),
      wallMs: Math.round(performance.now() - wall),
      coreShare: ms / DAY,
      // The clamp's replays are most of the work, so they must actually run.
      clampShare: clamped / passes,
      snapshotBytes: (await Deno.stat(`${paths.lib}/history.json`)).size,
      writtenBytesPerDay: g.historyWritten - written,
      // save() rewrites persist.json on every pass, as v0.2.5 did.
      persistBytes: (await Deno.stat(`${paths.lib}/persist.json`)).size,
    };
  } finally {
    console.log = log;
    await g.closeDiagnostics();
    await Deno.remove(dir, { recursive: true });
  }
}

// #13's budget: 0.1% of one core averaged over a day, with 90 days of history.
export const BUDGET = 0.001;

if (import.meta.main) {
  const result = await measure(Number(Deno.args[0] ?? 30));
  console.log(JSON.stringify({ ...result, percentOfCore: +(result.coreShare * 100).toFixed(4) }));
  if (result.coreShare > BUDGET) {
    console.error(`daemon CPU ${(result.coreShare * 100).toFixed(4)}% of a core exceeds 0.1%`);
    Deno.exit(1);
  }
  if (result.clampShare < 0.99) {
    console.error(`the clamp ran on only ${(result.clampShare * 100).toFixed(1)}% of passes`);
    Deno.exit(1);
  }
}
