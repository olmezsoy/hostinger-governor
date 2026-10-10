// The daemon. Every tick it samples the machine, keeps a lower-bound mirror of Hostinger's CPU credit
// balance and sets one CPU ceiling on the slice every login runs in, so the balance is spent on work
// and never runs out. It owns all of it: consumers read /run/governor/state.json (or `governor
// status`), ask through `governor limit|seed`, and learn of limits through hooks.
//
// Every 15 minutes Hostinger's own CPU readings, replayed through the rules, anchor the mirror: exact
// once a replay reaches capacity, a floor under it before. Steal of 10% over five minutes is a limit
// or noisy neighbours: steal on most of the demand is a limit; otherwise a 40-second test cuts demand
// under the limit, then restores it, and only steal that follows demand is a limit. A limit holds the
// slice under it so earning resumes (halving the ceiling while steal persists), widens the mirror's
// margin by the drift it proves, and runs the hooks; once the mirror is back at the recovery point a
// 30-second load on more cores than the limit allows shows whether it is gone.
import {
  allowedCores,
  type Anchor,
  charged,
  creditStep,
  LAW,
  LIMIT_EVIDENT,
  limitConfirmed,
  MARGIN,
  type Margin,
  type Reading,
  replay,
  sliceCeiling,
  widen,
} from "./credits.ts";
import { cpuReadings, type TokenSource, vm } from "./hostinger.ts";
import { type Plan, plan, RULES_SINCE } from "./plans.ts";
import {
  type Counters,
  readCounters,
  shares,
  stealShare,
  topSnapshot,
  type UsageSnapshot,
  userUsage,
  vcpusSeen,
} from "./sample.ts";

export const PATHS = {
  config: Deno.env.get("GOVERNOR_CONFIG") ?? "/etc/governor/config.json",
  hooks: "/etc/governor/hooks.d",
  run: "/run/governor",
  lib: "/var/lib/governor",
  cap: "/usr/local/libexec/governor-cap",
};
export const STATE_FILE = `${PATHS.run}/state.json`;
export const REQUESTS = `${PATHS.run}/requests`;

export type Config = {
  hostinger?: TokenSource & { vm_id?: number };
  // The slice whose ceiling the governor sets; every login runs under user.slice.
  slice?: string;
  timezone?: string;
  initial_balance?: number;
  tick_seconds?: number;
  // Overrides the plan read from Hostinger's API.
  vcpus?: number;
};

export type Sample = {
  at: number;
  busy: number;
  steal: number;
  users?: Record<string, number>;
};
export type Limit = { since: number; ceiling: number; heldFrom: number; testAt?: number };

type Private = {
  balance: number;
  at: number;
  margin: Margin;
  used: number;
  anchor?: Anchor & { checkedAt: number };
  limit?: Limit;
  probe: { cooldownUntil: number; backoffMs: number };
  samples: Sample[];
  readings: Reading[];
  cpuPrev?: Counters;
  usagePrev?: UsageSnapshot;
  ceiling?: number;
  topAt?: number;
};

// What every consumer reads.
export type PublicState = {
  updatedAt: number;
  plan: Plan;
  slice: string;
  timezone: string;
  credits: {
    balance: number;
    percent: number;
    minutesAtFull: number;
    // vCPUs of credit earned per second now; negative while spending.
    rate: number;
    margin: Margin;
    anchor: { checkedAt: number; exact: boolean } | null;
  };
  ceiling: number;
  limit: Limit | null;
  cpu: { busy5: number; steal5: number; busy30: number; users30: Record<string, number> };
  readings: Reading[];
  // False while Hostinger limits the machine: start nothing that can wait.
  accepting: boolean;
};

const STEAL_WINDOW_MS = 5 * 60_000;
const CPU_WINDOW_MS = 30 * 60_000;
const KEEP_MS = 2 * 3_600_000;
const READINGS_KEEP_MS = 48 * 3_600_000;
const ANCHOR_EVERY_MS = 15 * 60_000;
const LIMIT_STEAL = 0.1;
const LIMIT_PRESSING = 0.02;
const TEST_EVERY_MS = 20 * 60_000;
const TIGHTEN_AFTER_MS = 15 * 60_000;
const BACKOFF_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const HOT_BUSY = 0.6;
const HOT_STEAL = 0.05;
const TOP_EVERY_MS = 5 * 60_000;

const log = (...parts: unknown[]) => console.log(parts.map(String).join(" "));
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function list(dir: string): Promise<Deno.DirEntry[]> {
  try {
    return await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
}

export async function loadConfig(): Promise<Config> {
  return JSON.parse(await Deno.readTextFile(PATHS.config).catch(() => "{}"));
}

async function writeJson(path: string, value: unknown, mode: number) {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(value));
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
}

