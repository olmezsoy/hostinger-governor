// The control loop. Each pass counts the CPU the guest used, updates the credit estimate
// (src/estimate.ts), sets the slice's ceiling from it (src/credits.ts), and watches for a credit
// limit. Accounting uses kernel uptime and boot identity. Root owns administrative requests;
// consumers read public state.
import {
  allowedCores,
  canProbeSlice,
  demandSteal,
  evidentSteal,
  LAW,
  LIFT_STEAL,
  liftConfirmed,
  LIMIT_EVIDENT,
  LIMIT_STEAL,
  limitConfirmed,
  limitPressing,
  type Margin,
  pinnedAtCap,
  PROBE_CEILING,
  quietAfterLiftSeconds,
  type Reading,
  recoveryCeiling,
  sliceCeiling,
  sliceDemand,
  tightenCeiling,
  validSpacing,
} from "./credits.ts";
import {
  BILLING_GAP_MAX,
  billingGap,
  ESTIMATE,
  type Estimate,
  learnedPad,
  margin,
  mostAdded,
  ownCharge,
  type Sample,
  settle,
  stale,
  step,
  tail,
} from "./estimate.ts";
import { cpuReadings, type HostingerSource, validateSource, validReading } from "./hostinger.ts";
import { MAX_VCPUS, type Plan, plan, RULES_SINCE } from "./plans.ts";
import { DEFAULT_FALLBACK_CPU_PERCENT, fallbackCpuPercent } from "./fallback.ts";
import { HOOK_TIMEOUT_SECONDS, HookRunner, validateHookTimeout } from "./hooks.ts";
import { DiagnosticsRunner } from "./diagnostics.ts";
import { parentDirectory, writeJson } from "./storage.ts";
import { controlLoop } from "./control.ts";
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
export type { Sample } from "./estimate.ts";

export const PATHS = {
  config: Deno.env.get("GOVERNOR_CONFIG") ?? "/etc/governor/config.json",
  hooks: "/etc/governor/hooks.d",
  run: "/run/governor",
  lib: "/var/lib/governor",
  cap: "/usr/local/libexec/governor-cap",
};
export const STATE_FILE = `${PATHS.run}/state.json`;
export const REQUESTS = `${PATHS.run}/requests`;
export const TICK_SOCKET = `${PATHS.run}/tick.sock`;

export type Config = {
  hostinger?: HostingerSource & { vm_id?: number };
  // The slice whose ceiling the governor sets; every login runs under user.slice.
  slice?: string;
  timezone?: string;
  initial_balance?: number;
  tick_seconds?: number;
  // Overrides the kernel's vCPU count for local plan sizing.
  vcpus?: number;
  baseline_share?: number;
  // Percent of one vCPU, only while the daemon is starting/stopped/failed.
  fallback_cpu_percent?: number;
  hook_timeout_seconds?: number;
  // Settings of releases before v1.0.0. Accepted so those configurations still load; not used.
  calibration?: unknown;
  readings?: unknown;
  recovery?: unknown;
};
const LEGACY_SETTINGS = ["calibration", "readings", "recovery"] as const;

export type Limit = {
  since: number;
  ceiling: number;
  // Lowest ceiling applied because the VM actually pressed on the limit; separate from transient
  // `outside` spikes so recovery ceilings relax back up once outside load subsides.
  tightenedCeiling?: number;
  heldFrom: number;
  startedAt?: number;
  testAt?: number;
  testEvery?: number;
  // The estimate the limit found, and whether the limit may teach: one an operator declared, or
  // whose entry a reboot or a seed separated from its lift, may not.
  entry?: { balance: number; learn: boolean };
  // What the first lift test that failed found. True: the VM held at the plan's limit with
  // steal, which is Hostinger's credit limit. False: something else held it, such as a
  // sustained-use limit, whose cap starts higher however low it falls later. Unset until a test
  // fails.
  confirmed?: boolean;
  recovery?: { seconds: number; earningSeconds: number; charged: number };
  // Uptime of the last test that still found the limit.
  limitedUptime?: number;
};

type Rebuilding = {
  reason: "first-start" | "state-upgrade" | "plan-change" | "reboot" | "counter-reset";
  since: number;
};

// persist.json: the daemon's working state.
export type Private = {
  schema: 3;
  planKey: string;
  bootId?: string;
  uptime?: number;
  at: number;
  // The credit estimate, in core-seconds, and what it stands on.
  balance: number;
  estimate: Estimate;
  // Hostinger's settled readings, and when they were last fetched.
  readings: Reading[];
  fetchedAt?: number;
  // The VM the readings are from.
  vmId?: number | null;
  samples: Sample[];
  limit?: Limit;
  // quietUntil: uptime until which no credit limit can follow the last credit lift.
  probe: { cooldownUntil: number; backoffMs: number; failedSf?: number; quietUntil?: number };
  // The last confirmed limit that no plausible billing gap explained.
  suspectAt?: number;
  tested?: boolean;
  noEarn?: boolean;
  earning?: boolean;
  cpuPrev?: Counters;
  usagePrev?: UsageSnapshot;
  ceiling?: number;
  topAt?: number;
  capFailed?: boolean;
  rebuilding?: Rebuilding | null;
};
// The limit as consumers see it; internal evidence and timing stay private.
export type PublicLimit = Omit<Limit, "limitedUptime" | "tightenedCeiling">;

// What every consumer reads.
export type PublicState = {
  schemaVersion: 1;
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
    law?: { floor: number; spendS: number; refillS: number };
    // Since when no settled reading has arrived, while the estimate runs on the guest's own count
    // alone. Null while readings are fresh, or when none are configured.
    staleSince?: number | null;
    // Rebuilding a conservative reserve is not evidence of an empty Hostinger bank or a limit.
    rebuilding: Rebuilding | null;
    // `applied`: the estimate stands on Hostinger's readings.
    anchor:
      | { checkedAt: number; exact: boolean; applied: boolean; difference: number | null }
      | null;
  };
  ceiling: number;
  limit: PublicLimit | null;
  cpu: {
    busy5: number;
    steal5: number;
    busy30: number;
    users30: Record<string, number>;
    observedSeconds: number;
  };
  readings: Reading[];
  // False while Hostinger limits the machine: start nothing that can wait.
  accepting: boolean;
  // Explicit flag so status and report surface failed quota updates even during an active limit.
  capFailed?: boolean;
  coverage: { outsideCores: number; recoveryBlocked: boolean };
};

const STEAL_WINDOW_MS = 5 * 60_000;
const CPU_WINDOW_MS = 30 * 60_000;
// Samples outlast the slowest reading to settle, so the tail of the estimate is always counted.
const KEEP_MS = 3 * 3_600_000;
// The API serves 48 hours; public state keeps 72 so `governor report 72` has full history.
const FETCH_WINDOW_MS = 48 * 3_600_000;
const READINGS_KEEP_MS = 72 * 3_600_000;
// Outside a limit on 4+ vCPU plans, ignore 10% ceiling jitter to stop nonstop sudo/systemctl churn.
const CEILING_DEADBAND = 20;
const TEST_EVERY_MS = 2 * 60_000;
const TEST_MAX_MS = 15 * 60_000;
const TIGHTEN_AFTER_MS = 60_000;
const BACKOFF_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 3_600_000;
// How far back a limit's onset is looked for: twice the first cooldown.
const ONSET_MS = 2 * BACKOFF_MS;
const DAY_MS = 86_400_000;
const HOT_BUSY = 0.6;
const HOT_STEAL = 0.05;
const TOP_EVERY_MS = 5 * 60_000;
const DEFAULT_TICK_SECONDS = 30;
const MAX_MIN_SAMPLE_MS = 5000;
const DEFAULT_OUTSIDE_CORES = 0.4;
const QUARANTINE_KEPT = 3;
// A wall clock this far off uptime over one pass has stepped. Less is drift, which misplaces a
// sample by too little to matter against a half-hour reading.
const CLOCK_STEP_S = 60;

