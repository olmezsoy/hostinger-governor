import { type Config, Governor, type GovernorIO } from "../src/governor.ts";
import { plan, RULES_SINCE } from "../src/plans.ts";

export const p = plan(8);
export const start = RULES_SINCE + 10_800_000;
export function fixture(config: Config = {}, paths?: { run: string; lib: string }) {
  let at = start;
  let uptime = 100_000;
  let bootId = "boot-a";
  let counters = { busy: 0, steal: 0, total: 1000 };
  let usage = 0;
  let cap = 200;
  let attempts = 0;
  let failCap = false;
  let owner = 0;
  let mode = 0o644;
  let symlink = false;
  let request = { action: "seed", balance: p.capacity };
  const io: GovernorIO = {
    clock: () => Promise.resolve({ at, uptime, bootId }),
    counters: () => Promise.resolve({ ...counters }),
    usage: (_slice, at) => Promise.resolve({ at, total: usage, usage: {} }),
    cap: (_slice, n) => {
      if (!failCap) cap = n;
      return Promise.resolve(!failCap);
    },
    ceiling: () => Promise.resolve(cap),
    readings: () => {
      attempts++;
      return Promise.resolve([{ at: start - 10_800_000, v: 0 }, { at: start, v: 0 }]);
    },
    hooks: () => Promise.resolve(),
    snapshot: () => Promise.resolve(),
    requestInfo: () =>
      Promise.resolve({ uid: owner, mode, isFile: !symlink, isSymlink: symlink, size: 100 }),
    requestBody: () => Promise.resolve(JSON.stringify(request)),
    pause: () => Promise.resolve(),
    steal: () => Promise.resolve(0),
    demand: () => Promise.resolve({ busy: 4.7 / p.vcpus, steal: 0.06, seconds: 25 }),
    burner: () => ({
      status: Promise.resolve({ success: false, code: 124, signal: null }),
      kill: () => {},
    }),
  };
  function elapse(
    seconds = 30,
    busy = 0,
    steal = 0,
    managed = busy * p.vcpus,
    wallSeconds = seconds,
    counterTicks = 1000,
  ) {
    at += wallSeconds * 1000;
    uptime += seconds * 1000;
    counters.total += counterTicks;
    counters.busy += busy * counterTicks;
    counters.steal += steal * counterTicks;
    usage += managed * seconds * 1_000_000;
  }
  const g = new Governor(config, p, undefined, io, paths);
  return {
    g,
    io,
    get cap() {
      return cap;
    },
    get attempts() {
      return attempts;
    },
    capFails() {
      failCap = true;
    },
    request(action: string, uid = 0, permissions = 0o644, link = false) {
      owner = uid;
      mode = permissions;
      symlink = link;
      request = { action, balance: p.capacity };
      return g.request("/fixture/request", at);
    },
    elapse,
    advance(
      seconds = 30,
      busy = 0,
      steal = 0,
      managed = busy * p.vcpus,
      wallSeconds = seconds,
      counterTicks = 1000,
    ) {
      elapse(seconds, busy, steal, managed, wallSeconds, counterTicks);
      return g.tick();
    },
    reboot() {
      at += 10_800_000;
      uptime = 5000;
      bootId = "boot-b";
      counters = { busy: 0, steal: 0, total: 1000 };
      usage = 0;
    },
    resetCounters() {
      counters = { busy: 0, steal: 0, total: 1000 };
    },
  };
}
