import { type Config, Governor, type GovernorIO, type Private } from "../src/governor.ts";
import type { Reading } from "../src/credits.ts";
import { plan, RULES_SINCE } from "../src/plans.ts";
import { flush } from "./async.ts";

export const p = plan(8);
export const start = RULES_SINCE + 10_800_000;
export const FEED = { hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" } };

// A governor over a fake box: the test moves the clock and the CPU counters, and reads what the
// governor set.
export function fixture(
  config: Config = {},
  saved?: Private | Record<string, unknown>,
  paths?: { run: string; lib: string },
) {
  let at = start;
  let uptime = 100_000;
  let bootId = "boot-a";
  let counters = { busy: 0, steal: 0, total: 1000 };
  let usage = 0;
  let cap = 200;
  let failCap = false;
  let owner = 0;
  let mode = 0o644;
  let symlink = false;
  let request: Record<string, unknown> = { action: "seed", balance: p.capacity };
  const world = {
    // What Hostinger's API returns. The newest reading is the one the governor leaves unsettled.
    readings: [] as Reading[],
    fetches: 0,
    events: [] as string[],
    caps: [] as number[],
    // Steal shares a probe measures, in order: cut, then restored.
    probe: [] as number[],
    // What a burner test measures.
    burn: { busy: 4.7 / p.vcpus, steal: 0.06, seconds: 25 },
    burners: 0,
    snapshots: 0,
  };
  const io: GovernorIO = {
    clock: () => Promise.resolve({ at, uptime, bootId }),
    counters: () => Promise.resolve({ ...counters }),
    usage: (_slice, at) => Promise.resolve({ at, total: usage, usage: {} }),
    cap: (_slice, n) => {
      if (!failCap) {
        cap = n;
        world.caps.push(n);
      }
      return Promise.resolve(!failCap);
    },
    ceiling: () => Promise.resolve(cap),
    readings: () => {
      world.fetches++;
      return Promise.resolve([...world.readings]);
    },
    hooks: (event) => {
      world.events.push(event);
      return Promise.resolve();
    },
    snapshot: () => {
      world.snapshots++;
      return Promise.resolve();
    },
    requestInfo: () =>
      Promise.resolve({ uid: owner, mode, isFile: !symlink, isSymlink: symlink, size: 100 }),
    requestBody: () => Promise.resolve(JSON.stringify(request)),
    pause: () => Promise.resolve(),
    steal: () => Promise.resolve(world.probe.shift() ?? 0),
    demand: () => Promise.resolve({ ...world.burn }),
    burner: () => {
      world.burners++;
      return {
        status: Promise.resolve({ success: false, code: 124, signal: null }),
        kill: () => {},
      };
    },
  };
  function elapse(
    seconds = 30,
    busy = 0,
    steal = 0,
    managed = busy * p.vcpus,
    wall = seconds,
    // Counter ticks in proportion to time, so shares stay exact.
    ticks = seconds * 100,
  ) {
    at += wall * 1000;
    uptime += seconds * 1000;
    counters.total += ticks;
    counters.busy += busy * ticks;
    counters.steal += steal * ticks;
    usage += managed * seconds * 1_000_000;
  }
  const g = new Governor(config, p, saved as Private | undefined, io, paths);
  const f = {
    g,
    io,
    world,
    get cap() {
      return cap;
    },
    get at() {
      return at;
    },
    get uptime() {
      return uptime;
    },
    capFails(fails = true) {
      failCap = fails;
    },
    request(body: Record<string, unknown>, uid = 0, permissions = 0o644, link = false) {
      owner = uid;
      mode = permissions;
      symlink = link;
      request = body;
      return g.request("/fixture/request", { at, uptime, bootId });
    },
    elapse,
    // One control pass after `seconds` at these shares of the VM. `managed` is the slice's cores.
    async advance(seconds = 30, busy = 0, steal = 0, managed = busy * p.vcpus, wall = seconds) {
      elapse(seconds, busy, steal, managed, wall);
      await g.tick();
      // Let a readings fetch the pass started reach the next pass.
      await flush();
    },
    // `passes` passes of 30 seconds each.
    async run(passes: number, busy = 0, steal = 0, managed = busy * p.vcpus) {
      for (let i = 0; i < passes; i++) await f.advance(30, busy, steal, managed);
    },
    reboot(downSeconds = 600) {
      at += downSeconds * 1000;
      uptime = 5000;
      bootId = "boot-b";
      counters = { busy: 0, steal: 0, total: 1000 };
      usage = 0;
    },
    resetCounters() {
      counters = { busy: 0, steal: 0, total: 1000 };
    },
    // Another daemon on the same box, started from what this one last saved.
    restart(cfg: Config = config) {
      return new Governor(cfg, p, JSON.parse(JSON.stringify(g.s)), io, paths);
    },
  };
  return f;
}