type Control = {
  busy: number;
  // Counted from three samples on: fewer say too little to test a limit on.
  steal: number;
  outside: number;
  avgOutside: number;
  // The most any sample of the window ran outside the slice: what a recovery ceiling must still
  // leave room for before it relaxes.
  maxOutside: number;
};

const log = (...parts: unknown[]) => console.log(parts.map(String).join(" "));
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const finite = (...xs: unknown[]) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const planKey = (p: Plan) => `${p.vcpus}:${p.baseline}:${p.capacity}`;

// Hostinger's readings less the guest's own busy CPU, in percentage points of the plan, over the
// reading intervals the samples cover in full. A diagnostic for the report.
export function compareReadings(readings: Reading[], samples: Sample[]): number | null {
  let error = 0, measured = 0;
  for (let i = 1; i < readings.length; i++) {
    const start = readings[i - 1].at, end = readings[i].at;
    if (!validSpacing(start, end)) continue;
    let observed = 0, guest = 0;
    for (const x of samples) {
      if (x.clockValid === false || x.unobserved) continue;
      const ms = Math.min(end, x.at) - Math.max(start, x.at - x.seconds * 1000);
      if (ms <= 0) continue;
      observed += ms;
      guest += ms * x.busy * 100;
    }
    if (observed < 0.9 * (end - start)) continue;
    error += readings[i].v * observed - guest;
    measured += observed;
  }
  return measured ? error / measured : null;
}
const publicLimit = (limit: Limit): PublicLimit => {
  const copy: Limit = { ...limit };
  delete copy.limitedUptime;
  delete copy.tightenedCeiling;
  return copy;
};
async function list(dir: string): Promise<Deno.DirEntry[]> {
  try {
    return await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
}

export async function loadConfig(): Promise<Config> {
  const cfg = validateConfig(JSON.parse(await Deno.readTextFile(PATHS.config)));
  fallbackCpuPercent(cfg, await vcpusSeen());
  return cfg;
}

// Every setting, so a misspelt key fails validation instead of leaving its default in force.
const SETTINGS: Record<string, string[]> = {
  "": [
    "hostinger",
    "slice",
    "timezone",
    "initial_balance",
    "tick_seconds",
    "vcpus",
    "baseline_share",
    "fallback_cpu_percent",
    "hook_timeout_seconds",
    ...LEGACY_SETTINGS,
  ],
  hostinger: ["vm_id", "token_file", "token_command", "request_command"],
};
export function validateConfig(cfg: Config): Config {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error("config must be an object");
  }
  if (cfg.hostinger && (typeof cfg.hostinger !== "object" || Array.isArray(cfg.hostinger))) {
    throw new Error("hostinger config must be an object");
  }
  for (const [block, keys] of Object.entries(SETTINGS)) {
    const value = block ? cfg[block as keyof Config] : cfg;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        throw new Error(`${block ? `${block}.` : ""}${key} is not a setting`);
      }
    }
  }
  if (cfg.slice !== undefined && cfg.slice !== "user.slice") {
    throw new Error("slice must be user.slice");
  }
  const id = cfg.hostinger?.vm_id;
  if (id !== undefined && id !== null && (!Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("hostinger.vm_id must be a positive integer");
  }
  if (cfg.hostinger) {
    validateSource(cfg.hostinger);
    if (cfg.hostinger.request_command && !id) {
      throw new Error("hostinger.request_command requires hostinger.vm_id");
    }
  }
  plan(cfg.vcpus ?? 1, undefined, cfg.baseline_share);
  fallbackCpuPercent(cfg, cfg.vcpus ?? MAX_VCPUS);
  if (cfg.hook_timeout_seconds !== undefined) validateHookTimeout(cfg.hook_timeout_seconds);
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
// The settings of earlier releases a configuration still carries.
export const legacySettings = (cfg: Config) =>
  LEGACY_SETTINGS.filter((key) => cfg[key] !== undefined);

export async function detectPlan(cfg: Config): Promise<Plan> {
  return plan(cfg.vcpus ?? await vcpusSeen(), undefined, cfg.baseline_share);
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

export type GovernorIO = {
  clock: () => Promise<Clock>;
  counters: typeof readCounters;
  usage: typeof userUsage;
  cap: typeof capSlice;
  ceiling: typeof ceilingNow;
  readings: typeof cpuReadings;
  hooks: (event: string, state: PublicState) => Promise<void>;
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

// State a release before v1.0.0 saved (persist.json, schema 2), as far as v1.0.0 reads it.
type Legacy = {
  schema?: number;
  planKey?: string;
  balance?: number;
  at?: number;
  bootId?: string;
  uptime?: number;
  limit?: {
    since?: number;
    ceiling?: number;
    heldFrom?: number;
    startedAt?: number;
    testAt?: number;
    testEvery?: number;
  };
  probe?: { cooldownUntil?: number; backoffMs?: number; failedSf?: number; quietUntil?: number };
  vmId?: number | null;
  margin?: { mul?: number; add?: number };
  readings?: Reading[];
  samples?: Partial<Sample>[];
  cpuPrev?: Counters;
  usagePrev?: UsageSnapshot;
  calibration?: { gap?: number; estimates?: { acted?: number } };
  evaluationFailed?: { behind?: number };
};

export class Governor {
  s: Private;
  readonly io: GovernorIO;
  comparison: number | null = null;
  // What the last burner test measured: the VM delivering what they asked, held at the plan's
  // limit, or held well above it. Unknown where it measured nothing, or nothing that clear.
  liftEvidence: "unknown" | "limited" | "lifted" | "held" = "unknown";
  private readonly hookRunner: HookRunner;
  private readonly fetcher?: DiagnosticsRunner;
  // Hook events wait until the pass has applied its quota.
  private events: string[] = [];
  // Readings arrived since the last pass.
  private fetched = false;
  // The first pass of this run.
  private startedAt?: number;
  // False when persist.json exists but this run couldn't read it: it stays for the next run.
  persistWritable = true;

  constructor(
    readonly cfg: Config,
    readonly plan: Plan,
    given?: Private | Legacy,
    io: Partial<GovernorIO> = {},
    readonly paths: Pick<typeof PATHS, "run" | "lib"> = PATHS,
  ) {
    validateConfig(cfg);
    fallbackCpuPercent(cfg, plan.vcpus);
    this.hookRunner = new HookRunner(PATHS.hooks, cfg.hook_timeout_seconds ?? HOOK_TIMEOUT_SECONDS);
    this.io = {
      clock: readClock,
      counters: readCounters,
      usage: userUsage,
      cap: capSlice,
      ceiling: ceilingNow,
      readings: cpuReadings,
      hooks: (event, state) => {
        this.hookRunner.enqueue(event, state);
        return Promise.resolve();
      },
      snapshot: topSnapshot,
      requestInfo: Deno.lstat,
      requestBody: Deno.readTextFile,
      pause: sleep,
      steal: stealShare,
      demand: demandSample,
      burner: () =>
        new Deno.Command("timeout", {
          args: ["32", "sh", "-c", "while :; do :; done"],
          stdout: "null",
          stderr: "null",
        }).spawn(),
      ...io,
    };
    // Saved state as persist.json holds it: a copy passed in memory keeps values JSON doesn't.
    this.s = this.restore(given && JSON.parse(JSON.stringify(given)));
    const vmId = cfg.hostinger?.vm_id ?? null;
    if (vmId !== null && (this.s.vmId ?? vmId) !== vmId) {
      // Readings are one VM's. Another VM's say nothing about this bank.
      log("saved readings are from another VM; starting the estimate over");
      this.s.readings = [];
      this.s.fetchedAt = undefined;
      this.s.estimate = this.freshEstimate(this.s.at);
      this.s.balance = 0;
      this.s.rebuilding = { reason: "state-upgrade", since: this.s.at };
    }
    this.s.vmId = vmId ?? this.s.vmId ?? null;
    const h = cfg.hostinger;
    if (h?.vm_id) {
      const id = h.vm_id;
      this.fetcher = new DiagnosticsRunner({
        readings: (at) =>
          this.io.readings(h, id, Math.max(at - FETCH_WINDOW_MS, RULES_SINCE), at, true),
        clock: () => this.io.clock(),
        publish: (readings, at) => this.publish(readings, at),
        log: (e) => log("readings fetch failed:", e),
      });
    }
    if (this.s.balance >= LAW.floor * plan.capacity) this.s.rebuilding = null;
  }

  private freshEstimate(now: number, balance?: number): Estimate {
    return {
      ...(balance === undefined ? {} : { anchor: { at: now, balance } }),
      pad: ESTIMATE.pad,
      excess: [],
      known: { at: now, slack: 0 },
    };
  }
  // The working state a start begins with: what was saved, what an earlier release saved, or new.
  private restore(saved?: Private | Legacy): Private {
    const p = this.plan, key = planKey(p), now = Date.now();
    const fresh = (
      balance: number,
      reason: Rebuilding["reason"],
      stated = false,
    ): Private => ({
      schema: 3,
      planKey: key,
      balance,
      at: now,
      estimate: this.freshEstimate(now, stated ? balance : undefined),
      readings: [],
      samples: [],
      probe: { cooldownUntil: 0, backoffMs: BACKOFF_MS },
      capFailed: true,
      rebuilding: { reason, since: now },
    });
    if (!saved) {
      // A first start. Zero, the installer's default, states nothing.
      const initial = Math.min(this.cfg.initial_balance ?? 0, p.capacity);
      return fresh(initial, "first-start", initial > 0);
    }
    if (saved.schema === 3 && saved.planKey === key && usable(saved as Private)) {
      const s = saved as Private;
      if (!(finite(s.probe?.backoffMs, s.probe?.cooldownUntil) && s.probe.backoffMs > 0)) {
        s.probe = { cooldownUntil: 0, backoffMs: BACKOFF_MS };
      }
      return s;
    }
    const old = saved as Legacy;
    const samePlan = old.planKey === key;
    const s = fresh(0, samePlan || old.planKey === undefined ? "state-upgrade" : "plan-change");
    // A limit in force stays in force until a lift test passes, no wider than the ceiling it
    // was held at: the upgrade must not reopen a slice that was pressing on the limit.
    if (old.limit && finite(old.limit.since)) {
      const held = finite(old.limit.ceiling) && old.limit.ceiling! >= 20
        ? Math.min(old.limit.ceiling!, 100 * p.vcpus)
        : 100 * p.vcpus;
      // Its clocks are in uptime. They hold if this is the same boot, and a new one resets them.
      const l = old.limit;
      s.limit = {
        since: l.since!,
        ceiling: Math.min(held, recoveryCeiling(p, DEFAULT_OUTSIDE_CORES)),
        tightenedCeiling: held,
        heldFrom: finite(l.heldFrom) ? l.heldFrom! : old.uptime ?? 0,
        startedAt: finite(l.startedAt) ? l.startedAt! : old.uptime ?? 0,
        ...(finite(l.testAt) ? { testAt: l.testAt } : {}),
        ...(finite(l.testEvery) ? { testEvery: l.testEvery } : {}),
      };
    }
    if (old.schema === 2 && samePlan && finite(old.balance, old.at)) {
      // v0.3's estimate was a lower bound, so it stands, and readings move it from here. Its
      // samples cover the time those readings have not settled yet. It is the lowest of the
      // estimates v0.3 kept: the open one, the one it acted on, and the open one less the hold
      // of a calibration that was failing.
      const acted = old.calibration?.estimates?.acted, behind = old.evaluationFailed?.behind;
      s.balance = Math.max(
        0,
        Math.min(
          old.balance! - (finite(behind) ? Math.max(0, behind!) : 0),
          finite(acted) ? acted! : Infinity,
          p.capacity,
        ),
      );
      s.at = old.at!;
      s.bootId = old.bootId;
      s.uptime = old.uptime;
      s.cpuPrev = old.cpuPrev;
      s.usagePrev = old.usagePrev;
      s.vmId = old.vmId;
      const probe = old.probe;
      if (probe && finite(probe.cooldownUntil, probe.backoffMs) && probe.backoffMs! > 0) {
        s.probe = {
          cooldownUntil: probe.cooldownUntil!,
          backoffMs: probe.backoffMs!,
          ...(finite(probe.failedSf) ? { failedSf: probe.failedSf } : {}),
          ...(finite(probe.quietUntil) ? { quietUntil: probe.quietUntil } : {}),
        };
      }
      s.readings = (old.readings ?? []).filter((r) => finite(r?.at, r?.v));
      s.samples = (old.samples ?? []).flatMap((x): Sample[] =>
        finite(x.at, x.seconds, x.busy, x.steal) && x.seconds! > 0
          ? [{
            at: x.at!,
            seconds: x.seconds!,
            uptime: x.uptime,
            busy: x.busy!,
            steal: x.steal!,
            outside: finite(x.outside) ? x.outside! : 0,
            test: !!x.test,
            limited: !!x.limited,
            clockValid: x.clockValid !== false,
            earning: !x.limited && !x.test && !x.unobserved,
            ...(x.unobserved ? { unobserved: true } : {}),
            ...(x.users && typeof x.users === "object" ? { users: x.users } : {}),
          }]
          : []
      );
      // What v0.3's limits taught: the billing gap of `apply`, or the margin `off` and `shadow`
      // widened from 1.05x + 0.08, taken at the baseline.
      const gap = old.calibration?.gap, m = old.margin;
      const widened = m && finite(m.mul, m.add)
        ? (m.mul! - 1.05) * p.baseline + (m.add! - 0.08)
        : 0;
      const taught = Math.max(finite(gap) ? gap! : 0, widened, 0);
      s.estimate.pad = Math.min(s.estimate.pad + taught, mostAdded(p));
      s.estimate.known = { at: s.at, slack: 0 };
      s.rebuilding = null;
      s.capFailed = true;
    }
    return s;
  }

  get slice() {
    return "user.slice";
  }

  recent(window: number) {
    return this.s.samples.filter((x) =>
      x.uptime !== undefined && (this.s.uptime ?? 0) - x.uptime <= window
    );
  }

  controlSamples(window: number) {
    return this.recent(window).filter((x) => !x.test);
  }

  // The window limit detection looks at: five minutes, or the three passes it needs if they
  // take longer.
  private get window() {
    return Math.max(STEAL_WINDOW_MS, 3000 * (this.cfg.tick_seconds ?? DEFAULT_TICK_SECONDS));
  }
  private control(): Control {
    const recent = this.controlSamples(this.window);
    const latest = this.recent(Infinity).at(-1);
    const avgOutside = recent.length
      ? avg(recent.map((x) => x.outside))
      : latest
      ? 0
      : DEFAULT_OUTSIDE_CORES;
    return {
      busy: avg(recent.map((x) => x.busy)),
      steal: recent.length >= 3 ? avg(recent.map((x) => x.steal)) : 0,
      // Assume the startup default only before anything is measured. A window holding only test
      // samples has no outside estimate; a default here would tighten recovery ceilings.
      outside: latest
        ? Math.max(latest.test ? 0 : latest.outside, avgOutside)
        : DEFAULT_OUTSIDE_CORES,
      avgOutside,
      maxOutside: recent.reduce((most, x) => Math.max(most, x.outside), 0),
    };
  }

  // No settled reading for two hours, or none configured: the own count runs alone.
  get stale() {
    return stale(this.s.readings, this.s.at);
  }
  get margin(): Margin {
    return margin(this.plan, this.s.estimate);
  }
  private targetCeiling(outside: number) {
    return this.s.limit?.ceiling ??
      sliceCeiling(this.plan, allowedCores(this.plan, this.s.balance, this.margin), outside);
  }
  // Move the anchor through newly settled readings and put the own count since on top. While a
  // limit lasts the bank is known without them: empty, then rising, so they wait for the lift.
  private resettle() {
    const s = this.s;
    // Nor do readings that end hours before this box's clock: either the feed stopped or the
    // clock is wrong, and the samples would be laid against the wrong readings.
    if (s.limit || this.stale) return;
    // The anchor never reaches further back than the samples that can stand beside readings.
    // Without one, or with one older than samples are kept, the estimate carries on from the
    // own count and readings move it from here.
    const a = s.estimate.anchor;
    if (!a || s.at - a.at > KEEP_MS) s.estimate.anchor = { at: s.at, balance: s.balance };
    if (settle(this.plan, s.estimate, s.readings, s.samples)) {
      s.balance = tail(this.plan, s.estimate.anchor!, s.samples, this.margin, s.at);
    }
  }

  publicState(now: number): PublicState {
    const s = this.s;
    const p = this.plan;
    const recent = this.recent(STEAL_WINDOW_MS);
    const half = this.recent(CPU_WINDOW_MS);
    const control = this.controlSamples(this.window);
    const outside = avg(control.map((x) => x.outside));
    const users30: Record<string, number> = {};
    for (const x of half) {
      for (const [who, v] of Object.entries(x.users ?? {})) {
        users30[who] = (users30[who] ?? 0) + v / half.length;
      }
    }
    // The five-minute figures. A sample counts for the seconds of it that fall inside those five
    // minutes, so neither a short extra pass nor one long sample over a stop tilts them.
    const from = (s.uptime ?? 0) - STEAL_WINDOW_MS;
    const mean5 = (f: (x: Sample) => number, none = 0) => {
      let seconds = 0, sum = 0;
      for (const x of recent) {
        const inside = Math.min(x.seconds, (x.uptime! - from) / 1000);
        seconds += inside;
        sum += f(x) * inside;
      }
      return seconds > 0 ? sum / seconds : none;
    };
    const busy5 = mean5((x) => x.busy), steal5 = mean5((x) => x.steal);
    const m = this.margin;
    // Charged sample by sample, as the estimate is: steal counts only where a sample says so.
    const charge = mean5((x) => ownCharge(p, x, m), m.add);
    // The last settled reading, or when this run began if a configured feed has given none.
    const since = s.readings.at(-1)?.at ?? this.startedAt ?? now;
    const pressing = s.limit &&
      limitPressing(p, avg(control.map((x) => x.busy)), avg(control.map((x) => x.steal)));
    return {
      schemaVersion: 1,
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
          (pressing || s.noEarn || s.earning === false ? -charge : p.baseline - charge) * 10,
        ) / 10,
        margin: { mul: m.mul, add: Math.round(m.add * 10_000) / 10_000 },
        law: LAW,
        staleSince: this.fetcher && now - since > ESTIMATE.staleMs ? since : null,
        rebuilding: s.balance < LAW.floor * p.capacity ? s.rebuilding ?? null : null,
        anchor: s.fetchedAt
          ? {
            checkedAt: s.fetchedAt,
            exact: false,
            applied: !!s.estimate.anchor && !this.stale && !s.limit,
            difference: this.comparison,
          }
          : null,
      },
      ceiling: s.ceiling ?? 0,
      limit: s.limit ? publicLimit(s.limit) : null,
      cpu: {
        busy5,
        steal5,
        busy30: avg(half.map((x) => x.busy)),
        users30,
        observedSeconds: half.reduce((sum, x) => sum + x.seconds, 0),
      },
      readings: s.readings,
      accepting: !s.limit && !s.capFailed,
      capFailed: !!s.capFailed,
      coverage: {
        outsideCores: outside,
        recoveryBlocked: !!s.limit && outside >= p.limit - 0.2,
      },
    };
  }

  private notify(event: string) {
    this.events.push(event);
  }
  private dispatchEvents(now: number) {
    const events = this.events;
    this.events = [];
    for (const event of events) {
      try {
        void this.io.hooks(event, structuredClone(this.publicState(now))).catch(() => {
          log(`hooks (${event}): dispatch failed`);
        });
      } catch {
        log(`hooks (${event}): dispatch failed`);
      }
    }
  }

  closeHooks() {
    return this.hookRunner.close();
  }

  closeDiagnostics() {
    return this.fetcher?.close() ?? Promise.resolve();
  }

  // The bank is empty: that is what a credit limit means. What the estimate showed is kept, to
  // measure how far off it was.
  enterLimit(now: number, learn: boolean) {
    const s = this.s;
    // The estimate rises under a limit nobody has recognised yet, so what it reads now is not
    // what the limit found. The lowest it read in the 20 minutes before is.
    const found = Math.min(
      s.balance,
      ...this.recent(ONSET_MS).map((x) => x.balance ?? Infinity),
    );
    // Under the limit with what runs outside the slice on top.
    const outside = avg(this.controlSamples(this.window).map((x) => x.outside));
    s.limit = {
      since: now,
      ceiling: recoveryCeiling(this.plan, outside),
      tightenedCeiling: 100 * this.plan.vcpus,
      heldFrom: s.uptime ?? 0,
      startedAt: s.uptime ?? 0,
      entry: { balance: found, learn },
      recovery: { seconds: 0, earningSeconds: 0, charged: 0 },
    };
    s.balance = 0;
    s.earning = false;
    return s.limit;
  }

  // A limit is over. One whose first failed lift test found the VM held at the plan's limit was a
  // credit limit: the bank was empty. If the estimate still showed credits, billing ran above it.
  private lift(limit: Limit, now: number, finished: Clock) {
    const s = this.s, p = this.plan, e = s.estimate;
    const entry = limit.entry?.balance ?? 0;
    const credit = limit.confirmed === true;
    const gap = billingGap(entry, e.known.slack, (limit.since - e.known.at) / 1000);
    // More than a fifth of a core is not a billing gap: something else emptied the bank, such as
    // readings that went missing. It teaches only when another follows within a day, which shows
    // the rules themselves are off.
    const repeat = now - (s.suspectAt ?? -Infinity) <= DAY_MS;
    if (credit && gap > BILLING_GAP_MAX) s.suspectAt = now;
    // A limit that found the estimate already empty was no surprise, as when work outside the
    // slice spends the bank: the gap is zero and nothing is learned.
    const from = e.pad;
    if (
      credit && limit.entry?.learn && Number.isFinite(gap) &&
      (gap <= BILLING_GAP_MAX || repeat) && learnedPad(p, from, gap) > from
    ) {
      e.pad = learnedPad(p, from, gap);
      log(
        "calibration:",
        JSON.stringify({ at: now, trigger: "credit-limit", gap, pad: { from, to: e.pad } }),
      );
      this.notify("calibration");
    }
    const done = Math.max(s.uptime ?? 0, finished.uptime);
    // How long the recovery took against what the configured baseline predicts: evidence about
    // Hostinger's real baseline, which the guest cannot read anywhere.
    const recovery = limit.recovery;
    const net = recovery?.seconds
      ? (p.baseline * recovery.earningSeconds - recovery.charged) / recovery.seconds
      : 0;
    log(
      "recovery observation:",
      JSON.stringify({
        elapsedSeconds: Math.round((done - (limit.startedAt ?? done)) / 1000),
        idleMinimumSeconds: Math.round(p.recovered / p.baseline),
        estimatedRecoverySeconds: net > 0 ? Math.round(p.recovered / net) : null,
        estimatedPausedSeconds: recovery
          ? Math.round(recovery.seconds - recovery.earningSeconds)
          : null,
        baselineShare: p.baseline / p.vcpus,
        confirmed: credit,
      }),
    );
    // The estimate carries on from what the own count rebuilt since the limit began, when the
    // bank held nothing or more. Nothing from before the limit comes back. What the limit found
    // may have been spent while it lasted. And the anchor, replayed through a limit that work
    // pressed on, would earn what the bank did not.
    e.anchor = { at: Math.max(now, finished.at), balance: s.balance };
    // Hostinger lifts a credit limit at 20%, so the bank held that much at some point since.
    e.known = { at: now, slack: credit ? p.recovered - s.balance : 0 };
    // Right after a credit lift no credit limit can come yet.
    if (credit) {
      s.probe.quietUntil = (limit.limitedUptime ?? done) +
        quietAfterLiftSeconds(p, this.margin) * 1000;
    }
    s.limit = undefined;
    log("limit: lifted");
    this.notify("limit-end");
  }

  // Passes closer together than this reuse the last full pass's measurements.
  private get minSampleMs() {
    return Math.min(MAX_MIN_SAMPLE_MS, (this.cfg.tick_seconds ?? DEFAULT_TICK_SECONDS) * 1000 / 2);
  }
  private soonAfterLastPass({ uptime, bootId }: Clock) {
    const before = this.s.uptime;
    return this.s.bootId === bootId && before !== undefined && uptime >= before &&
      uptime - before < this.minSampleMs;
  }

  // The bank an operator states: the estimate stands on it until readings settle past it.
  private state(balance: number, now: number) {
    this.s.balance = balance;
    this.s.estimate.anchor = { at: now, balance };
    this.s.estimate.known = { at: now, slack: 0 };
    if (balance >= LAW.floor * this.plan.capacity) this.s.rebuilding = null;
  }
  async request(path: string, clock: Clock) {
    const now = clock.at;
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
    if (r.action === "calibration-reset") {
      // What limits and readings taught goes back to its start; the estimate stays.
      this.s.estimate.pad = ESTIMATE.pad;
      this.s.estimate.excess = [];
      this.s.suspectAt = undefined;
    } else if (r.action === "limit-on") {
      if (this.s.limit) log("limit: already limited");
      else this.enterLimit(now, false);
    } else if (r.action === "limit-off") {
      this.s.limit = undefined;
      // Root explicitly confirms that Hostinger lifted the limit at its recovery point.
      this.state(Math.max(this.s.balance, this.plan.recovered), now);
    } else if (r.action === "seed" && typeof r.balance === "number" && Number.isFinite(r.balance)) {
      this.state(Math.min(Math.max(0, r.balance), this.plan.capacity), now);
      // The estimate the limit found is gone, and with it what the limit could teach.
      if (this.s.limit?.entry) this.s.limit.entry.learn = false;
    } else return log("unknown request:", JSON.stringify(r));
    log("request:", JSON.stringify(r));
  }

  // Readings as a fetch returned them. The newest is not settled: Hostinger may still revise it.
  private publish(readings: Reading[], now: number) {
    if (readings.some((r) => !validReading(r, now))) {
      return log("readings fetch failed: invalid CPU metric reading");
    }
    const settled = [...readings].sort((a, b) => a.at - b.at).slice(0, -1);
    const merged = new Map([...this.s.readings, ...settled].map((r) => [r.at, r]));
    this.s.readings = [...merged.values()].filter((r) => r.at >= now - READINGS_KEEP_MS)
      .sort((a, b) => a.at - b.at);
    this.s.fetchedAt = now;
    this.comparison = compareReadings(this.s.readings, this.s.samples);
    this.fetched = true;
  }

  // Demand under the limit for 20 seconds, then back: a limit's steal follows demand.
  async probe(sf0: number, ceiling: number): Promise<boolean> {
    this.s.noEarn = true;
    this.s.tested = true;
    if (!await this.io.cap(this.slice, PROBE_CEILING)) return false;
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
    const passed = limitConfirmed(sf0, sfCut, sfRestore);
    log(
      `limit test: steal ${Math.round(sf0 * 100)}% of demand, ${Math.round(sfCut * 100)}% cut, ${
        Math.round(sfRestore * 100)
      }% restored, ${passed ? "passed" : "failed"}`,
    );
    return passed;
  }

  // More cores than the limit allows, busy for 30 seconds: under it much of that is stolen.
  async limitGone(): Promise<boolean> {
    this.liftEvidence = "unknown";
    const n = Math.min(this.plan.vcpus, Math.ceil(this.plan.limit) + 2);
    const burn: Pick<Deno.ChildProcess, "status" | "kill">[] = [];
    this.s.noEarn = true;
    this.s.tested = true;
    try {
      for (let i = 0; i < n; i++) burn.push(this.io.burner());
      await this.io.pause(5_000);
      const sample = await this.io.demand(25_000);
      const statuses = await Promise.all(burn.map((c) => c.status));
      if (!statuses.every((s) => s.code === 124)) {
        log("burner test: a burner stopped early, no result");
        return false;
      }
      const busyCores = sample.busy * this.plan.vcpus;
      const gone = liftConfirmed(this.plan, n, busyCores);
      this.liftEvidence = gone
        ? "lifted"
        : busyCores <= this.plan.limit + 0.1 && sample.steal >= LIFT_STEAL
        ? "limited"
        : busyCores > this.plan.limit + 0.3
        ? "held"
        : "unknown";
      log(
        `burner test: ${n} burners, ${busyCores.toFixed(2)} cores busy, steal ${
          Math.round(sample.steal * 100)
        }% of demand: ${this.liftEvidence}`,
      );
      return gone;
    } finally {
      for (const c of burn) {
        try {
          c.kill();
        } catch { /* Already exited. */ }
      }
      await Promise.all(burn.map((c) => c.status));
    }
  }

  // Ask the host with burners before entering a limit that steal alone does not make evident,
  // and return when they finished if they found the VM held at the plan's limit. Anything else
  // starts no limit: neighbours near the cap, a probe that scored noise, or a test that
  // measured nothing. The next check is ten minutes away.
  private async heldAtLimit(): Promise<Clock | null> {
    try {
      await this.limitGone();
    } catch (e) {
      this.liftEvidence = "unknown";
      log("cap test inconclusive:", e);
    }
    return this.liftEvidence === "limited" ? await this.io.clock() : null;
  }

  async tick(clock?: Clock) {
    const read = clock ?? await this.io.clock();
    const { at: now, uptime, bootId } = read;
    const s = this.s;
    const p = this.plan;
    this.startedAt ??= now;
    const counters = await this.io.counters();
    const prev = s.cpuPrev;
    const before = s.uptime;
    const beforeAt = s.at;
    const oldUsage = s.usagePrev;
    const usage = await this.io.usage(this.slice, uptime).catch(() => undefined);
    const reset = s.bootId !== bootId || before === undefined || uptime < before || !prev ||
      counters.total < prev.total || counters.busy < prev.busy || counters.steal < prev.steal;
    // Equal counters mean under a jiffy since the last pass, which the clock already shows.
    if (!reset && (this.soonAfterLastPass(read) || counters.total === prev.total)) {
      // A closely spaced pass reuses the last full pass's measurements and keeps every accounting
      // baseline, so the next sample covers the whole interval, these passes' CPU included. A
      // request it took still reaches the ceiling.
      await this.applyCeiling(await this.io.ceiling(this.slice), this.control());
      this.dispatchEvents(now);
      return;
    }
    s.cpuPrev = counters;
    s.usagePrev = usage;
    if (reset) {
      await this.restart(read, s.bootId !== undefined || !!prev);
      return;
    }
    s.bootId = bootId;
    s.uptime = uptime;
    s.at = now;
    const seconds = (uptime - before) / 1000;
    const total = counters.total - prev.total;
    const busy = (counters.busy - prev.busy) / total;
    const steal = (counters.steal - prev.steal) / total;
    const managed =
      usage?.total !== undefined && oldUsage?.total !== undefined && usage.total >= oldUsage.total
        ? (usage.total - oldUsage.total) / (seconds * 1_000_000)
        : 0;
    const tested = !!s.tested;
    // The wall clock jumped against uptime. Readings carry Hostinger's clock, so no sample from
    // before the jump, or across it, can be laid beside one any more.
    const stepped = Math.abs((now - beforeAt) / 1000 - seconds) > CLOCK_STEP_S;
    if (stepped) this.clockStepped(now);
    // Longer than two passes: the daemon was stopped, so the sample only knows the average. A
    // pass that probed and asked the burners runs up to 80 seconds longer, which the daemon
    // watched.
    const unobserved = seconds >
      2 * (this.cfg.tick_seconds ?? DEFAULT_TICK_SECONDS) + (tested ? 90 : 0);
    const pressing = !!s.limit && limitPressing(p, busy, steal);
    const sample: Sample = {
      at: now,
      seconds,
      uptime,
      busy,
      steal,
      outside: Math.max(0, busy * p.vcpus - managed),
      ...(usage && oldUsage ? { users: shares(oldUsage, usage, p.vcpus) } : {}),
      ...(tested ? { test: true } : {}),
      ...(s.limit ? { limited: true } : {}),
      ...(stepped ? { clockValid: false } : {}),
      earning: !unobserved && !s.noEarn && !pressing,
      ...(unobserved ? { unobserved: true } : {}),
    };
    s.tested = false;
    s.noEarn = false;
    s.earning = sample.earning;
    // Kept by uptime, which no clock step moves. Samples from before a reboot have none, and go
    // by the wall clock once no reading can still cover them.
    s.samples = [...s.samples, sample].filter((x) =>
      x.uptime === undefined ? Math.abs(now - x.at) <= KEEP_MS : uptime - x.uptime <= KEEP_MS
    );
    if (
      (busy >= HOT_BUSY || steal >= HOT_STEAL) && uptime - (s.topAt ?? -Infinity) >= TOP_EVERY_MS
    ) {
      s.topAt = uptime;
      await this.io.snapshot(`${this.paths.lib}/top`, now).catch((e) =>
        log("top snapshot failed:", e)
      );
    }

    const m = this.margin;
    const held = s.balance;
    s.balance = step(p, s.balance, sample, seconds, m);
    if (s.limit) {
      // While a limit lasts the bank is under Hostinger's lift point, whatever the own count earned.
      s.balance = Math.min(s.balance, p.recovered);
      const recovery = s.limit.recovery ??= { seconds: 0, earningSeconds: 0, charged: 0 };
      recovery.seconds += seconds;
      recovery.earningSeconds += sample.earning ? seconds : 0;
      recovery.charged += ownCharge(p, sample, m) * seconds;
    }
    // After a clock step the estimate carries on from where the own count has it, and readings
    // move it again from here.
    if (stepped && s.estimate.anchor) s.estimate.anchor = { at: now, balance: s.balance };
    const fetched = this.fetched;
    this.fetched = false;
    this.resettle();
    // The lowest the estimate read during the sample.
    sample.balance = Math.min(held, s.balance);
    // A full or empty estimate is a point to measure from: the bank is no fuller than full, and
    // holds at least nothing. What it held above the estimate at a lift no longer counts once the
    // estimate has run empty, where it stops falling while the bank goes on.
    if (!s.limit && (s.balance >= p.capacity || s.balance <= 0)) {
      s.estimate.known = { at: now, slack: 0 };
    }
    if (s.balance >= LAW.floor * p.capacity) s.rebuilding = null;
    if (fetched) {
      log(
        "estimate:",
        JSON.stringify({
          at: now,
          balance: Math.round(s.balance),
          anchor: s.estimate.anchor ?? null,
          margin: { ...this.margin, add: Math.round(this.margin.add * 10_000) / 10_000 },
          pad: s.estimate.pad,
          stale: this.stale,
        }),
      );
    }

    const control = this.control();
    const { outside, avgOutside, maxOutside } = control;
    const current = await this.io.ceiling(this.slice);
    const sfNow = demandSteal(control.busy, control.steal);
    // Reset probe backoff after 24 hours of calm past cooldown so days-old neighbour bursts don't
    // leave a future probe stuck at 60 minutes, without re-triggering frequent probes on a noisy
    // host that sees steal episodes every few hours.
    if (
      !s.limit && sfNow < LIMIT_STEAL && s.probe.backoffMs > BACKOFF_MS &&
      uptime >= s.probe.cooldownUntil + DAY_MS
    ) {
      s.probe.backoffMs = BACKOFF_MS;
      s.probe.failedSf = undefined;
    }
    // During a cooldown, probe again only if steal is evident or well above what the failed probe
    // saw: neighbours that failed a probe should not hide a limit that starts behind them.
    const failed = uptime < s.probe.cooldownUntil ? s.probe.failedSf : undefined;
    const jumped = failed !== undefined && sfNow >= Math.max(2 * failed, failed + 0.15);
    // Right after a credit lift no credit limit can come yet: only evident steal is taken as one.
    const quiet = uptime < (s.probe.quietUntil ?? 0);
    const evident = sfNow >= LIMIT_EVIDENT && evidentSteal(p, control.steal);
    const pinned = !quiet && pinnedAtCap(p, control.busy, control.steal, avgOutside);
    const canProbe = !quiet && canProbeSlice(p, control.busy, control.steal, avgOutside);
    if (
      !s.limit && sfNow >= LIMIT_STEAL && (evident || pinned || canProbe) &&
      (uptime >= s.probe.cooldownUntil || evident || jumped)
    ) {
      let confirmed = evident;
      let heldAt: Clock | null = null;
      // A probe compares two short steal shares, and on a nearly idle box noise passes it: a real
      // box took false limits that way. So a probe only earns a burner test, and the burners
      // decide: a credit limit holds the VM at the plan's limit, whatever is asked of it.
      if (!confirmed && (pinned || await this.probe(sfNow, current ?? 100 * p.vcpus))) {
        heldAt = await this.heldAtLimit();
        confirmed = !!heldAt;
      }
      if (confirmed) {
        const entered = this.enterLimit(now, true);
        // Recovery's clock starts after the burners that found the cap.
        if (heldAt) entered.startedAt = entered.heldFrom = Math.max(uptime, heldAt.uptime);
        s.probe.backoffMs = BACKOFF_MS;
        s.probe.failedSf = undefined;
        log(
          `limit: start${
            heldAt && pinned ? ", the VM pinned at the cap with the slice idle" : ""
          } ` +
            `(estimate ${Math.round(100 * (entered.entry?.balance ?? 0) / p.capacity)}%)`,
        );
        this.notify("limit-start");
      } else {
        const finished = await this.io.clock();
        s.probe.cooldownUntil = Math.max(uptime, finished.uptime) + s.probe.backoffMs;
        s.probe.backoffMs = Math.min(s.probe.backoffMs * 2, BACKOFF_MAX_MS);
        s.probe.failedSf = sfNow;
      }
    }

    const limit = s.limit;
    if (limit) {
      // The recovery ceiling follows work outside the slice, under any tighter cap set because the
      // VM actually pressed on the limit. It tightens at once, on the latest sample, and relaxes
      // back up only to what every sample of the five-minute window allows: a spike gives its
      // room back once it has left the window, while outside load that keeps swinging holds the
      // ceiling at its low side instead of sending the helper a new quota every pass.
      const pressed = limit.tightenedCeiling ?? 100 * p.vcpus;
      const tight = Math.min(pressed, recoveryCeiling(p, outside));
      const calm = Math.min(pressed, recoveryCeiling(p, Math.max(outside, maxOutside)));
      if (tight < limit.ceiling) limit.ceiling = tight;
      else if (calm > limit.ceiling) limit.ceiling = calm;
      if (!sample.test && pressing && uptime - limit.heldFrom >= TIGHTEN_AFTER_MS) {
        // Tighten only where it cuts strictly below the current ceiling and bites the slice: a
        // transient outside spike that already dropped the ceiling to 20% must not permanently
        // latch `tightenedCeiling` when pressing made no further cut.
        const managedDemand = sliceDemand(p, busy, steal, sample.outside);
        const tightened = tightenCeiling(limit.ceiling, managedDemand);
        if (tightened < limit.ceiling && managedDemand > tightened / 100) {
          log(`limit: still pressing on it; ceiling ${tightened}%`);
          limit.ceiling = tightened;
          limit.tightenedCeiling = Math.min(pressed, tightened);
        }
        limit.heldFrom = uptime;
      }
      // Neighbour steal can keep the own count flat even while the host earns. Once an idle
      // recovery could have completed, test the host whatever the estimate says. This early test
      // usually fails while a real limit holds, and that failure is the evidence that confirms it.
      const recoveryElapsed =
        uptime - (limit.startedAt ?? limit.heldFrom) >= p.recovered / p.baseline * 1000;
      if ((s.balance >= p.recovered || recoveryElapsed) && uptime >= (limit.testAt ?? 0)) {
        let lifted = false;
        try {
          lifted = await this.limitGone();
        } catch (e) {
          this.liftEvidence = "unknown";
          log("lift test inconclusive:", e);
        }
        const finished = await this.io.clock();
        const done = Math.max(uptime, finished.uptime);
        if (lifted) {
          this.lift(limit, now, finished);
        } else {
          // The first test that fails says what holds the VM. One that measured nothing says
          // nothing.
          if (this.liftEvidence !== "unknown") limit.confirmed ??= this.liftEvidence === "limited";
          if (limit.confirmed && this.liftEvidence === "limited") limit.limitedUptime = done;
          limit.testEvery = Math.min(2 * (limit.testEvery ?? TEST_EVERY_MS / 2), TEST_MAX_MS);
          // Schedule from completion, not the sample taken before a 32-second test.
          limit.testAt = done + limit.testEvery;
        }
      }
    }

    try {
      await this.applyCeiling(current, control);
      this.fetcher?.refresh({ at: now, uptime });
    } finally {
      this.dispatchEvents(now);
    }
  }

  // The wall clock moved against what was saved under it. No earlier sample can be laid beside a
  // reading any more. Readings the new clock places in the future were settled under the old
  // one, and a fetch sent under it would bring them back.
  private clockStepped(now: number) {
    for (const x of this.s.samples) x.clockValid = false;
    this.s.readings = this.s.readings.filter((r) => r.at <= now);
    this.fetcher?.reset();
    // When the bank was last known is a time on the old clock. What a limit teaches is measured
    // from here.
    this.s.estimate.known = { at: now, slack: 0 };
  }

  // The first pass of a boot, or after the CPU counters started over. There is no sample yet.
  private async restart({ at: now, uptime, bootId }: Clock, hadState: boolean) {
    const s = this.s;
    this.fetcher?.reset();
    const reason = s.bootId !== bootId ? "reboot" : "counter-reset";
    // Uptime starts over at a boot, so a pass cannot compare it with the wall clock. But a boot
    // the clock says began before the last pass of the one before it did not: the clock has
    // gone back. So has one that reads before the last pass.
    const back = hadState && (reason === "reboot" ? now - uptime : now) < s.at;
    if (back) this.clockStepped(now);
    s.bootId = bootId;
    s.uptime = uptime;
    s.at = now;
    s.tested = false;
    s.noEarn = false;
    s.earning = false;
    s.topAt = undefined;
    s.probe = { cooldownUntil: 0, backoffMs: BACKOFF_MS };
    this.comparison = null;
    // Samples of the last boot keep their wall-clock place, for the readings that still cover
    // them. Their uptime means nothing now.
    for (const x of s.samples) delete x.uptime;
    if (hadState) {
      if (s.estimate.anchor && !this.stale && !s.limit && !back) {
        // The readings and the samples before the stop still say where the bank was. The time
        // down counts at the most the VM could have spent, until the readings that cover it settle.
        s.balance = tail(this.plan, s.estimate.anchor, s.samples, this.margin, now);
      } else {
        // Nothing recent says where the bank is. Empty is the lower bound.
        s.balance = 0;
        s.rebuilding = { reason, since: now };
        if (back && s.estimate.anchor) s.estimate.anchor = { at: now, balance: 0 };
      }
    } else {
      // A first start: what the configuration stated about the bank holds from this pass on.
      if (s.estimate.anchor) s.estimate.anchor.at = now;
      s.estimate.known.at = now;
      if (s.rebuilding) s.rebuilding.since = now;
    }
    if (s.limit) {
      s.limit.heldFrom = uptime;
      s.limit.startedAt = uptime;
      s.limit.testAt = 0;
      s.limit.testEvery = undefined;
      s.limit.limitedUptime = undefined;
      s.limit.confirmed = undefined;
      if (s.limit.entry) s.limit.entry.learn = false;
      s.limit.recovery = { seconds: 0, earningSeconds: 0, charged: 0 };
    }
    const target = this.targetCeiling(DEFAULT_OUTSIDE_CORES);
    s.capFailed = true;
    if (!await this.io.cap(this.slice, target)) throw new Error("startup ceiling not set");
    s.capFailed = false;
    s.ceiling = target;
    this.fetcher?.refresh({ at: now, uptime });
    this.dispatchEvents(now);
  }

  private async applyCeiling(current: number | null, { busy, steal, outside }: Control) {
    const s = this.s;
    const target = this.targetCeiling(outside);
    // Outside a limit on 4+ vCPU plans, skip a rise of 10% away from the 20% floor and full-plan
    // ceiling. Never delay tightening, so the deadband cannot bias credit spend upward.
    if (
      !s.limit && !s.capFailed && current !== null && this.plan.vcpus >= 4 && current > 20 &&
      target > 20 && target < this.plan.vcpus * 100
    ) {
      const skip = target > current && target - current < CEILING_DEADBAND;
      if (skip) {
        s.ceiling = current;
        return;
      }
    }
    s.capFailed = target !== current;
    if (target === current) {
      s.ceiling = target;
      return;
    }
    if (await this.io.cap(this.slice, target)) {
      s.capFailed = false;
      if (Math.abs(target - (s.ceiling ?? 0)) >= 100 || s.limit) {
        log(
          `ceiling ${target}%: ${Math.round(busy * 100)}% busy, ${
            Math.round(steal * 100)
          }% steal, ${Math.round((100 * s.balance) / this.plan.capacity)}% credits`,
        );
      }
      s.ceiling = target;
    }
  }

  // The pass that follows takes the same clock reading (controlPass).
  async takeRequests(clock: Clock) {
    const requests = `${this.paths.run}/requests`;
    // In the order they were sent: names start with the time (main.ts), and a directory lists in
    // no set order, so `limit on` and `limit off` sent together could run the other way round.
    const names = (await list(requests))
      .filter((e) => e.isFile && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const path = `${requests}/${name}`;
      await this.request(path, clock).catch((err) => log("bad request:", err));
      await Deno.remove(path).catch(() => {});
    }
  }

  async save(now: number) {
    if (this.persistWritable) await writeJson(`${this.paths.lib}/persist.json`, this.s, 0o600);
    await writeJson(`${this.paths.run}/state.json`, this.publicState(now), 0o644);
  }
}

// Saved state this release wrote, with every number the estimate stands on in order.
function usable(s: Private): boolean {
  const e = s.estimate;
  return finite(s.balance, s.at) && s.balance >= 0 && Array.isArray(s.samples) &&
    Array.isArray(s.readings) && !!e && finite(e.pad, e.known?.at, e.known?.slack) &&
    Array.isArray(e.excess) && e.excess.every((x) => finite(x)) &&
    (e.anchor === undefined || finite(e.anchor.at, e.anchor.balance)) &&
    s.samples.every((x) => finite(x.at, x.seconds, x.busy, x.steal, x.outside)) &&
    s.readings.every((r) => finite(r.at, r.v));
}

export async function controlPass(g: Governor) {
  try {
    // One clock reading, so requests and the pass agree on whether it reuses the last full pass.
    const clock = await g.io.clock();
    await g.takeRequests(clock);
    await g.tick(clock);
    await g.save(Date.now());
  } catch (e) {
    log("tick failed:", e);
    await g.save(Date.now()).catch(() => {});
    throw e;
  }
  // capSlice already logged why. Report failure to a waiting caller without repeating saves.
  if (g.s.capFailed) throw new Error("CPU ceiling was not applied");
}

// The start-up protocol in one place, so the daemon and every test or study that restarts one run
// the same steps.
export async function openGovernor(
  cfg: Config,
  plan: Plan,
  io: Partial<GovernorIO> = {},
  paths: Pick<typeof PATHS, "run" | "lib"> = PATHS,
  // Whether a daemon has run on this box before. Then missing state is lost state.
  ranBefore = false,
): Promise<Governor> {
  const { saved, readable } = await readPersisted(`${paths.lib}/persist.json`);
  const g = new Governor(cfg, plan, saved ?? (ranBefore ? LOST : undefined), io, paths);
  g.persistWritable = readable;
  return g;
}

// State that exists but cannot be used is lost state, not a first start: `initial_balance` is for
// a new install only.
const LOST = {} as Private;
// A persist.json that doesn't parse is set aside and the estimate starts over; one this run can't
// read stays in place for the next run.
export async function readPersisted(
  path: string,
): Promise<{ saved?: Private; readable: boolean }> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { readable: true };
    log(`persist.json unreadable, left in place and not written this run: ${error}`);
    return { saved: LOST, readable: false };
  }
  try {
    const saved = JSON.parse(text);
    // Anything but an object is no state either, and no first start.
    return { saved: saved && typeof saved === "object" ? saved : LOST, readable: true };
  } catch {
    log("persist.json invalid; set aside, the estimate starts over");
    await Deno.rename(path, `${path}.bad-${Math.floor(Date.now() / 1000)}`).catch(() => {});
    await pruneQuarantine(path);
    return { saved: LOST, readable: true };
  }
}
// Keep the newest few files set aside.
async function pruneQuarantine(path: string): Promise<void> {
  const dir = parentDirectory(path), prefix = `${path.slice(path.lastIndexOf("/") + 1)}.bad-`;
  const names = (await list(dir)).filter((e) => e.isFile && e.name.startsWith(prefix))
    .map((e) => e.name);
  const stamp = (name: string) => Number(name.slice(prefix.length)) || 0;
  for (const name of names.sort((a, b) => stamp(b) - stamp(a)).slice(QUARANTINE_KEPT)) {
    await Deno.remove(`${dir}/${name}`).catch(() => {});
  }
}

