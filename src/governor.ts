// CPU accounting uses kernel uptime and boot identity. Hostinger's readings never raise the bank;
// in calibration's apply mode they can only tighten it (src/calibration.ts). Root owns
// administrative requests; consumers read public state.
import {
  allowedCores,
  type Anchor,
  charged,
  creditStep,
  demandSteal,
  LAW,
  LIFT_STEAL,
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
  validSpacing,
  widen,
} from "./credits.ts";
import {
  cpuReadings,
  type HostingerSource,
  InvalidReadingsError,
  validateSource,
} from "./hostinger.ts";
import { MAX_VCPUS, type Plan, plan, RULES_SINCE } from "./plans.ts";
import { DEFAULT_FALLBACK_CPU_PERCENT, fallbackCpuPercent } from "./fallback.ts";
import { HOOK_TIMEOUT_SECONDS, HookRunner, validateHookTimeout } from "./hooks.ts";
import { DiagnosticsRunner } from "./diagnostics.ts";
import { writeJson } from "./storage.ts";
import { controlLoop } from "./control.ts";
import {
  accumulateSlot,
  addSlots,
  boundHistory,
  covered,
  type Decision,
  DECISIONS_KEPT,
  emptyHistory,
  finite,
  FLAGS,
  type History,
  HistoryStore,
  type LimitRecord,
  LIMITS_KEPT,
  mergeFetchReadings,
  planKey,
  pruneQuarantine,
  sameSettings,
  type Settings,
  settledReadings,
  type Slot,
  validLimit,
  withOpenSlot,
} from "./history.ts";
import {
  calculateEstimates,
  calibrationConfig,
  type CalibrationMode,
  type CalibrationOptions,
  type CalibrationState,
  type CalibrationStatus,
  calibrationSummary,
  type Change,
  classifyLimits,
  eachSampleOverlap,
  effectiveSettings,
  type Evaluation,
  fallbackMargin,
  initialCalibration,
  inputsDigest,
  longIntervalResidual,
  maxSettings,
  MISMATCH_WINDOW_MS,
  openEstimates,
  pairSamples,
  replayCheckpoint,
  resetCalibration,
  sustainedCooldown,
  sustainedRestore,
  tailSlots,
  updateCalibration,
  validateCalibration,
  validCalibrationState,
  withStart,
} from "./calibration.ts";
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
  calibration?: CalibrationOptions;
  readings?: { use_newest?: boolean };
  recovery?: { quota_period_ms?: number | null };
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
  test?: boolean;
  limited?: boolean;
  track?: number | null;
  // Longer than two passes: the daemon was stopped, so the sample only knows the average.
  unobserved?: boolean;
};
export type Limit = {
  since: number;
  ceiling: number;
  heldFrom: number;
  startedAt?: number;
  testAt?: number;
  testEvery?: number;
  // Defer learning until a failed lift test supplies more evidence. Passing the first test does
  // not distinguish a false alarm from a genuine limit that has already recovered.
  entry?: { balance: number; used: number; learn: boolean };
  recovery?: { seconds: number; earningSeconds: number; charged: number };
  record?: LimitRecord;
};

type Rebuilding = {
  reason: "first-start" | "state-upgrade" | "plan-change" | "reboot" | "counter-reset";
  since: number;
};

// persist.json: the daemon's working state.
export type Private = {
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
  probe: { cooldownUntil: number; backoffMs: number; failedSf?: number };
  samples: Sample[];
  tested?: boolean;
  readings: Reading[];
  cpuPrev?: Counters;
  usagePrev?: UsageSnapshot;
  ceiling?: number;
  topAt?: number;
  noEarn?: boolean;
  earning?: boolean;
  capFailed?: boolean;
  rebuilding?: Rebuilding | null;
  openSlot?: Slot;
  rebootPending?: boolean;
  calibration?: CalibrationState;
  calibrationMode?: CalibrationMode;
  calibrationActivated?: boolean;
  marginLearned?: boolean;
  // The quota period the helper last set while limited, so a later pass can restore the default
  // even after the option is turned off.
  quotaPeriod?: number;
  // The VM whose readings the calibration state learned from (#13 §1).
  vmId?: number | null;
  // History's last write failed or it couldn't be read, so this file is ahead of it.
  historyBehind?: true;
  // Calibration has failed since `since`: apply holds the fallback and acts at least `behind` below
  // the open estimate, the clamp's margin when it last worked. Kept here so a restart, explain and
  // every pass in between hold the same fallback.
  evaluationFailed?: { since: number; logged: number; behind: number };
};
// The limit as consumers see it; the growing evidence record stays private.
export type PublicLimit = Omit<Limit, "record">;

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
    calibration?: CalibrationStatus & { failing: { since: number; behind: number } | null };
    // Rebuilding a conservative reserve is not evidence of an empty Hostinger bank or a limit.
    rebuilding: Rebuilding | null;
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
  coverage: { outsideCores: number; recoveryBlocked: boolean };
};

const STEAL_WINDOW_MS = 5 * 60_000;
const CPU_WINDOW_MS = 30 * 60_000;
const KEEP_MS = 2 * 3_600_000;
const READINGS_KEEP_MS = 48 * 3_600_000;
const LIMIT_STEAL = 0.1;
const TEST_EVERY_MS = 2 * 60_000;
const TEST_MAX_MS = 15 * 60_000;
const TIGHTEN_AFTER_MS = 60_000;
const BACKOFF_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const HOT_BUSY = 0.6;
const HOT_STEAL = 0.05;
const TOP_EVERY_MS = 5 * 60_000;
const DEFAULT_TICK_SECONDS = 30;
const MAX_MIN_SAMPLE_MS = 5000;
const DEFAULT_OUTSIDE_CORES = 0.4;
// A sustained-use limit's hidden estimate is restored within a day of its lift, or not at all.
const RESTORE_WINDOW_MS = 86_400_000;
// How long a rejected quota period waits before the helper is asked again.
const PERIOD_RETRY_MS = 15 * 60_000;
// Calibration decisions that alert. Credit limits alert only through learning (`calibration`).
const ALERTS = new Set(["readings-invalid", "rules-mismatch"]);

type ControlMeasurements = { count: number; busy: number; steal: number; outside: number };

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
    if (!validSpacing(start, end)) continue;
    let observed = 0;
    let guest = 0;
    eachSampleOverlap(samples, start, end, (s, ms) => {
      if (s.clockValid === false) return;
      observed += ms;
      guest += ms * s.busy * 100;
    });
    if (!covered(observed, end - start)) continue;
    error += readings[i].v * observed - guest;
    measured += observed;
  }
  return measured ? error / measured : null;
}
// An evaluation's history inputs, as its checkpoint records them for explain. Decisions,
// revisions and long-interval pairs are not inputs.
export function recordedEvidence(h: History): Omit<History, "checkpoint"> {
  const evidence: History = { ...h, calibrations: [], revisions: [] };
  delete evidence.checkpoint;
  delete evidence.longPairs;
  return structuredClone(evidence);
}
const publicLimit = (limit: Limit): PublicLimit => {
  const copy: Limit = { ...limit };
  delete copy.record;
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
    "calibration",
    "readings",
    "recovery",
  ],
  hostinger: ["vm_id", "token_file", "token_command", "request_command"],
  readings: ["use_newest"],
  recovery: ["quota_period_ms"],
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
  validateCalibration(cfg.calibration);
  // Without readings, apply would run its start settings and then the stale fallback, unchecked.
  if (calibrationConfig(cfg.calibration).mode === "apply") {
    const h = cfg.hostinger;
    if (!id) throw new Error("calibration.mode apply requires hostinger.vm_id");
    if (!h?.token_file && !h?.token_command && !h?.request_command) {
      throw new Error("calibration.mode apply requires a token source or request_command");
    }
  }
  for (const key of ["readings", "recovery"] as const) {
    if (
      cfg[key] !== undefined &&
      (!cfg[key] || typeof cfg[key] !== "object" || Array.isArray(cfg[key]))
    ) throw new Error(`${key} must be an object`);
  }
  if (cfg.readings?.use_newest !== undefined && typeof cfg.readings.use_newest !== "boolean") {
    throw new Error("readings.use_newest must be boolean");
  }
  const period = cfg.recovery?.quota_period_ms;
  if (period !== undefined && period !== null && period !== 10) {
    throw new Error("recovery.quota_period_ms must be null or 10");
  }
  if (cfg.timezone !== undefined) new Intl.DateTimeFormat("en", { timeZone: cfg.timezone });
  return cfg;
}

export async function detectPlan(cfg: Config): Promise<Plan> {
  return plan(cfg.vcpus ?? await vcpusSeen(), undefined, cfg.baseline_share);
}

