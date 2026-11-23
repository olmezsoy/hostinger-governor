// Daemon CPU: one simulated day of 30-second control passes, each taking requests, ticking and
// saving as controlPass does, with three hours of samples and three days of readings in state. Run
// it the way release binaries run, without the JIT:
//
//   deno task bench:cpu
//
// Only GovernorIO is faked, so this measures the governor's own work. Reading /proc and cgroup files
// and running the cap helper come on top; the v0.2.5 daemon measured 0.03-0.04% of a core with them.
import process from "node:process";
import { type GovernorIO, openGovernor } from "../src/governor.ts";
import { plan } from "../src/plans.ts";
import { testDirectory } from "./temp.ts";

const p = plan(8);
const DAY = 86_400_000;
// A Monday.
const start = Date.parse("2026-10-12T00:00:00Z");
// CI-shaped days at about twice box A's load: busy weekday daytime, quiet nights and weekends.
const cores = (t: number) => {
  const day = Math.floor((t - start) / DAY), hour = (t % DAY) / 3_600_000;
  const working = (day + 70) % 7 < 5 && hour >= 6 && hour < 22;
  return working ? 4.4 + 0.3 * Math.sin(t / 3_000_000) : 1.2 + 0.2 * Math.sin(t / 700_000);
};
const reading = (at: number) => {
  let sum = 0;
  for (let t = at - 1_800_000; t < at; t += 60_000) sum += 1.0463 * cores(t) + 0.0193;
  return { at, v: sum / 30 / p.vcpus * 100 };
};

export async function measure() {
  const dir = await testDirectory("daemon-cpu-");
  const paths = { run: `${dir}/run`, lib: `${dir}/lib` };
  await Deno.mkdir(paths.run);
  await Deno.mkdir(paths.lib);
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
  const cfg = { vcpus: 8, hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" } };
  const log = console.log;
  console.log = () => {};
  const g = await openGovernor(cfg, p, io, paths);
  const pass = async () => {
    const clock = await g.io.clock();
    await g.takeRequests(clock);
    await g.tick(clock);
    await g.save(at);
    // Let background fetches publish.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const day = async () => {
    for (let i = 0; i < DAY / 30_000; i++) {
      const c = cores(at);
      at += 30_000;
      uptime += 30_000;
      counters.total += 3000;
      counters.busy += c / p.vcpus * 3000;
      usage += c * 30 * 1_000_000;
      await pass();
    }
  };
  try {
    await pass();
    // Three days fill the state to its steady size before the measured one.
    for (let i = 0; i < 3; i++) await day();
    const cpu = process.cpuUsage(), wall = performance.now();
    await day();
    const used = process.cpuUsage(cpu);
    const ms = (used.user + used.system) / 1000;
    return {
      passes: DAY / 30_000,
      cpuMs: Math.round(ms),
      wallMs: Math.round(performance.now() - wall),
      coreShare: ms / DAY,
      // The estimate must be standing on the readings, or the replay was not measured.
      anchored: !!g.s.estimate.anchor && at - g.s.estimate.anchor.at < 7_200_000,
      samples: g.s.samples.length,
      readings: g.s.readings.length,
      // save() rewrites persist.json on every pass.
      persistBytes: (await Deno.stat(`${paths.lib}/persist.json`)).size,
    };
  } finally {
    console.log = log;
    await g.closeDiagnostics();
    await Deno.remove(dir, { recursive: true });
  }
}

// The budget: 0.1% of one core averaged over a day.
export const BUDGET = 0.001;

if (import.meta.main) {
  const result = await measure();
  console.log(JSON.stringify({ ...result, percentOfCore: +(result.coreShare * 100).toFixed(4) }));
  if (result.coreShare > BUDGET) {
    console.error(`daemon CPU ${(result.coreShare * 100).toFixed(4)}% of a core exceeds 0.1%`);
    Deno.exit(1);
  }
  if (!result.anchored) {
    console.error("the estimate never stood on the readings");
    Deno.exit(1);
  }
}
