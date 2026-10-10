// CPU accounting uses kernel uptime and boot identity. API history is diagnostic, never authority
// for increasing the bank. Root owns administrative requests; consumers read public state.
import {
  allowedCores,
  type Anchor,
  charged,
  creditStep,
  demandSteal,
  LAW,
  liftConfirmed,
  LIMIT_EVIDENT,
  LIMIT_PRESSING,
  limitConfirmed,
  MARGIN,
  type Margin,
  type Reading,
  recoveryCeiling,
  replay,
  sliceCeiling,
  tightenCeiling,
  widen,
} from "./credits.ts";
import { cpuReadings, type TokenSource, vm } from "./hostinger.ts";
import { type Plan, plan, RULES_SINCE } from "./plans.ts";
import {
  type Clock,
  type Counters,
  demandSample,
  readClock,
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
  baseline_share?: number;
};

export type Sample = {
  at: number;
  busy: number;
  steal: number;
  users?: Record<string, number>;
  uptime?: number;
  seconds?: number;
  outside?: number;
  clockValid?: boolean;
};
export type Limit = {
  since: number;
  ceiling: number;
  heldFrom: number;
  startedAt?: number;
  testAt?: number;
};

type Private = {
  schema?: number;
  planKey?: string;
  bootId?: string;
  uptime?: number;
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
  anchorNext?: number;
  anchorBackoff?: number;
  noEarn?: boolean;
  earning?: boolean;
  capFailed?: boolean;
};

// What every consumer reads.
export type PublicState = {
  updatedAt: number;
  bootId: string | null;
  uptime: number | null;
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
    anchor:
      | { checkedAt: number; exact: boolean; applied: boolean; difference: number | null }
      | null;
  };
  ceiling: number;
  limit: Limit | null;
  cpu: { busy5: number; steal5: number; busy30: number; users30: Record<string, number> };
  readings: Reading[];
  // False while Hostinger limits the machine: start nothing that can wait.
  accepting: boolean;
  coverage: { outsideCores: number; recoveryBlocked: boolean };
};

const STEAL_WINDOW_MS = 5 * 60_000;
const CPU_WINDOW_MS = 30 * 60_000;
const KEEP_MS = 2 * 3_600_000;
const READINGS_KEEP_MS = 48 * 3_600_000;
const ANCHOR_EVERY_MS = 30 * 60_000;
const LIMIT_STEAL = 0.1;
const TEST_EVERY_MS = 2 * 60_000;
const TIGHTEN_AFTER_MS = 60_000;
const BACKOFF_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const HOT_BUSY = 0.6;
const HOT_STEAL = 0.05;
const TOP_EVERY_MS = 5 * 60_000;

const log = (...parts: unknown[]) => console.log(parts.map(String).join(" "));
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Difference in percentage points under an end-stamped interval interpretation. A full guest
// interval must be present; this comparison cannot establish host billing semantics.
export function compareReadings(readings: Reading[], samples: Sample[]): number | null {
  let error = 0;
  let measured = 0;
  for (let i = 1; i < readings.length; i++) {
    const start = readings[i - 1].at;
    const end = readings[i].at;
    if (end - start !== 1_800_000) continue;
    let covered = 0;
    let guest = 0;
    for (const s of samples) {
      if (!s.seconds || s.clockValid === false) continue;
      const overlap = Math.max(0, Math.min(end, s.at) - Math.max(start, s.at - s.seconds * 1000));
      covered += overlap;
      guest += overlap * s.busy * 100;
    }
    if (covered < (end - start) * 0.99 || covered > (end - start) * 1.01) continue;
    error += readings[i].v * covered - guest;
    measured += covered;
  }
  return measured ? error / measured : null;
}
async function list(dir: string): Promise<Deno.DirEntry[]> {
  try {
    return await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
}

export async function loadConfig(): Promise<Config> {
  return validateConfig(JSON.parse(await Deno.readTextFile(PATHS.config)));
}

export function validateConfig(cfg: Config): Config {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("config must be an object");
  }
  if (cfg.hostinger && (typeof cfg.hostinger !== "object" || Array.isArray(cfg.hostinger))) {
    throw new Error("hostinger config must be an object");
  }
  if (cfg.slice !== undefined && cfg.slice !== "user.slice") {
    throw new Error("slice must be user.slice");
  }
  const id = cfg.hostinger?.vm_id;
  if (id !== undefined && id !== null && (!Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("hostinger.vm_id must be a positive integer");
  }
  plan(cfg.vcpus ?? 1, undefined, cfg.baseline_share);
  if (
    cfg.tick_seconds !== undefined &&
    (!Number.isFinite(cfg.tick_seconds) || cfg.tick_seconds < 1 || cfg.tick_seconds > 300)
  ) {
    throw new Error("tick_seconds must be from 1 to 300");
  }
  if (
    cfg.initial_balance !== undefined &&
    (!Number.isFinite(cfg.initial_balance) || cfg.initial_balance < 0)
  ) {
    throw new Error("initial_balance must be finite and nonnegative");
  }
  if (cfg.timezone !== undefined) new Intl.DateTimeFormat("en", { timeZone: cfg.timezone });
  return cfg;
}

async function writeJson(path: string, value: unknown, mode: number) {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(value));
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
}