export function startLine(p: Plan, balance: number, version: string) {
  return `governor up: ${version}, ${p.name},baseline ${p.baseline} vCPU, capacity ${p.capacity} core-seconds, ${
    Math.round((100 * balance) / p.capacity)
  }% credits saved`;
}

export async function runDaemon(version: string) {
  // Files root created would be root's, mode 0600, and the service could no longer read them.
  if (Deno.uid() === 0) throw new Error("governor run must run as the governor user");
  const cfg = await loadConfig();
  const p = await detectPlan(cfg);
  // One daemon at a time: two would overwrite each other's state. The lock file outlives every
  // run, so one that is already there says a daemon has run on this box before.
  const lockPath = `${PATHS.lib}/daemon.lock`;
  const ranBefore = await Deno.lstat(lockPath).then(() => true, () => false);
  const lock = await Deno.open(lockPath, { create: true, write: true, mode: 0o600 });
  if (!await lock.tryLock(true)) {
    lock.close();
    throw new Error("another governor run is active");
  }
  const g = await openGovernor(cfg, p, {}, PATHS, ranBefore);
  log(startLine(p, g.s.balance, version));
  const legacy = legacySettings(cfg);
  if (legacy.length) {
    log(`config: ${legacy.join(", ")} settings are from before v1.0.0 and no longer used`);
  }
  const controller = new AbortController();
  let ranPass = false;
  const stop = () => {
    controller.abort();
    void g.closeHooks();
    void g.closeDiagnostics();
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  try {
    await controlLoop({
      path: TICK_SOCKET,
      tickMs: (cfg.tick_seconds ?? DEFAULT_TICK_SECONDS) * 1000,
      signal: controller.signal,
      pass: () => {
        ranPass = true;
        return controlPass(g);
      },
    });
  } finally {
    await g.closeDiagnostics();
    if (ranPass) await g.save(Date.now()).catch(() => {});
    await g.closeHooks();
    lock.close();
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
  }
}

export async function configuredFallbackPercent() {
  const cfg = await loadConfig();
  return cfg.fallback_cpu_percent ?? DEFAULT_FALLBACK_CPU_PERCENT;
}

// Invalid/missing configuration always uses the conservative default. This never
// calls Hostinger's API or relies on a potentially stale public credit estimate.
type FallbackIO = {
  config?: () => Promise<Config>;
  vcpus?: () => Promise<number>;
  cap?: (percent: number) => Promise<boolean>;
  // systemctl with these arguments, for the default cap.
  run?: (args: string[]) => Promise<{ success: boolean }>;
};
export async function fallback(io: FallbackIO = {}) {
  let ceiling = DEFAULT_FALLBACK_CPU_PERCENT;
  try {
    ceiling = fallbackCpuPercent(
      await (io.config ?? loadConfig)(),
      await (io.vcpus ?? vcpusSeen)(),
    );
  } catch {
    log(
      `fallback config unavailable or invalid; using ${DEFAULT_FALLBACK_CPU_PERCENT}% of one vCPU`,
    );
  }
  const run = io.run ??
    ((args: string[]) =>
      new Deno.Command("systemctl", { args, stdout: "null", stderr: "null" }).output());
  const cap = io.cap ?? (async (percent: number) => {
    const out = await run(["set-property", "--runtime", "user.slice", `CPUQuota=${percent}%`]);
    // Undo a 10 ms quota period a release before v1.0.0 may have left. systemd before 242 has no
    // such property, so this is best effort and never decides the result.
    if (out.success) {
      await run(["set-property", "--runtime", "user.slice", "CPUQuotaPeriodSec="]).catch(() => {});
    }
    return out.success;
  });
  const applied = await cap(ceiling);
  log(`fallback ceiling ${ceiling}%`, applied ? "set" : "failed");
  if (!applied) throw new Error("could not apply fallback CPU quota");
}