async function capSlice(
  slice: string,
  percent: number,
  periodMs?: number | null,
): Promise<boolean> {
  const out = await new Deno.Command("sudo", {
    args: [
      "-n",
      PATHS.cap,
      String(percent),
      slice,
      ...(periodMs === undefined ? [] : [periodMs === null ? "default" : String(periodMs)]),
    ],
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

export class Governor {
  s: Private;
  readonly io: GovernorIO;
  comparison: number | null = null;
  private liftEvidence: "unknown" | "limited" | "lifted" = "unknown";
  private readonly hookRunner: HookRunner;
  private readonly diagnostics?: DiagnosticsRunner;
  private readonly calibrationCfg: ReturnType<typeof calibrationConfig>;
  history: History;
  private historyStore?: HistoryStore;
  // A quota period the helper rejected, and when (uptime). It waits PERIOD_RETRY_MS before another
  // try, so a helper without support is not asked every pass and a transient failure still clears.
  private periodRejected?: { period: number | null; uptime: number };
  private diagnosticsInvalid = false;
  private historyFetched = false;
  private recalibrateDue = false;
  // A pass, request or fetch may have changed history since its last write. Every pass writes it,
  // so this tracks passes, not each change: save() writes for a pass that ended before its own.
  private unwritten = true;
  // Whether this run has sent the quota period at least once.
  private periodSent = false;
  // A non-default period this run set, which a failed restore must retry.
  private periodSetHere = false;
  // Hook events wait until the pass has applied its quota.
  private events: string[] = [];
  // Saved calibration state, or persist.json itself, was missing or invalid; recover what history
  // recorded (loadHistory).
  private calibrationRecovering = false;
  // No persist.json at all: with history present this is a lost file, not a first start.
  private withoutState = false;
  // This start switches to apply for the first time, from the configured start.
  private activating = false;
  // Calibration came back from a recorded evaluation or decision, so this isn't a first start.
  private recovered = false;
  // False when persist.json exists but this run couldn't read it: it stays for the next run.
  persistWritable = true;
  // persist.json existed but didn't parse: lost, though no history may show it (#13 §1).
  stateInvalid = false;
  // Since when evaluations have failed, and when that was last logged.
  constructor(
    readonly cfg: Config,
    readonly plan: Plan,
    given?: Private,
    io: Partial<GovernorIO> = {},
    readonly paths: Pick<typeof PATHS, "run" | "lib"> = PATHS,
  ) {
    validateConfig(cfg);
    this.calibrationCfg = calibrationConfig(cfg.calibration);
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
          args: ["35", "sh", "-c", "while :; do :; done"],
          stdout: "null",
          stderr: "null",
        }).spawn(),
      ...io,
    };
    const key = planKey(plan);
    // Saved state as persist.json holds it. Restarts in tests and studies passed a copy, which kept
    // values JSON doesn't, such as -Infinity, so they passed where the daemon's restart didn't.
    const saved = given && JSON.parse(JSON.stringify(given)) as Private;
    const restoring = saved && saved.schema === 2 && saved.planKey === key;
    this.withoutState = !saved;
    this.s = restoring ? saved : {
      balance: saved ? 0 : Math.min(cfg.initial_balance ?? 0, plan.capacity),
      at: Date.now(),
      margin: { ...MARGIN },
      used: 0,
      probe: { cooldownUntil: 0, backoffMs: BACKOFF_MS },
      samples: [],
      readings: [],
      capFailed: true,
      rebuilding: {
        reason: saved ? saved.schema === 2 ? "plan-change" : "state-upgrade" : "first-start",
        since: Date.now(),
      },
    };
    if (saved && !restoring) {
      if (
        saved.margin && Number.isFinite(saved.margin.mul) && saved.margin.mul >= MARGIN.mul &&
        Number.isFinite(saved.margin.add) && saved.margin.add >= MARGIN.add
      ) {
        this.s.margin = { ...saved.margin };
      }
      if (saved.limit && Number.isFinite(saved.limit.since)) {
        this.s.limit = {
          since: saved.limit.since,
          ceiling: recoveryCeiling(plan, DEFAULT_OUTSIDE_CORES),
          heldFrom: 0,
          startedAt: 0,
        };
      }
    }
    const failed = this.s.evaluationFailed;
    if (failed && !(finite(failed.since, failed.logged, failed.behind) && failed.behind >= 0)) {
      // A malformed record still says calibration was failing: hold the clamp's widest margin. It
      // was last logged at 0, not -Infinity, which JSON saves as null: every start rebuilt the
      // record again and moved its start to that start.
      this.s.evaluationFailed = { since: this.s.at, logged: 0, behind: plan.capacity };
    }
    if (this.s.calibration && !validCalibrationState(this.s.calibration)) {
      log("calibration state invalid; recovering learned settings from history");
      this.s.calibration = undefined;
    }
    // Calibration is evidence about one VM's meter, as history is. A state learned from another
    // VM's readings starts over with this VM's history, which the store checks the same way.
    // Without a VM in the config there are no readings, so nothing can come from another VM's meter.
    const vmId = cfg.hostinger?.vm_id ?? null;
    if (this.s.calibration && vmId !== null && (this.s.vmId ?? vmId) !== vmId) {
      log("calibration state is from another VM; recovering from this VM's history");
      this.s.calibration = undefined;
    }
    this.s.vmId = vmId ?? this.s.vmId ?? null;
    // Missing calibration state comes back from history (loadHistory) in every mode: once apply has
    // run, off and shadow carry its learned state too.
    this.calibrationRecovering = !this.s.calibration;
    // Apply first starts from the configured start, or from a margin a confirmed limit widened:
    // would-be decisions from before it, a rules mismatch included, do not carry into it. What the
    // readings and limits are doing now carries over, as across a reset: staleness, readings marked
    // invalid, both holds and any cooldown. Once apply has run, the state carries across every later
    // switch, so off and shadow tightenings made after that count in apply too. They only tighten.
    const activating = !saved?.calibrationActivated && saved?.calibrationMode !== "apply" &&
      this.applying;
    this.activating = activating;
    const inherited = this.inheritedMargin;
    if (!this.s.calibration || activating) {
      this.s.calibration = this.s.calibration
        ? resetCalibration(this.calibrationCfg, this.s.calibration, this.s.at, inherited)
        : initialCalibration(this.calibrationCfg, this.s.at, inherited);
      this.s.calibration.estimates = openEstimates(this.s.balance);
    }
    // A tighter start, a higher gap_start or a raised start floor in the config applies at once.
    this.s.calibration = withStart(plan, this.calibrationCfg, this.s.calibration);
    this.s.calibrationActivated =
      (restoring && (saved.calibrationActivated || saved.calibrationMode === "apply")) ||
      this.applying;
    this.s.calibrationMode = this.calibrationCfg.mode;
    this.history = emptyHistory(key, cfg.hostinger?.vm_id ?? null, this.s.at);
    // A limit carried over from v0.2.5 has no record. One starts now, so the limit is classified at
    // its lift like any other, from the caps it presses on from here, and only a credit limit
    // widens. v0.2.5's estimate at entry is what widen() measures.
    const carried = this.s.limit;
    if (carried && !carried.record) {
      carried.record = {
        onset: carried.since,
        entry: carried.since,
        path: "evident",
        balance: carried.entry?.balance ?? 0,
        used: carried.entry?.used ?? 0,
        settings: { ...this.settings },
        gap: this.calibration.gap,
        mode: this.calibrationCfg.mode,
        track: null,
        caps: [],
        confirmed: false,
        learn: !!carried.entry?.learn,
      };
      this.history.limits.push(carried.record);
    }
    this.s.schema = 2;
    this.s.planKey = key;
    // Older persisted state includes diagnostic timers. Each daemon gets a fresh schedule;
    // keep the compatible credit estimate but retire these obsolete fields on the next save.
    const legacy = this.s as Private & { anchorNext?: number; anchorBackoff?: number };
    delete legacy.anchorNext;
    delete legacy.anchorBackoff;
    const h = cfg.hostinger;
    if (h?.vm_id) {
      const id = h.vm_id;
      this.diagnostics = new DiagnosticsRunner({
        readings: (at) =>
          this.io.readings(h, id, Math.max(at - READINGS_KEEP_MS, RULES_SINCE), at, true),
        clock: () => this.io.clock(),
        publish: (readings, at) => this.publishDiagnostics(readings, at),
        log: (e) => {
          log("diagnostics failed:", e);
          if (e instanceof InvalidReadingsError) {
            this.diagnosticsInvalid = true;
          }
        },
      });
    }
    if (this.s.balance >= this.law.floor * plan.capacity) this.s.rebuilding = null;
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

  private controlMeasurements(): ControlMeasurements {
    const recent = this.controlSamples(STEAL_WINDOW_MS);
    const latest = this.s.samples.at(-1);
    return {
      count: recent.length,
      busy: avg(recent.map((x) => x.busy)),
      steal: recent.length >= 3 ? avg(recent.map((x) => x.steal)) : 0,
      // Assume the startup default only before anything is measured. A window holding only test
      // samples has no outside estimate; a default here would tighten recovery ceilings.
      outside: latest
        ? Math.max(latest.test ? 0 : latest.outside ?? 0, avg(recent.map((x) => x.outside ?? 0)))
        : DEFAULT_OUTSIDE_CORES,
    };
  }

  get calibration() {
    return this.s.calibration!;
  }
  // A margin a confirmed limit widened, which apply's first start keeps.
  private get inheritedMargin() {
    const m = this.s.margin;
    return this.s.marginLearned || m.mul > MARGIN.mul || m.add > MARGIN.add ? m : undefined;
  }
  get applying() {
    return this.calibrationCfg.mode === "apply";
  }
  // In apply, readings can only lower the balance the governor acts on.
  get actedBalance() {
    return this.applying ? Math.min(this.s.balance, this.heldEstimates.acted) : this.s.balance;
  }
  // The estimates, held below the open one while calibration fails. Every pass rebuilds estimates,
  // so the hold applies here, where each reads them, not where the failure was caught: there, the
  // next pass without an evaluation gave it back and acted on the open estimate alone.
  get heldEstimates(): CalibrationState["estimates"] {
    const e = this.calibration.estimates, failed = this.s.evaluationFailed;
    return failed && this.applying
      ? { ...e, acted: Math.min(e.acted, Math.max(0, this.s.balance - failed.behind)) }
      : e;
  }
  get settings() {
    if (!this.applying) return { ...this.s.margin, floor: LAW.floor };
    const settings = effectiveSettings(this.calibration);
    return this.s.evaluationFailed ? fallbackMargin(settings) : settings;
  }
  // The sustained-use cooldown follows from the limit records, so it holds whichever of history and
  // persist.json a crash left newer, and when an evaluation fails.
  private get cooldownUntil() {
    return sustainedCooldown(this.history, this.calibrationCfg, this.calibration);
  }
  get law() {
    return { ...LAW, floor: this.settings.floor };
  }
  private targetCeiling(outside: number) {
    const allowed = allowedCores(this.plan, this.actedBalance, this.settings, this.law);
    // After a sustained-use limit, stay at or below the baseline for the cooldown.
    return this.s.limit?.ceiling ??
      sliceCeiling(
        this.plan,
        this.s.at < this.cooldownUntil
          ? Math.min(allowed, (this.plan.baseline - this.settings.add) / this.settings.mul)
          : allowed,
        outside,
      );
  }

  async loadHistory(now: number) {
    this.historyStore = new HistoryStore(`${this.paths.lib}/history.json`, log);
    this.adoptHistory(
      await this.historyStore.load(planKey(this.plan), this.cfg.hostinger?.vm_id ?? null, now),
      now,
    );
    this.historyStore.write(this.history, now);
  }
  // History as the store loaded it, or as a simulated restart carries it over in memory.
  adoptHistory(history: History, now: number) {
    this.history = history;
    this.history.meterPairs ??= [];
    // A lost persist.json restarts the bank at 0, as a reboot does; initial_balance is for a first
    // start only. History that exists but can't be read this run still rules out a first start,
    // and so does a persist.json that didn't parse.
    const h = this.history;
    const unreadable = !!this.historyStore?.unreadable;
    const empty = !h.slots.length && !h.readings.length && !h.limits.length &&
      !h.calibrations.length && !h.checkpoint;
    this.adoptLimitRecord();
    if (this.withoutState && (unreadable || !empty || this.stateInvalid)) {
      this.s.balance = 0;
      // Status must show a rebuilding estimate, not an empty bank, as on any first start.
      this.s.rebuilding ??= { reason: "first-start", since: now };
      // Local samples don't reach back past this start either, so the clamp restarts from an empty
      // bank too, at the first reading they cover again, as after a reboot.
      this.s.rebootPending = true;
      // Nothing this run learns can stand in for the history it couldn't read, so persist.json
      // stays missing and the next start recovers from that history.
      if (unreadable) this.persistWritable = false;
    }
    // An evaluation or decision recorded in apply shows apply already ran, whatever persist.json
    // says: a lost one must not start apply over, or let limits from before a reset teach it.
    const decisions = h.calibrations;
    if (
      decisions.some((d) => d.activated || d.mode === "apply") ||
      h.checkpoint?.config.mode === "apply"
    ) {
      this.s.calibrationActivated = true;
      this.activating = false;
    }
    // Before anything inherits it: apply's first start keeps a margin widen() learned.
    const raised = this.rebuildMargin(), saved = this.s.calibration;
    const recovering = this.calibrationRecovering;
    if (recovering) this.recoverCalibration(now);
    else if (!this.activating) this.catchUp();
    if (this.activating) {
      // Apply's first start begins from start, or the widened margin, whatever state came back.
      if (raised || recovering) {
        this.s.calibration = resetCalibration(
          this.calibrationCfg,
          this.calibration,
          recovering ? now : this.s.at,
          this.inheritedMargin,
        );
      }
      this.keepOpenLimits();
    }
    const s = this.calibration;
    if (this.s.calibration !== saved || recovering) s.estimates = openEstimates(this.s.balance);
    // Every recorded serial is behind the state from here on, so no later start takes a recorded
    // decision, a reset above all, as newer than what this one already holds.
    const serial = Math.max(
      s.serial ?? 0,
      ...decisions.map((d) => d.serial ?? 0),
      (h.checkpoint?.before.serial ?? -1) + 1,
    );
    if (serial > 0) s.serial = serial;
    // A rebuilt history has no base (#13 §9): nothing in it backs one persist.json carried.
    if (empty && !unreadable) s.replayBase = null;
    this.s.calibration = withStart(this.plan, this.calibrationCfg, s);
    // The first pass evaluates, so the clamp and explain work from it, not from the next slot.
    this.recalibrateDue = true;
    // What a restart came back with was announced before it.
    this.announced = undefined;
    this.announceCalibration();
  }
  // The open limit and its record, whichever of the two files a crash or a loss left newer. History's
  // copy of the record is the newer one unless persist.json says history fell behind it, and it
  // stands in for a copy in persist.json that doesn't validate. A record history shows lifted ends
  // the limit; one still open goes on as a limit, though persist.json lost it or never saved it:
  // left alone, the record never got its lift or class, and the box ran as if unlimited until the
  // limit was detected again under a new record, without the evidence the first had gathered.
  private adoptLimitRecord() {
    const behind = !!this.s.historyBehind;
    delete this.s.historyBehind;
    const limit = this.s.limit;
    if (limit?.record) {
      const saved = limit.record, valid = validLimit(saved);
      const i = valid
        ? this.history.limits.findIndex((r) => r.onset === saved.onset)
        : this.history.limits.findLastIndex((r) => r.lift === undefined && r.entry === limit.since);
      if (i >= 0 && !(valid && behind)) limit.record = this.history.limits[i];
      else if (i >= 0) this.history.limits[i] = saved;
      else if (valid) this.history.limits.push(saved);
      else {
        log("limit record in persist.json invalid; the limit goes on without one");
        limit.record = undefined;
      }
      if (limit.record?.lift !== undefined) {
        log("limit: history shows it lifted");
        this.s.limit = undefined;
      }
      return;
    }
    const open = this.history.limits.at(-1);
    if (limit || behind || !open || open.lift !== undefined || open.class !== undefined) return;
    log("limit: resumed from history");
    // As across a reboot: the entry estimate is gone, and the first pass tests the lift.
    this.s.limit = {
      since: open.entry,
      ceiling: recoveryCeiling(this.plan, DEFAULT_OUTSIDE_CORES),
      heldFrom: 0,
      startedAt: 0,
      record: open,
    };
    if (!open.confirmed) open.learn = false;
    this.s.balance = 0;
  }
  // A limit still open when apply first starts is evidence about the meter, as across a reset:
  // apply diagnoses it, though it began before apply's start.
  private keepOpenLimits() {
    const open = this.history.limits.filter((r) => r.class === undefined);
    if (!open.length) return;
    this.calibration.startedAt = Math.min(
      this.calibration.startedAt,
      ...open.map((r) => r.entry),
    );
  }
  // persist.json keeps the legacy margin widen() learned. Its records are in history too, so a lost
  // or lagging persist.json can't loosen off mode's margin, or the one apply's first start inherits.
  // A record made outside apply holds the legacy margin in force at its entry, which already sums
  // every earlier widening, v0.2.5's and any record no longer kept; one widen() learned from adds
  // its step on top.
  private rebuildMargin(): boolean {
    let margin: Margin = { ...MARGIN };
    const raise = (m: Margin) => {
      margin = { mul: Math.max(margin.mul, m.mul), add: Math.max(margin.add, m.add) };
    };
    for (const r of this.history.limits) {
      // The legacy margin a widening left: exact, and present whatever mode the limit began in. A
      // limit entered in apply and lifted in off widened off's margin, which its entry settings,
      // apply's, can't give back.
      if (r.legacyMargin) raise(r.legacyMargin);
      if (r.mode === "apply") continue;
      const entry = { mul: r.settings.mul, add: r.settings.add };
      raise(entry);
      if (r.legacyLearned) raise(widen(entry, r.balance, r.used));
    }
    if (margin.mul <= this.s.margin.mul && margin.add <= this.s.margin.add) return false;
    this.s.margin = {
      mul: Math.max(this.s.margin.mul, margin.mul),
      add: Math.max(this.s.margin.add, margin.add),
    };
    this.s.marginLearned = true;
    return true;
  }
  // Losing persist.json, or only its calibration state, must not loosen anything or drop what the
  // daemon was doing. The latest evaluation, rerun from its digest-checked inputs, gives the whole
  // state back: learned settings, holds, a drift change and its verification, CUSUM and fit, limits
  // still to diagnose, the stale clock, readings marked invalid and any cooldown. Without one, the
  // newest decision holds the learned part. Either way, apply's first start still begins from the
  // configured start (adoptHistory).
  private recoverCalibration(now: number) {
    this.calibrationRecovering = false;
    const replayed = this.replayRecorded();
    const replayedValid = replayed !== null;
    if (replayed) this.s.calibration = replayed;
    else this.recoverFromDecisions(now);
    // A first start, or an upgrade from v0.2.5, has nothing to recover.
    this.recovered = replayedValid || this.history.calibrations.length > 0;
    if (!this.recovered) return;
    log(
      `calibration: recovered x${this.calibration.applied.mul} +${this.calibration.applied.add} ` +
        `from ${replayedValid ? "the recorded evaluation" : "decisions"}`,
    );
  }
  // The newest decision since apply first ran holds the learned settings, gap and rules-mismatch
  // latch, and a drift change still holding; off and shadow share that state from then on, and a
  // reset's decision holds the start. Drift detection resumes with readings after the newest one.
  private recoverFromDecisions(now: number) {
    const s = this.calibration, decisions = this.history.calibrations;
    const spans = decisions.at(-1)?.invalidSpans;
    // Nothing that could end an open span survives with it, so it closes here, as at a reset.
    if (spans) s.invalidSpans = spans.map((x) => x.to === null ? { ...x, to: now } : { ...x });
    for (const r of this.history.limits) {
      if (r.class !== "sustained-use" || r.lift === undefined) continue;
      s.cooldownUntil = Math.max(
        s.cooldownUntil,
        r.lift + this.calibrationCfg.sustained_cooldown_s * 1000,
      );
    }
    // Verification and CUSUM start over with readings that arrive from here on, and long intervals
    // already paired aren't paired again.
    s.lastPaired = this.history.readings.at(-1)?.at ?? 0;
    s.longPairedAt = this.history.longPairs?.at(-1)?.at ?? 0;
    // Lift-check mismatches since the last reset still count toward the 30-day latch (#13 §7).
    const since = decisions.findLastIndex((d) => d.trigger === "reset") + 1;
    s.mismatches = decisions.slice(since).flatMap((d) => {
      if (d.trigger !== "rules-mismatch" || typeof d.inputs.ratio !== "number") return [];
      if (this.applying && !d.activated && d.mode !== "apply") return [];
      const lift = this.history.limits.find((r) => r.onset === d.inputs.onset)?.lift;
      return lift !== undefined && now - lift <= MISMATCH_WINDOW_MS ? [lift] : [];
    });
    const last = decisions.findLast((d) => d.activated || d.mode === "apply");
    if (!last?.learned) return;
    // A drift change still holding comes back with its meter. Verification of an unverified one
    // starts over, so §8 can still withdraw it.
    if (last.pending) {
      const pending = structuredClone(last.pending);
      s.pending = pending.verified ? pending : { ...pending, readings: 0, z: 0 };
      s.fit ??= pending.oldFit;
    }
    // Refits after a drift change still stop at its change point and use the margin before it.
    if (last.fitFrom && last.fitSince !== undefined) {
      s.fitSince = last.fitSince;
      s.fitFrom = { ...last.fitFrom };
    }
    this.raiseToDecision(last);
  }
  // persist.json is written after history, so a crash between the two leaves it an evaluation
  // behind. Serials, not the wall clock, tell which is newer: every evaluation and reset counts one.
  // The newer checkpoint gives back the state persist.json missed, a reset included. Without one
  // that verifies, a reset among the newer decisions applies first, and the learned settings then
  // take at least the newest decision's after it, since they only tighten.
  private catchUp() {
    const seen = this.calibration.serial ?? 0;
    const checkpoint = this.history.checkpoint;
    if (checkpoint && (checkpoint.before.serial ?? 0) >= seen) {
      const replayed = this.replayRecorded();
      if (replayed) {
        this.s.calibration = replayed;
        log("calibration: caught up with the evaluation persist.json missed");
        return;
      }
    }
    if (!this.s.calibrationActivated) return;
    const missed = this.history.calibrations.filter((d) =>
      (d.activated || d.mode === "apply") && d.learned && (d.serial ?? 0) > seen
    );
    // Raising to the newest decision alone kept what a reset before it had cleared.
    const reset = missed.findLast((d) => d.trigger === "reset");
    if (reset) {
      this.s.calibration = resetCalibration(this.calibrationCfg, this.calibration, reset.at);
    }
    const last = missed.at(-1);
    if (last && last !== reset) this.raiseToDecision(last);
  }
  // The latest recorded evaluation, rerun from its inputs once their digest verifies.
  private replayRecorded(): CalibrationState | null {
    const checkpoint = this.history.checkpoint;
    if (!checkpoint) return null;
    try {
      const state = replayCheckpoint(this.plan, checkpoint)?.state ?? null;
      return state && validCalibrationState(state) ? state : null;
    } catch (error) {
      log("calibration checkpoint does not replay:", error);
      return null;
    }
  }
  // The learned settings, gap and rules-mismatch latch take at least a decision's.
  private raiseToDecision(d: Decision) {
    const s = this.calibration;
    s.applied = maxSettings(s.applied, d.learned!);
    s.gap = Math.max(s.gap, d.gap ?? 0);
    s.rulesMismatch ||= !!d.rulesMismatch;
  }
  closeHistory() {
    return this.historyStore?.close() ?? Promise.resolve();
  }
  // Bytes of history handed to the filesystem since the store opened, for the disk budget.
  get historyWritten() {
    return this.historyStore?.written ?? 0;
  }
  // The store appends only what changed, so every pass hands it the whole history: nothing a pass
  // changes has to remember to mark it.
  private writeHistory(now: number) {
    this.unwritten = false;
    try {
      boundHistory(this.history, now);
      this.historyStore?.write(this.history, now);
    } catch (error) {
      // A failure here must not block persist.json and state.json, which save() writes next.
      log("history not written:", error);
    }
  }
  private settledHistory(): History {
    return {
      ...this.history,
      readings: settledReadings(this.history, this.cfg.readings?.use_newest),
    };
  }
  // A failure in calibration must not freeze the ceiling, nor loosen apply: until an evaluation
  // succeeds, apply holds the 1.05x + 0.08 fallback, as for invalid readings, and acts on the open
  // estimate less the clamp's last margin below it. The next slot or fetch evaluates again;
  // retrying every pass would spend the CPU budget on the same failure. It's logged hourly. Only a
  // full evaluation ends the fallback: the estimates between them can't judge the readings.
  private evaluate(step: () => void, now: number, full = true) {
    const last = this.calibration.estimates;
    try {
      step();
      if (!full) return;
      if (this.s.evaluationFailed) log("calibration: evaluating again");
      delete this.s.evaluationFailed;
    } catch (error) {
      const failed = this.s.evaluationFailed;
      // The margin below the open estimate is the clamp's at the first failure. Measured again at
      // a later one, after passes in between had rebuilt the estimates, it came out 0.
      const behind = failed?.behind ?? Math.max(0, last.open - last.acted);
      const logged = !failed || now - failed.logged >= 3_600_000 || now < failed.logged;
      if (logged) log("calibration failed; holding the fallback:", error);
      this.s.evaluationFailed = {
        since: failed?.since ?? now,
        logged: logged ? now : failed!.logged,
        behind,
      };
      this.calibration.estimates = openEstimates(this.s.balance);
    }
  }
  private tailHistory(): History {
    // The newest reading as an evaluation sees it (settledReadings), so the replay base matches.
    const settled = this.history.readings.at(-1);
    const unsettled = this.cfg.readings?.use_newest ? this.history.unsettled : undefined;
    const latest = unsettled && (!settled || unsettled.at > settled.at) ? unsettled : settled;
    return {
      ...this.history,
      readings: latest ? [latest] : [],
      slots: withOpenSlot(
        tailSlots(this.history.slots, this.calibration.replayBase!.at),
        this.s.openSlot,
      ),
    };
  }
  calibrationStatus() {
    const failed = this.applying ? this.s.evaluationFailed : undefined;
    return {
      ...calibrationSummary(
        this.calibrationCfg,
        { ...this.calibration, estimates: this.heldEstimates },
        this.history,
        this.settings,
      ),
      failing: failed ? { since: failed.since, behind: failed.behind } : null,
    };
  }
  private recordDecision(change: Change, now: number) {
    const c = this.calibration;
    const decision = {
      at: now,
      ...change,
      digest: inputsDigest(change.inputs),
      mode: this.calibrationCfg.mode,
      learned: { ...c.applied },
      gap: c.gap,
      rulesMismatch: c.rulesMismatch,
      ...(c.pending ? { pending: structuredClone(c.pending) } : {}),
      ...(c.fitFrom && c.fitSince !== undefined
        ? { fitSince: c.fitSince, fitFrom: { ...c.fitFrom } }
        : {}),
      ...(this.s.calibrationActivated ? { activated: true as const } : {}),
      ...(c.invalidSpans.length ? { invalidSpans: structuredClone(c.invalidSpans) } : {}),
      serial: c.serial ?? 0,
    };
    this.history.calibrations.push(decision);
    this.history.calibrations = this.history.calibrations.slice(-DECISIONS_KEPT);
    log("calibration:", JSON.stringify(decision));
    // Alerts go out in every mode: sustained-use and unknown limits, invalid readings, and a
    // latched rules mismatch. A lone lift-check mismatch is only logged.
    const alert = change.trigger === "limit-classified"
      ? change.inputs.class !== "credit"
      : ALERTS.has(change.trigger) &&
        (change.trigger !== "rules-mismatch" || !!change.inputs.latched);
    if (alert) this.notify(change.trigger);
  }
  // In apply, calibration fires when the settings in force change, and when learning changes the
  // learned ones even under a higher hold (#13 §6, step 7), whatever changed them: a decision, a
  // failed evaluation, a request. It compares what the last announcement showed with what the pass
  // ends with, so it fires once, and never for a change that changed nothing. Comparing each
  // decision with the one recorded before it fired at apply's first decision after shadow.
  private announceCalibration() {
    if (!this.applying) return;
    const now = { inForce: this.settings, learned: { ...this.calibration.applied } };
    const last = this.announced;
    this.announced = now;
    if (
      last && (!sameSettings(last.inForce, now.inForce) || !sameSettings(last.learned, now.learned))
    ) {
      this.notify("calibration");
    }
  }
  private recalibrate(now: number) {
    const c = this.calibrationCfg;
    if (this.diagnosticsInvalid) {
      this.diagnosticsInvalid = false;
      this.calibration.metricInvalid = true;
    }
    // Without a readings source nothing can go stale, so there is no fallback to hold.
    if (!this.cfg.hostinger?.vm_id) this.calibration.settledSeenAt = now;
    // The checkpoint records the history the evaluation used, bounded as the files will hold it.
    boundHistory(this.history, now);
    const h = this.settledHistory();
    // Include the open slot for tails, using exactly the precision persisted on slot closure.
    h.slots = withOpenSlot(h.slots, this.s.openSlot);
    const before = structuredClone(this.calibration);
    let result: Evaluation;
    try {
      result = updateCalibration(this.plan, h, this.calibration, c, now, this.s.balance);
    } catch (error) {
      // Classification needs only the limit records, so off's widen() gate and the sustained-use
      // cooldown still apply when the rest of calibration fails. evaluate() logs the failure.
      const classified = classifyLimits(this.plan, h, this.calibration, c, now);
      this.s.calibration = { ...classified.state, estimates: openEstimates(this.s.balance) };
      this.adoptLimitUpdates(classified.limits);
      for (const decision of classified.changes) this.recordDecision(decision, now);
      // The restore needs only the guest's own count, so it doesn't wait for the readings math.
      this.restoreAll(h, now);
      throw error;
    }
    this.history.checkpoint = {
      at: now,
      open: this.s.balance,
      config: c,
      before,
      history: recordedEvidence(h),
      digest: inputsDigest(result),
    };
    this.s.calibration = result.state;
    this.adoptLimitUpdates(result.limits);
    for (const decision of result.changes) this.recordDecision(decision, now);
    for (const pair of result.longPairs) {
      // Logged with its residuals against the fit; stored without them, as an input.
      const fit = this.calibration.fit;
      log(
        "long reading interval:",
        JSON.stringify(fit ? { ...pair, residual: longIntervalResidual(pair, fit) } : pair),
      );
      (this.history.longPairs ??= []).push(pair);
    }
    const open = this.s.balance;
    this.restoreAll(h, now);
    if (this.s.balance !== open) {
      this.calibration.estimates = calculateEstimates(
        this.plan,
        h,
        this.calibration,
        c,
        now,
        this.s.balance,
      );
    }
  }
  private adoptLimitUpdates(updates: Evaluation["limits"]) {
    for (const patch of updates) {
      const record = this.history.limits.find((r) => r.onset === patch.onset);
      if (!record) continue;
      Object.assign(record, patch);
      // Only the latest diagnosis keeps its inputs, which bounds the history file.
      if (patch.diagnosisEvidence) {
        for (const other of this.history.limits) {
          if (other !== record) delete other.diagnosisEvidence;
        }
      }
      if (patch.class) this.classified(record);
    }
  }
  // Off and shadow keep today's learning: a confirmed credit limit widens the legacy margin.
  private classified(record: LimitRecord) {
    log(`limit: classified ${record.class}`);
    if (
      record.class !== "credit" || !record.confirmed || !record.learn || record.legacyLearned ||
      this.applying
    ) return;
    const widened = widen(this.s.margin, record.balance, record.used);
    // A limit whose optimism widen() can't measure leaves the margin, and apply's start, alone.
    if (widened.mul !== this.s.margin.mul || widened.add !== this.s.margin.add) {
      this.s.margin = widened;
      this.s.marginLearned = true;
    }
    record.legacyLearned = true;
    record.legacyMargin = { ...this.s.margin };
    log(`limit: credit limit confirmed (margin x${this.s.margin.mul} +${this.s.margin.add})`);
  }
  private restoreAll(h: History, now: number) {
    for (const record of this.history.limits) {
      if (record.class === "sustained-use") this.restoreSustained(record, h, now);
    }
  }
  // Give back the open estimate the limit's reset hid, within a day of the lift and never during or
  // after a later limit, whose empty bank the replay would cross. It comes from the own count, so a
  // box without readings restores too; in apply the clamp still holds the acted estimate to them.
  private restoreSustained(record: LimitRecord, h: History, now: number) {
    if (
      record.restored || record.lift === undefined || this.s.limit ||
      now - record.lift > RESTORE_WINDOW_MS ||
      this.history.limits.some((r) => r.onset > record.onset)
    ) return;
    const balance = sustainedRestore(this.plan, h, record, this.calibration, now, this.settings);
    if (balance === null) return;
    log(
      `limit: sustained-use estimate restored to ${Math.round(Math.max(this.s.balance, balance))}`,
    );
    this.s.balance = Math.max(this.s.balance, balance);
    record.restored = true;
  }

  publicState(now: number): PublicState {
    const s = this.s;
    const p = this.plan;
    const recent = this.recent(STEAL_WINDOW_MS);
    const half = this.recent(CPU_WINDOW_MS);
    const control = this.controlSamples(STEAL_WINDOW_MS);
    const outside = avg(control.map((x) => x.outside ?? x.busy * p.vcpus));
    const users30: Record<string, number> = {};
    for (const x of half) {
      for (const [who, v] of Object.entries(x.users ?? {})) {
        users30[who] = (users30[who] ?? 0) + v / half.length;
      }
    }
    const busy5 = avg(recent.map((x) => x.busy));
    const delta = p.baseline - charged(busy5 * p.vcpus, this.settings);
    const pressing = s.limit &&
      demandSteal(avg(control.map((x) => x.busy)), avg(control.map((x) => x.steal))) >=
        LIMIT_PRESSING;
    return {
      schemaVersion: 1,
      updatedAt: now,
      bootId: s.bootId ?? null,
      uptime: s.uptime ?? null,
      plan: p,
      slice: this.slice,
      timezone: this.cfg.timezone ?? "UTC",
      credits: {
        balance: Math.round(this.actedBalance),
        percent: Math.round((100 * this.actedBalance) / p.capacity),
        minutesAtFull: Math.round(this.actedBalance / (p.vcpus - p.baseline) / 60),
        rate: Math.round(
          (pressing || s.noEarn || s.earning === false
            ? -charged(busy5 * p.vcpus, this.settings)
            : delta) * 10,
        ) / 10,
        margin: { mul: this.settings.mul, add: this.settings.add },
        law: this.law,
        calibration: this.calibrationStatus(),
        rebuilding: s.balance < this.law.floor * p.capacity ? s.rebuilding ?? null : null,
        anchor: s.anchor
          ? {
            checkedAt: s.anchor.checkedAt,
            exact: false,
            // Whether the readings lowered it. The hold while calibration fails lowers it too, and
            // shows as calibration.failing instead.
            applied: this.applying && this.calibration.estimates.acted < this.s.balance,
            difference: this.comparison,
          }
          : null,
      },
      ceiling: s.ceiling ?? 0,
      limit: s.limit ? publicLimit(s.limit) : null,
      cpu: {
        busy5,
        steal5: avg(recent.map((x) => x.steal)),
        busy30: avg(half.map((x) => x.busy)),
        users30,
        observedSeconds: half.reduce((sum, x) => sum + (x.seconds ?? 0), 0),
      },
      readings: s.readings,
      accepting: !s.limit && !s.capFailed,
      coverage: {
        outsideCores: outside,
        recoveryBlocked: !!s.limit && outside >= p.limit - 0.2,
      },
    };
  }

  // Hooks see the state after the pass has applied its quota, in the order events happened.
  private announced?: { inForce: Settings; learned: Settings };
  private saveDue = false;
  private notify(event: string) {
    this.events.push(event);
  }
  private dispatchEvents(now: number) {
    this.announceCalibration();
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
    return this.diagnostics?.close() ?? Promise.resolve();
  }

  enterLimit(now: number, learn: boolean, path: LimitRecord["path"] = "operator") {
    const s = this.s;
    const entry = { balance: s.balance, used: s.used, learn };
    let onset = now;
    let track = this.calibration.estimates.track;
    for (const sample of [...s.samples].reverse()) {
      if (sample.test || demandSteal(sample.busy, sample.steal) < LIMIT_STEAL) break;
      // Time the daemon didn't watch, or whose clock jumped, can't place an onset inside it.
      if (sample.unobserved || sample.clockValid === false) break;
      onset = sample.at - (sample.seconds ?? 0) * 1000;
      track = sample.track ?? null;
    }
    // Records are keyed by onset. An entry over the same run of steal as the previous record, such
    // as `limit on` right after a lift, starts after that record instead of sharing its onset.
    const previous = this.history.limits.at(-1);
    const after = Math.max(previous?.entry ?? -Infinity, previous?.lift ?? -Infinity);
    if (onset <= after) onset = after + 1;
    const control = this.controlMeasurements();
    // The first cap comes from the sample that showed the limit, pressing included: the 5-minute
    // window still holds samples from before it.
    const latest = s.samples.at(-1);
    const [busy, steal] = latest ? [latest.busy, latest.steal] : [control.busy, control.steal];
    const record: LimitRecord = {
      onset,
      // `limit on` in the pass that ran `limit off` starts just after that lift.
      entry: Math.max(now, onset),
      path,
      balance: entry.balance,
      used: entry.used,
      settings: { ...this.settings },
      gap: this.calibration.gap,
      ...(this.calibration.ownHold ? { heldGap: this.calibration.ownHold.gap } : {}),
      ...(this.actedBalance < entry.balance ? { acted: this.actedBalance } : {}),
      mode: this.calibrationCfg.mode,
      track,
      caps: [{
        at: now,
        busy: busy * this.plan.vcpus,
        demand: (busy + steal) * this.plan.vcpus,
        ceiling: s.ceiling ?? 0,
        pressing: demandSteal(busy, steal) >= LIMIT_PRESSING,
      }],
      confirmed: false,
      learn,
    };
    this.history.limits.push(record);
    this.history.limits = this.history.limits.slice(-LIMITS_KEPT);
    // This pass evaluates again, so explain and state.json agree on the emptied bank.
    this.recalibrateDue = true;
    s.balance = 0;
    this.calibration.estimates.acted = 0;
    s.used = 0;
    s.earning = false;
    // Under the limit with what runs outside the slice on top.
    const outside = avg(
      this.controlSamples(STEAL_WINDOW_MS).map((x) => x.outside ?? x.busy * this.plan.vcpus),
    );
    const ceiling = recoveryCeiling(this.plan, outside);
    s.limit = {
      since: now,
      ceiling,
      heldFrom: s.uptime ?? 0,
      startedAt: s.uptime ?? 0,
      entry,
      record,
      recovery: { seconds: 0, earningSeconds: 0, charged: 0 },
    };
  }

  // Passes closer together than this reuse the last full pass's measurements.
  private get minSampleMs() {
    return Math.min(MAX_MIN_SAMPLE_MS, (this.cfg.tick_seconds ?? DEFAULT_TICK_SECONDS) * 1000 / 2);
  }
  // A pass this soon after the last full one reuses its measurements and evaluates at its time.
  // Requests taken before the pass decide from the same clock reading as the pass: on the wall
  // clock, while the pass went by uptime, a slewed clock could stamp a reset after the evaluation
  // that followed it.
  private soonAfterLastPass({ uptime, bootId }: Clock) {
    const before = this.s.uptime;
    return this.s.bootId === bootId && before !== undefined && uptime >= before &&
      uptime - before < this.minSampleMs;
  }
  async request(path: string, clock: Clock) {
    // A request just after a full pass takes that pass's time: the closely spaced pass that follows
    // evaluates there, where the open slot ends, so nothing the request records is later than the
    // evaluation after it. A reset 3 seconds on otherwise outdated the checkpoint that replays it.
    const now = this.soonAfterLastPass(clock) ? this.s.at : clock.at;
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
    this.unwritten = true;
    if (r.action === "calibration-reset") {
      // Calibration returns to its configured start; off mode's legacy margin is kept (#13 §13).
      const from = effectiveSettings(this.calibration);
      // Limits that began before the reset cannot teach it: learning requires entry >= startedAt.
      const before = structuredClone(this.calibration);
      this.s.calibration = resetCalibration(this.calibrationCfg, before, now);
      this.calibration.estimates = openEstimates(this.s.balance);
      // Explain replays the reset from the state before it, like any evaluation.
      this.history.checkpoint = {
        action: "reset",
        at: now,
        open: this.s.balance,
        config: this.calibrationCfg,
        before,
        history: recordedEvidence(this.settledHistory()),
        digest: inputsDigest({ state: this.calibration, changes: [], limits: [], longPairs: [] }),
      };
      this.recordDecision({
        trigger: "reset",
        inputs: { at: now, start: this.calibrationCfg.start },
        from,
        to: effectiveSettings(this.calibration),
      }, now);
      // The reset reaches history at once, so a crash before the pass's save can't lose it, and
      // persist.json follows before the pass (takeRequests).
      this.writeHistory(now);
      this.saveDue = true;
    } else if (r.action === "limit-on") {
      // A limit already detected goes on, so its record still gets its lift and class.
      if (this.s.limit) log("limit: already limited");
      else this.enterLimit(now, false);
    } else if (r.action === "limit-off") {
      // `limit on` in this batch may have started its record just after an earlier lift, past now.
      const record = this.s.limit?.record;
      if (record) record.lift = Math.max(now, record.entry);
      this.s.limit = undefined;
      // Root explicitly confirms that Hostinger lifted the limit at its recovery point.
      this.s.balance = Math.max(this.s.balance, this.plan.recovered);
      this.calibration.estimates = openEstimates(this.s.balance);
      // Hostinger's bank is at its recovery point, a lower bound.
      this.operatorBase(this.plan.recovered, now);
      this.s.used = 0;
    } else if (r.action === "seed" && typeof r.balance === "number" && Number.isFinite(r.balance)) {
      this.s.balance = Math.min(Math.max(0, r.balance), this.plan.capacity);
      this.calibration.estimates = openEstimates(this.s.balance);
      this.operatorBase(this.s.balance, now);
      this.s.used = 0;
      if (this.s.limit) {
        this.s.limit.entry = undefined;
        // A confirmation already gathered stays valid; one still to come is not evidence.
        if (this.s.limit.record && !this.s.limit.record.confirmed) {
          this.s.limit.record.learn = false;
        }
      }
    } else return log("unknown request:", JSON.stringify(r));
    // The next pass evaluates again, so explain and the daemon agree on the new estimates.
    this.recalibrateDue = true;
    if (this.s.balance >= this.law.floor * this.plan.capacity) this.s.rebuilding = null;
    log("request:", JSON.stringify(r));
  }

  // The bank an operator's request states, which the clamp replays from until history holds a later
  // anchor.
  private operatorBase(balance: number, now: number) {
    const gap = this.calibration.gap;
    this.calibration.replayBase = { at: now, balance, exact: false, gap, origin: now };
  }

  private publishDiagnostics(readings: Reading[], now: number) {
    this.unwritten = true;
    try {
      mergeFetchReadings(this.history, readings, now);
      const recent = this.settledHistory().readings.filter((r) => r.at >= now - READINGS_KEEP_MS);
      this.s.readings = recent;
      // A pair is the guest's mean over its reading's interval, from the reading before it. A
      // reading a later fetch filled in between starts that interval later, so the pair goes, and
      // is computed again while the samples for it last: the first pair computed was kept for good.
      // Only the fetch's window can change.
      const previous = new Map(recent.slice(1).map((r, i) => [r.at, recent[i].at]));
      const paired = new Map(
        (this.history.meterPairs ?? [])
          .filter((x) => (previous.get(x.at) ?? x.from) === x.from)
          .map((x) => [x.at, x]),
      );
      for (const pair of pairSamples(this.plan, this.s.readings, this.s.samples)) {
        if (!paired.has(pair.at)) paired.set(pair.at, pair);
      }
      this.history.meterPairs = [...paired.values()].sort((a, b) => a.at - b.at);
      const r = replay(this.plan, this.s.readings);
      if (r) this.s.anchor = { ...r, exact: false, checkedAt: now };
      this.comparison = compareReadings(this.s.readings, this.s.samples);
      if (this.comparison !== null && Math.abs(this.comparison) > 5) {
        log(`API CPU differs from guest by ${this.comparison.toFixed(1)} percentage points`);
      }
      // A valid fetch clears only an invalid metric; an empty one shows nothing about it. Spacing and
      // residual checks clear themselves.
      if (readings.length) this.calibration.metricInvalid = false;
    } catch (error) {
      if (error instanceof InvalidReadingsError) this.diagnosticsInvalid = true;
      else throw error;
    }
    this.historyFetched = true;
  }

  // Demand under the limit for 20 seconds, then back: a limit's steal follows demand.
  async probe(sf0: number, ceiling: number): Promise<boolean> {
    this.s.noEarn = true;
    this.s.tested = true;
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
    this.liftEvidence = "unknown";
    const n = Math.min(this.plan.vcpus, Math.ceil(this.plan.limit) + 2);
    const burn: Pick<Deno.ChildProcess, "status" | "kill">[] = [];
    this.s.noEarn = true;
    this.s.tested = true;
    try {
      for (let i = 0; i < n; i++) {
        burn.push(this.io.burner());
      }
      await this.io.pause(5_000);
      const sample = await this.io.demand(25_000);
      const statuses = await Promise.all(burn.map((c) => c.status));
      if (!statuses.every((s) => s.code === 124)) return false;
      const busyCores = sample.busy * this.plan.vcpus;
      const gone = liftConfirmed(this.plan, n, busyCores, sample.steal);
      if (gone) this.liftEvidence = "lifted";
      else if (busyCores <= this.plan.limit + 0.1 && sample.steal >= LIFT_STEAL) {
        this.liftEvidence = "limited";
      }
      // The first test whose burners ran into the limit places the cap when no pressing cap row
      // does. One that passed measured the VM after the lift, not the cap. A failed one ran into
      // the limit if it found limited evidence or a later test still failed: after Hostinger's
      // lift, neighbours' steal alone fails a test, and its delivery read as a sustained-use cap.
      const record = this.s.limit?.record;
      if (!gone && record && record.testDelivery === undefined) {
        const delivery = { busy: busyCores, demand: busyCores / Math.max(0.001, 1 - sample.steal) };
        if (record.testCandidate) {
          record.testDelivery = record.testCandidate;
          delete record.testCandidate;
        } else if (this.liftEvidence === "limited") record.testDelivery = delivery;
        else record.testCandidate = delivery;
      }
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

  async tick(clock?: Clock) {
    this.unwritten = true;
    const read = clock ?? await this.io.clock();
    const { at: now, uptime, bootId } = read;
    const s = this.s;
    const p = this.plan;
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
      // Reuse stable measurements for closely spaced passes. Keep all accounting baselines so
      // the next sample includes the entire interval, including CPU consumed by these passes.
      // A request still evaluates, so the ceiling never acts on the estimates it replaced. It
      // evaluates at the last full pass, which the open slot reaches, or the clamp's tail falls short.
      if (this.recalibrateDue) {
        this.recalibrateDue = false;
        this.evaluate(() => this.recalibrate(s.at), now);
      }
      await this.applyCeiling(await this.io.ceiling(this.slice), this.controlMeasurements());
      this.dispatchEvents(now);
      return;
    }
    if (reset) {
      this.diagnostics?.reset();
      if (!prev && s.bootId === undefined) {
        // Limits from before a first start can't teach. A start that recovered calibration keeps
        // the recovered start, so the limits it was waiting on still teach.
        if (!this.recovered) this.calibration.startedAt = now;
        this.history.since = Math.min(this.history.since, now);
      }
      if (s.bootId !== undefined || prev) {
        s.balance = 0;
        s.rebuilding = { reason: s.bootId !== bootId ? "reboot" : "counter-reset", since: now };
      } else if (s.rebuilding) {
        s.rebuilding.since = now;
      }
      s.used = 0;
      s.noEarn = false;
      s.tested = false;
      s.earning = false;
      s.anchor = undefined;
      this.comparison = null;
      s.samples = [];
      if (s.openSlot) {
        // The slot stays open: a reboot shorter than a slot comes back inside it, and closing it here
        // would leave the next slot back with the same start, which reads as a clock step.
        s.openSlot.flags |= FLAGS.reboot;
      } else if (s.bootId !== undefined || prev) {
        // A slot had just closed: the first slot after the reboot carries the mark instead, so the
        // clamp still finds its empty-bank anchor. A first start has nothing to mark.
        s.rebootPending = true;
      }
      s.probe = { cooldownUntil: 0, backoffMs: BACKOFF_MS };
      s.topAt = undefined;
      if (s.limit) {
        s.limit.heldFrom = uptime;
        s.limit.startedAt = uptime;
        s.limit.testAt = 0;
        s.limit.testEvery = undefined;
        s.limit.entry = undefined;
        // The entry estimate is gone, but a confirmation already gathered stays valid.
        if (s.limit.record && !s.limit.record.confirmed) s.limit.record.learn = false;
        s.limit.recovery = { seconds: 0, earningSeconds: 0, charged: 0 };
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
      this.calibration.replayBase = null;
      this.calibration.estimates = openEstimates(s.balance);
      const target = this.targetCeiling(DEFAULT_OUTSIDE_CORES);
      s.capFailed = true;
      if (!await this.setQuota(target, true)) throw new Error("startup ceiling not set");
      s.capFailed = false;
      s.ceiling = target;
      // This pass evaluates the reset bank too, so explain agrees with state.json from now on; the
      // next pass evaluates again with the first sample back.
      this.evaluate(() => this.recalibrate(now), now);
      this.recalibrateDue = true;
      this.dispatchEvents(now);
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
      test: !!s.tested,
      limited: !!s.limit,
      track: this.calibration.estimates.track,
      // A pass that probed or tested the lift runs up to a minute longer, which the daemon watched.
      ...(seconds > 2 * (this.cfg.tick_seconds ?? DEFAULT_TICK_SECONDS) + (s.tested ? 60 : 0)
        ? { unobserved: true }
        : {}),
    };
    s.tested = false;
    s.samples = [...s.samples, sample].filter((x) => uptime - (x.uptime ?? -Infinity) <= KEEP_MS);
    if (
      (sample.busy >= HOT_BUSY || sample.steal >= HOT_STEAL) &&
      uptime - (s.topAt ?? -Infinity) >= TOP_EVERY_MS
    ) {
      s.topAt = uptime;
      await this.io.snapshot(`${this.paths.lib}/top`, now).catch((e) =>
        log("top snapshot failed:", e)
      );
    }

    const busyCores = sample.busy * p.vcpus;
    const observed = !sample.unobserved;
    const earning = observed && !s.noEarn &&
      !(s.limit && demandSteal(sample.busy, sample.steal) >= LIMIT_PRESSING);
    s.earning = earning;
    const beforeBalance = s.balance;
    const beforeActed = this.actedBalance;
    s.balance = creditStep(p, s.balance, busyCores, seconds, this.settings, earning);
    if (s.balance >= this.law.floor * p.capacity) s.rebuilding = null;
    const slotResult = accumulateSlot(s.openSlot, {
      from: beforeAt,
      to: now,
      seconds,
      busy: busyCores * seconds,
      steal: sample.steal * p.vcpus * seconds,
      managed: managed * seconds,
      outside: (sample.outside ?? 0) * seconds,
      charged: charged(busyCores, this.settings) * seconds,
      flags: (s.limit ? FLAGS.limited : 0) | (sample.test ? FLAGS.test : 0) |
        (demandSteal(sample.busy, sample.steal) >= LIMIT_PRESSING ? FLAGS.pressing : 0) |
        (sample.clockValid ? 0 : FLAGS.clockInvalid) | (earning ? 0 : FLAGS.noEarn) |
        (observed ? 0 : FLAGS.unobserved) | (s.rebootPending ? FLAGS.reboot : 0) |
        // A full open bank that stays full also keeps a full acted bank full.
        (beforeBalance >= p.capacity && s.balance >= p.capacity && beforeActed >= p.capacity
          ? FLAGS.atCapacity
          : 0),
    });
    s.openSlot = slotResult.open;
    addSlots(this.history, slotResult.closed);
    s.noEarn = false;
    s.rebootPending = undefined;
    s.used += charged(busyCores, this.settings) * seconds;
    if (s.limit) {
      const recovery = s.limit.recovery ??= { seconds: 0, earningSeconds: 0, charged: 0 };
      recovery.seconds += seconds;
      recovery.earningSeconds += earning ? seconds : 0;
      recovery.charged += charged(busyCores, this.settings) * seconds;
    }
    const control = this.controlMeasurements();
    const { count, busy, steal, outside } = control;
    const current = await this.io.ceiling(this.slice);

    const sfNow = demandSteal(busy, steal);
    // During a cooldown, probe again only if steal is evident or well above what the failed probe
    // saw: neighbours that failed a probe should not hide a limit that starts behind them.
    const failed = uptime < s.probe.cooldownUntil ? s.probe.failedSf : undefined;
    const jumped = failed !== undefined && sfNow >= Math.max(2 * failed, failed + 0.15);
    if (
      !s.limit && count >= 3 && sfNow >= LIMIT_STEAL &&
      steal * p.vcpus >= 0.02 &&
      (uptime >= s.probe.cooldownUntil || sfNow >= LIMIT_EVIDENT || jumped)
    ) {
      const sf0 = sfNow;
      if (sf0 >= LIMIT_EVIDENT || await this.probe(sf0, current ?? 100 * p.vcpus)) {
        this.enterLimit(now, true, sf0 >= LIMIT_EVIDENT ? "evident" : "probe");
        s.probe.backoffMs = BACKOFF_MS;
        s.probe.failedSf = undefined;
        log(`limit: start (margin x${this.settings.mul} +${this.settings.add})`);
        this.notify("limit-start");
      } else {
        s.probe.cooldownUntil = uptime + s.probe.backoffMs;
        s.probe.backoffMs = Math.min(s.probe.backoffMs * 2, BACKOFF_MAX_MS);
        s.probe.failedSf = sf0;
      }
    }

    const limit = s.limit;
    if (limit) {
      const record = limit.record;
      if (record && now - (record.caps.at(-1)?.at ?? 0) >= 1_800_000) {
        record.caps.push({
          at: now,
          busy: busy * p.vcpus,
          demand: (busy + steal) * p.vcpus,
          ceiling: limit.ceiling,
          pressing: sfNow >= LIMIT_PRESSING,
        });
      }
      limit.ceiling = Math.min(limit.ceiling, recoveryCeiling(p, outside));
      if (
        !sample.test && demandSteal(sample.busy, sample.steal) >= LIMIT_PRESSING &&
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
        let lifted = false;
        try {
          lifted = await this.limitGone();
        } catch (e) {
          this.liftEvidence = "unknown";
          log("lift test inconclusive:", e);
        }
        const finished = await this.io.clock();
        if (limit.record) {
          limit.record.firstTest ??= lifted ? "lifted" : this.liftEvidence;
          // As before calibration: any test during the limit that fails with limited evidence
          // confirms it; inconclusive tests neither confirm nor rule it out.
          if (!lifted && this.liftEvidence === "limited") limit.record.confirmed = true;
        }
        if (lifted) {
          if (limit.entry) {
            log("limit: first lift test passed; margin unchanged, no credits restored");
          }
          const recovery = limit.recovery;
          const net = recovery?.seconds
            ? (p.baseline * recovery.earningSeconds - recovery.charged) / recovery.seconds
            : 0;
          log(
            "recovery observation:",
            JSON.stringify({
              elapsedSeconds: Math.round(
                (Math.max(uptime, finished.uptime) - (limit.startedAt ?? uptime)) / 1000,
              ),
              idleMinimumSeconds: Math.round(p.recovered / p.baseline),
              estimatedRecoverySeconds: net > 0 ? Math.round(p.recovered / net) : null,
              estimatedPausedSeconds: recovery
                ? Math.round(recovery.seconds - recovery.earningSeconds)
                : null,
              baselineShare: p.baseline / p.vcpus,
            }),
          );
          if (limit.record) {
            const record = limit.record;
            record.lift = Math.max(now, finished.at);
            record.recovery = {
              elapsedSeconds: (Math.max(uptime, finished.uptime) - (limit.startedAt ?? uptime)) /
                1000,
              estimatedRecoverySeconds: net > 0 ? p.recovered / net : null,
              estimatedPausedSeconds: recovery ? recovery.seconds - recovery.earningSeconds : 0,
            };
            // Classify in this pass, before the ceiling can rise after a sustained-use limit.
            this.recalibrateDue = true;
          }
          s.limit = undefined;
          log("limit: lifted");
          this.notify("limit-end");
        } else {
          if (this.liftEvidence === "limited") {
            // The bank is still below Hostinger's lift point: an upper-bound anchor for learning.
            if (limit.record) limit.record.limitedAt = Math.max(now, finished.at);
            limit.entry = undefined;
          }
          limit.testEvery = Math.min(2 * (limit.testEvery ?? TEST_EVERY_MS / 2), TEST_MAX_MS);
          // Schedule from completion, not the sample taken before a 35-second test.
          limit.testAt = Math.max(uptime, finished.uptime) + limit.testEvery;
        }
      }
    }

    const fetched = this.historyFetched;
    this.historyFetched = false;
    if (fetched || slotResult.closed.length || this.diagnosticsInvalid || this.recalibrateDue) {
      this.recalibrateDue = false;
      this.evaluate(() => this.recalibrate(now), now);
    } else {
      this.evaluate(
        () => {
          this.calibration.estimates = this.calibration.replayBase
            ? calculateEstimates(
              p,
              this.tailHistory(),
              this.calibration,
              this.calibrationCfg,
              now,
              s.balance,
            )
            : openEstimates(s.balance);
        },
        now,
        false,
      );
    }
    if (
      fetched && this.calibrationCfg.mode !== "off"
    ) {
      log(
        "calibration estimates:",
        JSON.stringify({ at: now, ...this.calibration.estimates, cusum: this.calibration.cusum }),
      );
    }
    try {
      await this.applyCeiling(current, control);
      if (!s.limit) this.diagnostics?.refresh({ at: now, uptime });
    } finally {
      // Encoding history is the slowest part of a pass; it waits until the ceiling is set.
      this.writeHistory(now);
      this.dispatchEvents(now);
    }
  }

  private async applyCeiling(
    current: number | null,
    { busy, steal, outside }: ControlMeasurements,
  ) {
    const s = this.s;
    const target = this.targetCeiling(outside);
    s.capFailed = target !== current;
    if (target === current && this.wantedPeriod() === undefined) {
      s.ceiling = target;
      return;
    }
    if (await this.setQuota(target)) {
      s.capFailed = false;
      if (Math.abs(target - (s.ceiling ?? 0)) >= 100 || s.limit) {
        log(
          `ceiling ${target}%: ${Math.round(busy * 100)}% busy, ${
            Math.round(steal * 100)
          }% steal, ${Math.round((100 * this.actedBalance) / this.plan.capacity)}% credits`,
        );
      }
      s.ceiling = target;
    }
  }

  // The quota period the helper should get now: 10 ms while limited if the option is on, systemd's
  // default otherwise, or undefined when nothing needs to change. A default restores a period set
  // before the option was turned off. A period the helper rejected waits until the wanted one
  // changes or PERIOD_RETRY_MS passes.
  private wantedPeriod(startup = false): number | null | undefined {
    const configured = this.cfg.recovery?.quota_period_ms ?? null;
    const wanted = this.s.limit && configured ? configured : null;
    const rejected = this.periodRejected;
    if (
      rejected &&
      (wanted !== rejected.period || (this.s.uptime ?? 0) - rejected.uptime >= PERIOD_RETRY_MS)
    ) this.periodRejected = undefined;
    const active = this.s.quotaPeriod ?? null;
    // The service's fallback resets the period whenever it starts or stops the daemon, so the
    // daemon's first pass sends it again, as after a reboot.
    const send = startup || !this.periodSent
      ? configured !== null || active !== null
      : wanted !== active;
    return send && this.periodRejected === undefined ? wanted : undefined;
  }
  private async setQuota(target: number, startup = false): Promise<boolean> {
    const period = this.wantedPeriod(startup);
    if (period === undefined) return await this.io.cap(this.slice, target);
    if (await this.io.cap(this.slice, target, period)) {
      if (period === null) delete this.s.quotaPeriod;
      else this.s.quotaPeriod = period;
      this.periodSetHere = period !== null;
      this.periodSent = true;
      return true;
    }
    // A failed period change must not also withhold the quota.
    log(`quota period ${period ?? "default"} not set; setting the quota alone`);
    if (period === null && !this.periodSetHere) {
      // This run set no period, and the service's fallback reset any earlier one when it started
      // the daemon; a helper without the period argument never could set one. Asking again every
      // 15 minutes would help nothing.
      delete this.s.quotaPeriod;
      this.periodSent = true;
    } else {
      // A period this daemon set stays until restoring the default succeeds, so a transient
      // failure is retried after PERIOD_RETRY_MS rather than leaving 10 ms in place.
      this.periodRejected = { period, uptime: this.s.uptime ?? 0 };
    }
    return await this.io.cap(this.slice, target);
  }

  // The pass that follows takes the same clock reading (controlPass).
  async takeRequests(clock: Clock) {
    const now = clock.at;
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
    // Both files hold a reset before the pass after it, which can run a 45-second lift test: one
    // written to history alone left explain reading two different saves until then.
    if (this.saveDue) {
      this.saveDue = false;
      await this.save(now);
    }
  }

  async save(now: number) {
    // persist.json follows history, so a crash between the two leaves it behind history, never
    // ahead of it: the next start replays the newer checkpoint (#13 §1). A full pass wrote history
    // already; this covers one that returned early or threw, and a fetch since. History that failed
    // to write, or couldn't be read, is behind persist.json, which says so for the next start.
    if (this.unwritten) this.writeHistory(now);
    await this.closeHistory();
    if (this.historyStore && !this.historyStore.durable) this.s.historyBehind = true;
    if (this.persistWritable) await writeJson(`${this.paths.lib}/persist.json`, this.s, 0o600);
    delete this.s.historyBehind;
    await writeJson(`${this.paths.run}/state.json`, this.publicState(now), 0o644);
  }
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

// The start-up protocol in one place, so the daemon and every test or study that restarts one run the
// same steps: persist.json as it reads, what that rules out, then history. Copies of it in tests had
// drifted from the daemon's, so recovery bugs went untested.
export async function openGovernor(
  cfg: Config,
  plan: Plan,
  now: number,
  io: Partial<GovernorIO> = {},
  paths: Pick<typeof PATHS, "run" | "lib"> = PATHS,
): Promise<Governor> {
  const { saved, readable, invalid } = await readPersisted(`${paths.lib}/persist.json`);
  const g = new Governor(cfg, plan, saved, io, paths);
  g.persistWritable = readable;
  // State that exists but can't be read or parsed is lost state, not a first start:
  // initial_balance is for a new install only.
  g.stateInvalid = !!invalid || !readable;
  await g.loadHistory(now);
  return g;
}

// Only a missing persist.json is a lost one. One that doesn't parse is set aside and its calibration
// recovered from history; one this run can't read stays in place for the next run (#13 §1).
export async function readPersisted(
  path: string,
): Promise<{ saved?: Private; readable: boolean; invalid?: true }> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { readable: true };
    log(`persist.json unreadable, left in place and not written this run: ${error}`);
    return { readable: false };
  }
  try {
    return { saved: JSON.parse(text) ?? undefined, readable: true };
  } catch {
    log("persist.json invalid; set aside, recovering calibration from history");
    await Deno.rename(path, `${path}.bad-${Math.floor(Date.now() / 1000)}`).catch(() => {});
    await pruneQuarantine(path);
    return { readable: true, invalid: true };
  }
}

export async function runDaemon() {
  // Files root created would be root's, mode 0600, and the service could no longer read them.
  if (Deno.uid() === 0) throw new Error("governor run must run as the governor user");
  const cfg = await loadConfig();
  const p = await detectPlan(cfg);
  // One daemon at a time: two would append the same history sequence numbers.
  const lock = await Deno.open(`${PATHS.lib}/daemon.lock`, {
    create: true,
    write: true,
    mode: 0o600,
  });
  if (!await lock.tryLock(true)) {
    lock.close();
    throw new Error("another governor run is active");
  }
  const g = await openGovernor(cfg, p, Date.now());
  log(
    `governor up: ${p.name}, baseline ${p.baseline} vCPU, capacity ${p.capacity} core-seconds, ${
      Math.round((100 * g.s.balance) / p.capacity)
    }% credits`,
  );
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
    await g.closeHistory();
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
    // Undo a 10 ms recovery period the daemon may have left. systemd before 242 has no such
    // property, so this is best effort and never decides the result.
    if (out.success) {
      await run(["set-property", "--runtime", "user.slice", "CPUQuotaPeriodSec="]).catch(() => {});
    }
    return out.success;
  });
  const applied = await cap(ceiling);
  log(`fallback ceiling ${ceiling}%`, applied ? "set" : "failed");
  if (!applied) throw new Error("could not apply fallback CPU quota");
}