export async function detectPlan(cfg: Config): Promise<Plan> {
  if (cfg.vcpus) return plan(cfg.vcpus, undefined, cfg.baseline_share);
  const h = cfg.hostinger;
  if (h?.vm_id) {
    try {
      const v = await vm(h, h.vm_id);
      if (v.cpus) return plan(v.cpus, v.plan ?? `KVM ${v.cpus}`, cfg.baseline_share);
    } catch (e) {
      log("plan from Hostinger's API failed, counting vCPUs:", e);
    }
  }
  return plan(await vcpusSeen(), undefined, cfg.baseline_share);
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

export type GovernorIO = {
  clock: () => Promise<Clock>;
  counters: typeof readCounters;
  usage: typeof userUsage;
  cap: typeof capSlice;
  ceiling: typeof ceilingNow;
  readings: typeof cpuReadings;
  hooks: typeof runHooks;
  snapshot: typeof topSnapshot;
  requestInfo: (
    path: string,
  ) => Promise<Pick<Deno.FileInfo, "uid" | "isFile" | "isSymlink" | "mode" | "size">>;
  requestBody: typeof Deno.readTextFile;
  pause: typeof sleep;
  steal: typeof stealShare;
  demand: typeof demandSample;
  burner: () => Pick<Deno.ChildProcess, "status" | "kill">;
};

export class Governor {
  s: Private;
  readonly io: GovernorIO;
  comparison: number | null = null;
  constructor(
    readonly cfg: Config,
    readonly plan: Plan,
    saved?: Private,
    io: Partial<GovernorIO> = {},
  ) {
    validateConfig(cfg);
    this.io = {
      clock: readClock,
      counters: readCounters,
      usage: userUsage,
      cap: capSlice,
      ceiling: ceilingNow,
      readings: cpuReadings,
      hooks: runHooks,
      snapshot: topSnapshot,
      requestInfo: Deno.lstat,
      requestBody: Deno.readTextFile,
      pause: sleep,
      steal: stealShare,
      demand: demandSample,
      burner: () =>
        new Deno.Command("timeout", {
          args: ["35", "sh", "-c", "while :; do :; done"],
          stdout: "null",
          stderr: "null",
        }).spawn(),
      ...io,
    };
    const planKey = `${plan.vcpus}:${plan.baseline}:${plan.capacity}`;
    this.s = saved && saved.schema === 2 && saved.planKey === planKey ? structuredClone(saved) : {
      balance: Math.min(cfg.initial_balance ?? 0, plan.capacity),
      at: Date.now(),
      margin: { ...MARGIN },
      used: 0,
      probe: { cooldownUntil: 0, backoffMs: BACKOFF_MS },
      samples: [],
      readings: [],
      capFailed: true,
    };
    this.s.schema = 2;
    this.s.planKey = planKey;
  }
  get slice() {
    return "user.slice";
  }

  recent(window: number) {
    return this.s.samples.filter((x) =>
      x.uptime !== undefined && (this.s.uptime ?? 0) - x.uptime <= window
    );
  }

  publicState(now: number): PublicState {
    const s = this.s;
    const p = this.plan;
    const recent = this.recent(STEAL_WINDOW_MS);
    const half = this.recent(CPU_WINDOW_MS);
    const users30: Record<string, number> = {};
    for (const x of half) {
      for (const [who, v] of Object.entries(x.users ?? {})) {
        users30[who] = (users30[who] ?? 0) + v / half.length;
      }
    }
    const busy5 = avg(recent.map((x) => x.busy));
    const delta = p.baseline - charged(busy5 * p.vcpus, s.margin);
    const pressing = s.limit &&
      demandSteal(busy5, avg(recent.map((x) => x.steal))) >= LIMIT_PRESSING;
    return {
      updatedAt: now,
      bootId: s.bootId ?? null,
      uptime: s.uptime ?? null,
      plan: p,
      slice: this.slice,
      timezone: this.cfg.timezone ?? "UTC",
      credits: {
        balance: Math.round(s.balance),
        percent: Math.round((100 * s.balance) / p.capacity),
        minutesAtFull: Math.round(s.balance / (p.vcpus - p.baseline) / 60),
        rate: Math.round(
          (pressing || s.noEarn || s.earning === false
            ? -charged(busy5 * p.vcpus, s.margin)
            : delta) * 10,
        ) / 10,
        margin: s.margin,
        anchor: s.anchor
          ? {
            checkedAt: s.anchor.checkedAt,
            exact: false,
            applied: false,
            difference: this.comparison,
          }
          : null,
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
      accepting: !s.limit && !s.capFailed,
      coverage: {
        outsideCores: avg(recent.map((x) => x.outside ?? x.busy * p.vcpus)),
        recoveryBlocked: !!s.limit &&
          avg(recent.map((x) => x.outside ?? x.busy * p.vcpus)) >= p.limit - 0.2,
      },
    };
  }

  enterLimit(now: number, learn: boolean) {
    const s = this.s;
    if (learn) s.margin = widen(s.margin, s.balance, s.used);
    s.balance = 0;
    s.used = 0;
    s.earning = false;
    // Under the limit with what runs outside the slice on top.
    const outside = avg(
      this.recent(STEAL_WINDOW_MS).map((x) => x.outside ?? x.busy * this.plan.vcpus),
    );
    const ceiling = recoveryCeiling(this.plan, outside);
    s.limit = { since: now, ceiling, heldFrom: s.uptime ?? 0, startedAt: s.uptime ?? 0 };
  }

  async request(path: string, now: number) {
    const info = await this.io.requestInfo(path);
    if (
      !info.isFile || info.isSymlink || info.uid !== 0 || info.mode === null ||
      (info.mode & 0o022) !== 0 || info.size > 4096
    ) {
      throw new Error(
        "administrative requests must be root-owned regular files without group/world write access",
      );
    }
    const r = JSON.parse(await this.io.requestBody(path)) as { action?: string; balance?: number };
    if (r.action === "limit-on") this.enterLimit(now, false);
    else if (r.action === "limit-off") {
      this.s.limit = undefined;
      // Hostinger lifts a limit at the recovery point; the next anchor corrects this.
      this.s.balance = Math.max(this.s.balance, this.plan.recovered);
      this.s.used = 0;
    } else if (r.action === "seed" && typeof r.balance === "number" && Number.isFinite(r.balance)) {
      this.s.balance = Math.min(Math.max(0, r.balance), this.plan.capacity);
      this.s.used = 0;
    } else return log("unknown request:", JSON.stringify(r));
    log("request:", JSON.stringify(r));
  }

  async anchorNow(now: number) {
    const h = this.cfg.hostinger;
    if (!h?.vm_id) return;
    const readings = await this.io.readings(
      h,
      h.vm_id,
      Math.max(now - READINGS_KEEP_MS, RULES_SINCE),
      now,
    );
    if (!readings.length) return;
    this.s.readings = readings;
    const r = replay(this.plan, readings);
    if (!r) return;
    this.comparison = compareReadings(readings, this.s.samples);
    if (this.comparison !== null && Math.abs(this.comparison) > 5) {
      log(
        `API CPU differs from guest by ${
          this.comparison.toFixed(1)
        } percentage points; history remains diagnostic`,
      );
    }
    this.s.anchor = { ...r, exact: false, checkedAt: now };
  }

  // Demand under the limit for 20 seconds, then back: a limit's steal follows demand.
  async probe(sf0: number, ceiling: number): Promise<boolean> {
    this.s.noEarn = true;
    if (!await this.io.cap(this.slice, 20)) return false;
    let sfCut: number;
    let restored = false;
    try {
      await this.io.pause(5_000);
      sfCut = await this.io.steal(15_000);
    } finally {
      restored = await this.io.cap(this.slice, ceiling);
      this.s.capFailed = !restored;
    }
    if (!restored) throw new Error("failed to restore probe ceiling");
    await this.io.pause(5_000);
    const sfRestore = await this.io.steal(15_000);
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
    const burn: Pick<Deno.ChildProcess, "status" | "kill">[] = [];
    this.s.noEarn = true;
    try {
      for (let i = 0; i < n; i++) {
        burn.push(this.io.burner());
      }
      await this.io.pause(5_000);
      const sample = await this.io.demand(25_000);
      const statuses = await Promise.all(burn.map((c) => c.status));
      return statuses.every((s) => s.code === 124) &&
        liftConfirmed(this.plan, n, sample.busy * this.plan.vcpus, sample.steal);
    } finally {
      for (const c of burn) {
        try {
          c.kill();
        } catch { /* Already exited. */ }
      }
      await Promise.all(burn.map((c) => c.status));
    }
  }

  async tick(clock?: Clock) {
    const { at: now, uptime, bootId } = clock ?? await this.io.clock();
    const s = this.s;
    const p = this.plan;
    const counters = await this.io.counters();
    const prev = s.cpuPrev;
    const before = s.uptime;
    const beforeAt = s.at;
    const oldUsage = s.usagePrev;
    const usage = await this.io.usage(this.slice, uptime).catch(() => undefined);
    const reset = s.bootId !== bootId || before === undefined || uptime <= before || !prev ||
      counters.total <= prev.total || counters.busy < prev.busy || counters.steal < prev.steal;
    if (reset) {
      if (s.bootId !== undefined || prev) s.balance = 0;
      s.used = 0;
      s.noEarn = false;
      s.earning = false;
      s.anchor = undefined;
      this.comparison = null;
      s.samples = [];
      s.probe = { cooldownUntil: 0, backoffMs: BACKOFF_MS };
      s.anchorNext = 0;
      s.anchorBackoff = 60_000;
      s.topAt = undefined;
      if (s.limit) {
        s.limit.heldFrom = uptime;
        s.limit.startedAt = uptime;
        s.limit.testAt = 0;
      }
    }
    s.cpuPrev = counters;
    s.bootId = bootId;
    s.uptime = uptime;
    s.at = now;
    const users = !reset && usage && oldUsage ? shares(oldUsage, usage, p.vcpus) : undefined;
    s.usagePrev = undefined;
    if (usage) s.usagePrev = usage;
    if (reset) {
      const target = s.limit?.ceiling ?? sliceCeiling(p, allowedCores(p, s.balance, s.margin), 0.4);
      s.capFailed = true;
      if (!await this.io.cap(this.slice, target)) throw new Error("startup ceiling not set");
      s.capFailed = false;
      s.ceiling = target;
      return;
    }
    const seconds = (uptime - before) / 1000;
    const total = counters.total - prev.total;
    const managed =
      usage?.total !== undefined && oldUsage?.total !== undefined && usage.total >= oldUsage.total
        ? (usage.total - oldUsage.total) / (seconds * 1_000_000)
        : 0;
    const sample: Sample = {
      at: now,
      busy: (counters.busy - prev.busy) / total,
      steal: (counters.steal - prev.steal) / total,
      users,
      uptime,
      seconds,
      outside: Math.max(0, (counters.busy - prev.busy) / total * p.vcpus - managed),
      clockValid: Math.abs((now - beforeAt) / 1000 - seconds) <= 2,
    };
    s.samples = [...s.samples, sample].filter((x) => uptime - (x.uptime ?? -Infinity) <= KEEP_MS);
    if (
      (sample.busy >= HOT_BUSY || sample.steal >= HOT_STEAL) &&
      uptime - (s.topAt ?? -Infinity) >= TOP_EVERY_MS
    ) {
      s.topAt = uptime;
      await this.io.snapshot(`${PATHS.lib}/top`, now).catch((e) => log("top snapshot failed:", e));
    }

    const busyCores = sample.busy * p.vcpus;
    const observed = seconds <= 2 * (this.cfg.tick_seconds ?? 30);
    const earning = observed && !s.noEarn &&
      !(s.limit && demandSteal(sample.busy, sample.steal) >= LIMIT_PRESSING);
    s.earning = earning;
    s.balance = creditStep(p, s.balance, busyCores, seconds, s.margin, earning);
    s.noEarn = false;
    s.used += charged(busyCores, s.margin) * seconds;
    s.at = now;
    if (!s.limit && uptime >= (s.anchorNext ?? 0)) {
      s.anchorNext = uptime + ANCHOR_EVERY_MS;
      try {
        await this.anchorNow(now);
        s.anchorBackoff = 60_000;
      } catch (e) {
        s.anchorNext = uptime + (s.anchorBackoff ?? 60_000);
        s.anchorBackoff = Math.min((s.anchorBackoff ?? 60_000) * 2, ANCHOR_EVERY_MS);
        log("anchor failed:", e);
      }
    }

    const recent = this.recent(STEAL_WINDOW_MS);
    const steal = recent.length >= 3 ? avg(recent.map((x) => x.steal)) : 0;
    const busy = avg(recent.map((x) => x.busy));
    const outside = Math.max(sample.outside ?? 0, avg(recent.map((x) => x.outside ?? 0)));
    const current = await this.io.ceiling(this.slice);

    if (
      !s.limit && recent.length >= 3 && demandSteal(busy, steal) >= LIMIT_STEAL &&
      steal * p.vcpus >= 0.02 && uptime >= s.probe.cooldownUntil
    ) {
      const sf0 = demandSteal(busy, steal);
      if (sf0 >= LIMIT_EVIDENT || await this.probe(sf0, current ?? 100 * p.vcpus)) {
        this.enterLimit(now, true);
        s.probe.backoffMs = BACKOFF_MS;
        log(`limit: start (margin x${s.margin.mul} +${s.margin.add})`);
        await this.io.hooks("limit-start", this.publicState(now));
      } else {
        s.probe.cooldownUntil = uptime + s.probe.backoffMs;
        s.probe.backoffMs = Math.min(s.probe.backoffMs * 2, BACKOFF_MAX_MS);
      }
    }

    const limit = s.limit;
    if (limit) {
      limit.ceiling = Math.min(limit.ceiling, recoveryCeiling(p, outside));
      if (
        demandSteal(sample.busy, sample.steal) >= LIMIT_PRESSING &&
        uptime - limit.heldFrom >= TIGHTEN_AFTER_MS
      ) {
        const managedDemand = Math.max(0, (sample.busy + sample.steal) * p.vcpus - outside);
        const tightened = tightenCeiling(limit.ceiling, managedDemand);
        if (tightened !== limit.ceiling) log(`limit: still pressing on it; ceiling ${tightened}%`);
        limit.ceiling = tightened;
        limit.heldFrom = uptime;
      }
      // Neighbour steal can keep the conservative mirror flat even while the host earns. Once an
      // idle recovery could have completed, test the host independently of the estimate.
      const recoveryElapsed =
        uptime - (limit.startedAt ?? limit.heldFrom) >= p.recovered / p.baseline * 1000;
      if ((s.balance >= p.recovered || recoveryElapsed) && uptime >= (limit.testAt ?? 0)) {
        if (await this.limitGone()) {
          s.limit = undefined;
          log("limit: lifted");
          await this.io.hooks("limit-end", this.publicState(now));
        } else limit.testAt = uptime + TEST_EVERY_MS;
      }
    }

    const target = s.limit
      ? s.limit.ceiling
      : sliceCeiling(p, allowedCores(p, s.balance, s.margin, LAW), outside);
    s.capFailed = target !== current;
    if (target === current) s.ceiling = target;
    else if (await this.io.cap(this.slice, target)) {
      s.capFailed = false;
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
      await g.tick();
      await g.save(now);
    } catch (e) {
      log("tick failed:", e);
      await g.save(Date.now()).catch(() => {});
    }
    for (let waited = 0; waited < tickMs && !stopping; waited += 1000) await sleep(1000);
  }
  await g.save(Date.now()).catch(() => {});
}

// A fixed recovery quota also survives a wrong baseline or an already active host limit. Outside
// services still need to be moved under user.slice; no slice quota can constrain unrelated cgroups.
export async function fallback() {
  const ceiling = 20;
  const out = await new Deno.Command("systemctl", {
    args: ["set-property", "--runtime", "user.slice", `CPUQuota=${ceiling}%`],
  }).output();
  log(`fallback ceiling ${ceiling}%`, out.success ? "set" : "failed");
}