export async function detectPlan(cfg: Config): Promise<Plan> {
  if (cfg.vcpus) return plan(cfg.vcpus);
  const h = cfg.hostinger;
  if (h?.vm_id) {
    try {
      const v = await vm(h, h.vm_id);
      if (v.cpus) return plan(v.cpus, v.plan ?? `KVM ${v.cpus}`);
    } catch (e) {
      log("plan from Hostinger's API failed, counting vCPUs:", e);
    }
  }
  return plan(await vcpusSeen());
}

async function capSlice(slice: string, percent: number): Promise<boolean> {
  const out = await new Deno.Command("sudo", {
    args: ["-n", PATHS.cap, String(percent), slice],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) log("ceiling not set:", new TextDecoder().decode(out.stderr).trim());
  return out.success;
}

async function ceilingNow(slice: string): Promise<number | null> {
  const raw = await Deno.readTextFile(`/sys/fs/cgroup/${slice}/cpu.max`).catch(() => "");
  const [quota, period] = raw.trim().split(/\s+/);
  return quota && quota !== "max" ? Math.round((100 * Number(quota)) / Number(period)) : null;
}

// Every executable in hooks.d, with the event in GOVERNOR_EVENT and the state on stdin.
async function runHooks(event: string, state: PublicState) {
  const entries: string[] = [];
  for (const e of await list(PATHS.hooks)) {
    if (e.isFile || e.isSymlink) entries.push(e.name);
  }
  for (const name of entries.sort()) {
    try {
      const child = new Deno.Command(`${PATHS.hooks}/${name}`, {
        env: { GOVERNOR_EVENT: event },
        stdin: "piped",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(JSON.stringify(state)));
      await w.close();
      const timer = setTimeout(() => child.kill(), 60_000);
      const out = await child.output();
      clearTimeout(timer);
      if (!out.success) {
        log(`hook ${name} (${event}) failed:`, new TextDecoder().decode(out.stderr).trim());
      }
    } catch (e) {
      log(`hook ${name} (${event}) failed:`, e);
    }
  }
}

export class Governor {
  s: Private;
  constructor(readonly cfg: Config, readonly plan: Plan, saved?: Private) {
    this.s = saved ?? {
      balance: Math.min(cfg.initial_balance ?? 0, plan.capacity),
      at: Date.now(),
      margin: MARGIN,
      used: 0,
      probe: { cooldownUntil: 0, backoffMs: BACKOFF_MS },
      samples: [],
      readings: [],
    };
  }
  get slice() {
    return this.cfg.slice ?? "user.slice";
  }

  publicState(now: number): PublicState {
    const s = this.s;
    const p = this.plan;
    const recent = s.samples.filter((x) => now - x.at <= STEAL_WINDOW_MS);
    const half = s.samples.filter((x) => now - x.at <= CPU_WINDOW_MS);
    const users30: Record<string, number> = {};
    for (const x of half) {
      for (const [who, v] of Object.entries(x.users ?? {})) {
        users30[who] = (users30[who] ?? 0) + v / half.length;
      }
    }
    const busy5 = avg(recent.map((x) => x.busy));
    return {
      updatedAt: now,
      plan: p,
      slice: this.slice,
      timezone: this.cfg.timezone ?? "UTC",
      credits: {
        balance: Math.round(s.balance),
        percent: Math.round((100 * s.balance) / p.capacity),
        minutesAtFull: Math.round(s.balance / (p.vcpus - p.baseline) / 60),
        rate: Math.round((p.baseline - charged(busy5 * p.vcpus, s.margin)) * 10) / 10,
        margin: s.margin,
        anchor: s.anchor ? { checkedAt: s.anchor.checkedAt, exact: s.anchor.exact } : null,
      },
      ceiling: s.ceiling ?? 0,
      limit: s.limit ?? null,
      cpu: {
        busy5,
        steal5: avg(recent.map((x) => x.steal)),
        busy30: avg(half.map((x) => x.busy)),
        users30,
      },
      readings: s.readings,
      accepting: !s.limit,
    };
  }

  enterLimit(now: number, learn: boolean) {
    const s = this.s;
    if (learn) s.margin = widen(s.margin, s.balance, s.used);
    s.balance = 0;
    s.used = 0;
    // Under the limit with what runs outside the slice on top.
    const ceiling = Math.max(20, Math.floor((this.plan.limit - 0.4) * 10) * 10);
    s.limit = { since: now, ceiling, heldFrom: now };
  }

  async request(path: string, now: number) {
    const r = JSON.parse(await Deno.readTextFile(path)) as { action?: string; balance?: number };
    if (r.action === "limit-on") this.enterLimit(now, false);
    else if (r.action === "limit-off") {
      this.s.limit = undefined;
      // Hostinger lifts a limit at the recovery point; the next anchor corrects this.
      this.s.balance = Math.max(this.s.balance, this.plan.recovered);
      this.s.used = 0;
    } else if (r.action === "seed" && typeof r.balance === "number") {
      this.s.balance = Math.min(Math.max(0, r.balance), this.plan.capacity);
      this.s.used = 0;
    } else return log("unknown request:", JSON.stringify(r));
    log("request:", JSON.stringify(r));
  }

  async anchorNow(now: number) {
    const h = this.cfg.hostinger;
    if (!h?.vm_id) return;
    const readings = await cpuReadings(h, h.vm_id, Math.max(now - READINGS_KEEP_MS, RULES_SINCE));
    if (!readings.length) return;
    this.s.readings = readings;
    const r = replay(this.plan, readings);
    if (!r) return;
    let b = r.balance;
    let t = r.at;
    for (const x of this.s.samples.filter((x) => x.at > r.at)) {
      b = creditStep(this.plan, b, x.busy * this.plan.vcpus, (x.at - t) / 1000, this.s.margin);
      t = x.at;
    }
    if (r.exact) [this.s.balance, this.s.used] = [b, 0];
    else this.s.balance = Math.max(this.s.balance, b);
    this.s.anchor = { ...r, checkedAt: now };
  }

  // Demand under the limit for 20 seconds, then back: a limit's steal follows demand.
  async probe(sf0: number, ceiling: number): Promise<boolean> {
    await capSlice(this.slice, 100);
    await sleep(5_000);
    const sfCut = await stealShare(15_000);
    await capSlice(this.slice, ceiling);
    await sleep(5_000);
    const sfRestore = await stealShare(15_000);
    log(
      `limit test: steal ${Math.round(sf0 * 100)}% of demand, ${Math.round(sfCut * 100)}% cut, ${
        Math.round(sfRestore * 100)
      }% restored`,
    );
    return limitConfirmed(sf0, sfCut, sfRestore);
  }

  // More cores than the limit allows, busy for 30 seconds: under it much of that is stolen.
  async limitGone(): Promise<boolean> {
    const n = Math.min(this.plan.vcpus, Math.ceil(this.plan.limit) + 2);
    const burn = Array.from(
      { length: n },
      () =>
        new Deno.Command("timeout", { args: ["35", "sh", "-c", "while :; do :; done"] }).spawn(),
    );
    await sleep(5_000);
    const share = await stealShare(25_000);
    await Promise.all(burn.map((c) => c.status));
    return share < 0.02;
  }

  async tick(now = Date.now()) {
    const s = this.s;
    const p = this.plan;
    const counters = await readCounters();
    const prev = s.cpuPrev;
    s.cpuPrev = counters;
    const usage = await userUsage(this.slice, now).catch(() => undefined);
    const users = usage && s.usagePrev ? shares(s.usagePrev, usage, p.vcpus) : undefined;
    if (usage) s.usagePrev = usage;
    if (!prev || counters.total <= prev.total) return;
    const total = counters.total - prev.total;
    const sample: Sample = {
      at: now,
      busy: (counters.busy - prev.busy) / total,
      steal: (counters.steal - prev.steal) / total,
      users,
    };
    s.samples = [...s.samples, sample].filter((x) => now - x.at <= KEEP_MS);
    if (
      (sample.busy >= HOT_BUSY || sample.steal >= HOT_STEAL) &&
      now - (s.topAt ?? 0) >= TOP_EVERY_MS
    ) {
      s.topAt = now;
      await topSnapshot(`${PATHS.lib}/top`, now).catch((e) => log("top snapshot failed:", e));
    }

    const seconds = (now - s.at) / 1000;
    const busyCores = sample.busy * p.vcpus;
    const earning = !(s.limit && sample.steal >= LIMIT_PRESSING);
    s.balance = creditStep(p, s.balance, busyCores, seconds, s.margin, earning);
    s.used += charged(busyCores, s.margin) * seconds;
    s.at = now;
    if (!s.limit && now - (s.anchor?.checkedAt ?? 0) >= ANCHOR_EVERY_MS) {
      await this.anchorNow(now).catch((e) => log("anchor failed:", e));
    }

    const recent = s.samples.filter((x) => now - x.at <= STEAL_WINDOW_MS);
    const steal = recent.length >= 3 ? avg(recent.map((x) => x.steal)) : 0;
    const busy = avg(recent.map((x) => x.busy));
    const outside = avg(
      recent.map((x) =>
        Math.max(0, x.busy - Object.values(x.users ?? {}).reduce((a, b) => a + b, 0))
      ),
    ) * p.vcpus;
    const current = await ceilingNow(this.slice);

    if (!s.limit && steal >= LIMIT_STEAL && now >= s.probe.cooldownUntil) {
      const sf0 = steal / (busy + steal);
      if (sf0 >= LIMIT_EVIDENT || await this.probe(sf0, current ?? 100 * p.vcpus)) {
        this.enterLimit(now, true);
        s.probe.backoffMs = BACKOFF_MS;
        log(`limit: start (margin x${s.margin.mul} +${s.margin.add})`);
        await runHooks("limit-start", this.publicState(now));
      } else {
        s.probe.cooldownUntil = now + s.probe.backoffMs;
        s.probe.backoffMs = Math.min(s.probe.backoffMs * 2, BACKOFF_MAX_MS);
      }
    }

    const limit = s.limit;
    if (limit) {
      if (steal >= HOT_STEAL && now - limit.heldFrom >= TIGHTEN_AFTER_MS && limit.ceiling > 40) {
        limit.ceiling = Math.max(40, Math.round(limit.ceiling / 2));
        limit.heldFrom = now;
        log(`limit: still pressing on it; ceiling ${limit.ceiling}%`);
      }
      if (s.balance >= p.recovered && now >= (limit.testAt ?? 0)) {
        if (await this.limitGone()) {
          s.limit = undefined;
          log("limit: lifted");
          await runHooks("limit-end", this.publicState(now));
        } else limit.testAt = now + TEST_EVERY_MS;
      }
    }

    const target = s.limit
      ? s.limit.ceiling
      : sliceCeiling(p, allowedCores(p, s.balance, s.margin, LAW), outside);
    if (target === current) s.ceiling = target;
    else if (await capSlice(this.slice, target)) {
      if (Math.abs(target - (s.ceiling ?? 0)) >= 100 || s.limit) {
        log(
          `ceiling ${target}%: ${Math.round(busy * 100)}% busy, ${
            Math.round(steal * 100)
          }% steal, ${Math.round((100 * s.balance) / p.capacity)}% credits`,
        );
      }
      s.ceiling = target;
    }
  }

  async takeRequests(now: number) {
    for (const e of await list(REQUESTS)) {
      if (!e.isFile || e.name.startsWith(".")) continue;
      const path = `${REQUESTS}/${e.name}`;
      await this.request(path, now).catch((err) => log("bad request:", err));
      await Deno.remove(path).catch(() => {});
    }
  }

  async save(now: number) {
    await writeJson(`${PATHS.lib}/persist.json`, this.s, 0o600);
    await writeJson(STATE_FILE, this.publicState(now), 0o644);
  }
}

export async function runDaemon() {
  const cfg = await loadConfig();
  const p = await detectPlan(cfg);
  const saved = JSON.parse(
    await Deno.readTextFile(`${PATHS.lib}/persist.json`).catch(() => "null"),
  ) as Private | null;
  const g = new Governor(cfg, p, saved ?? undefined);
  log(
    `governor up: ${p.name}, baseline ${p.baseline} vCPU, capacity ${p.capacity} core-seconds, ${
      Math.round((100 * g.s.balance) / p.capacity)
    }% credits`,
  );
  const tickMs = (cfg.tick_seconds ?? 30) * 1000;
  let stopping = false;
  Deno.addSignalListener("SIGTERM", () => stopping = true);
  while (!stopping) {
    const now = Date.now();
    try {
      await g.takeRequests(now);
      await g.tick(now);
      await g.save(now);
    } catch (e) {
      log("tick failed:", e);
    }
    for (let waited = 0; waited < tickMs && !stopping; waited += 1000) await sleep(1000);
  }
  await g.save(Date.now()).catch(() => {});
}

// Run by systemd as root when the daemon stops: a ceiling under the baseline, so an unwatched machine
// cannot drain its balance.
export async function fallback() {
  const cfg = await loadConfig();
  const p = await detectPlan({ ...cfg, hostinger: undefined });
  const ceiling = sliceCeiling(p, allowedCores(p, LAW.floor * p.capacity, MARGIN), 0.4);
  const out = await new Deno.Command("systemctl", {
    args: ["set-property", "--runtime", cfg.slice ?? "user.slice", `CPUQuota=${ceiling}%`],
  }).output();
  log(`fallback ceiling ${ceiling}%`, out.success ? "set" : "failed");
}
