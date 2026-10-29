// Deterministic calibration. No API, clock, filesystem or random source enters these functions.
import {
  type Anchor,
  MARGIN,
  type Margin,
  MAX_SPACING_MS,
  type Reading,
  validSpacing,
  widen,
} from "./credits.ts";
import type { Plan } from "./plans.ts";
import {
  COVERAGE,
  covered,
  DAY,
  finite,
  firstIndex,
  FLAGS,
  type History,
  type LimitClass,
  type LimitRecord,
  newestFinal,
  type Settings,
  type Slot,
  SLOT_MS,
  validFit,
  validPending,
  validSettings,
} from "./history.ts";

export type CalibrationMode = "off" | "shadow" | "apply";
export const CALIBRATION = {
  mode: "off" as CalibrationMode,
  start: { mul: 1.05, add: 0.04, floor: 0.05 },
  gap_start: 0,
  premium_ref: 0.0348,
  sigma_ref: [0.0214, 0.0119] as [number, number],
  floor_max: 0.10,
  gap_max: 0.2,
  fit: { days: 14, min_pairs: 48, min_cores: 3, min_days: 3 },
  cusum: { k: 0.5, h: 10, verify_readings: 48, verify_z: 0.5 },
  clamp: { enabled: true, tolerance: 0.025 },
  learning: {
    onset_margin_s: 300,
    eta_sigmas: 3,
    hold_sigmas: 2,
    plausible_extra: 0.02,
    confirm_days: 7,
  },
  stale: { pause_s: 7200, fallback_s: 86400 },
  sustained_cooldown_s: 10800,
};
export type CalibrationConfig = typeof CALIBRATION;
export type CalibrationOptions =
  & Partial<Omit<CalibrationConfig, "start" | "fit" | "cusum" | "clamp" | "learning" | "stale">>
  & {
    [K in "start" | "fit" | "cusum" | "clamp" | "learning" | "stale"]?: Partial<
      CalibrationConfig[K]
    >;
  };
export function calibrationConfig(options: CalibrationOptions = {}): CalibrationConfig {
  return {
    ...CALIBRATION,
    ...options,
    start: { ...CALIBRATION.start, ...options.start },
    fit: { ...CALIBRATION.fit, ...options.fit },
    cusum: { ...CALIBRATION.cusum, ...options.cusum },
    clamp: { ...CALIBRATION.clamp, ...options.clamp },
    learning: { ...CALIBRATION.learning, ...options.learning },
    stale: { ...CALIBRATION.stale, ...options.stale },
  };
}
export function validateCalibration(options: CalibrationOptions = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("calibration must be an object");
  }
  // A misspelt key would otherwise leave its default in force without a word.
  const known = (path: string, value: object, defaults: object) => {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(defaults, key)) {
        throw new Error(`calibration${path}.${key} is not a setting`);
      }
    }
  };
  known("", options, CALIBRATION);
  for (const k of ["start", "fit", "cusum", "clamp", "learning", "stale"] as const) {
    if (
      options[k] !== undefined &&
      (!options[k] || typeof options[k] !== "object" || Array.isArray(options[k]))
    ) throw new Error(`calibration.${k} must be an object`);
    if (options[k]) known(`.${k}`, options[k], CALIBRATION[k]);
  }
  const c = calibrationConfig(options);
  const range = (name: string, value: number, lo: number, hi: number, integer = false) => {
    if (
      typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi ||
      (integer && !Number.isSafeInteger(value))
    ) {
      throw new Error(
        lo === Number.MIN_VALUE
          ? `calibration.${name} must be above 0 and at most ${hi}`
          : `calibration.${name} must be from ${lo} to ${hi}`,
      );
    }
  };
  if (!["off", "shadow", "apply"].includes(c.mode)) {
    throw new Error("calibration.mode must be off, shadow or apply");
  }
  range("start.mul", c.start.mul, 1, 1.3);
  range("start.add", c.start.add, 0, 0.5);
  range("start.floor", c.start.floor, 0, 0.25);
  range("floor_max", c.floor_max, 0, 0.25);
  if (c.start.floor > c.floor_max) {
    throw new Error(`calibration.start.floor must be at most floor_max, ${c.floor_max}`);
  }
  range("gap_max", c.gap_max, 0.0001, 1);
  range("gap_start", c.gap_start, 0, c.gap_max);
  range("premium_ref", c.premium_ref, 0, 1);
  if (!Array.isArray(c.sigma_ref) || c.sigma_ref.length !== 2) {
    throw new Error("calibration.sigma_ref must contain two coefficients");
  }
  for (const v of c.sigma_ref) range("sigma_ref", v, 0, 1);
  if (c.sigma_ref[0] + c.sigma_ref[1] <= 0) {
    throw new Error("calibration.sigma_ref must be positive");
  }
  range("fit.days", c.fit.days, 1, 90);
  range("fit.min_pairs", c.fit.min_pairs, 2, 10000, true);
  range("fit.min_cores", c.fit.min_cores, 0, 128);
  range("fit.min_days", c.fit.min_days, 1, 90, true);
  for (const [k, v] of Object.entries(c.cusum)) {
    range(`cusum.${k}`, v, Number.MIN_VALUE, 10000, k === "verify_readings");
  }
  if (typeof c.clamp.enabled !== "boolean") {
    throw new Error("calibration.clamp.enabled must be boolean");
  }
  range("clamp.tolerance", c.clamp.tolerance, 0, 0.25);
  // An allowance of 0 is meaningful: none.
  range("learning.onset_margin_s", c.learning.onset_margin_s, 0, 3600);
  range("learning.eta_sigmas", c.learning.eta_sigmas, 0, 10);
  range("learning.hold_sigmas", c.learning.hold_sigmas, 0, 10);
  range("learning.plausible_extra", c.learning.plausible_extra, 0, 1);
  // History keeps 90 days.
  range("learning.confirm_days", c.learning.confirm_days, Number.MIN_VALUE, 90);
  for (const [k, v] of Object.entries(c.stale)) {
    range(`stale.${k}`, v, Number.MIN_VALUE, 30 * 86400);
  }
  if (c.stale.fallback_s < c.stale.pause_s) {
    throw new Error("calibration stale fallback must follow pause");
  }
  range("sustained_cooldown_s", c.sustained_cooldown_s, Number.MIN_VALUE, 30 * 86400);
}
// A reading at the 100% cap is `capped`: it only bounds the meter from below.
export type Pair = { at: number; own: number; host: number; capped?: true };
export type MeterFit = {
  a: number;
  b: number;
  aHi: number;
  sigma: [number, number];
  // The least noise at any load: what the light-load pairs show, when there are enough of them.
  sigmaFloor?: number;
  pairs: number;
  days: number;
};
// Box A's no-limit bound: billing more than 0.167 cores above its readings would have emptied its
// bank. It starts the daily bound and caps what counts as a plausible gap.
export const GAP_BOUND = 0.167;
// Bootstrap resamples use a fixed seed, so a fit is a pure function of its pairs.
export const FIT_SEED = 13;
// Limit classification (#13 §5). Hostinger states that sustained use loses 25% of vCPUs per hour;
// the 20% threshold leaves room for caps sampled every 30 minutes.
const CAP_BAND = 0.3, LOW_CAP_SPREAD = 0.6, EPSILON = 1e-7;
const SUSTAINED_HIGH = 0.45, SUSTAINED_FALL_PER_HOUR = 0.2;
// Gap learning (#13 §6): the own-count fallback moves the gap at most 0.01 cores per event, and is
// used once bridged time exceeds a tenth of the span.
const OWN_STEP = 0.01, SUSPECT_MATCH = 0.02, BRIDGE_SHARE = 0.1;
// How closely a limit's own-count rise must match the readings' residual to corroborate them.
const CORROBORATION = 0.5;
// Within CORROBORATION of each other, either way: neither may exceed the other by more than half.
const agree = (a: number, b: number) => Math.max(a, b) <= (1 + CORROBORATION) * Math.min(a, b);
// Pairs after a drift change before their mean residual can raise its hold.
const REFINE_PAIRS = 3;
// Readings are percentages rounded to 0.01; 100% is the cap.
const AT_CAP = 100 - 0.005;
// The lift check (#13 §7). Readings for a recovery can still arrive while the API's 48-hour window
// covers it.
// A recovery slower than predicted by more than LIFT_RATIO is a mismatch. A faster one is not
// observable, so the prediction looks only as far as LIFT_HORIZON of the actual recovery.
const LIFT_RATIO = 1.5, LIFT_HORIZON = 0.7, MISMATCHES = 2;
export const MISMATCH_WINDOW_MS = 30 * DAY;
const LIFT_RETRY_MS = 2 * DAY;
// Residuals beyond 6 sigma three times in a row invalidate readings; three normal ones clear it.
const EXTREME_Z = 6, EXTREME_READINGS = 3, CLEAN_READINGS = 3;
// Light-load pairs a fit needs before their spread bounds its idle noise from below.
const LIGHT_PAIRS = 10;
// A capped reading's residual is a lower bound: beyond 6 sigma it is still extreme, below it says
// nothing, neither clean nor drift.
const censored = (pair: Pair, z: number) => !!pair.capped && z <= EXTREME_Z;
// Intervals longer than 2,700 seconds but at most 6 hours are long readings, not outages.
const LONG_INTERVAL_MAX_MS = 6 * 3_600_000, LAST_HALF_HOUR_MS = 1_800_000;
const FULL_SLOT_S = SLOT_MS / 1000 * (1 - COVERAGE);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const bounded = (b: number, p: Plan) => Math.max(0, Math.min(p.capacity, b));
function overlap(s: Slot, start: number, end: number) {
  return Math.max(0, Math.min(s.at + SLOT_MS, end) - Math.max(s.at, start)) / SLOT_MS;
}
export const firstSlot = (slots: Slot[], at: number) =>
  firstIndex(slots, (s) => s.at + SLOT_MS <= at);
// The guest's mean busy cores over (from, to] from slots, or null without 99% coverage or with a
// limited, test, reboot, invalid-clock or unobserved slot.
function slotMean(slots: Slot[], from: number, to: number): number | null {
  let seconds = 0, busy = 0;
  for (let j = firstSlot(slots, from); j < slots.length && slots[j].at < to; j++) {
    const s = slots[j], fraction = overlap(s, from, to);
    if (!fraction) continue;
    if (
      s.flags & (FLAGS.limited | FLAGS.test | FLAGS.clockInvalid | FLAGS.reboot | FLAGS.unobserved)
    ) {
      return null;
    }
    seconds += s.seconds * fraction;
    busy += s.busy * fraction;
  }
  return covered(seconds, (to - from) / 1000) ? busy / seconds : null;
}
export function pairReadings(
  p: Plan,
  readings: Reading[],
  slots: Slot[],
  exact?: History["meterPairs"],
): Pair[] {
  const pairs: Pair[] = [];
  const measured = new Map((exact ?? []).map((r) => [r.at, r]));
  for (let i = 1; i < readings.length; i++) {
    const start = readings[i - 1].at, end = readings[i].at;
    if (!validSpacing(start, end)) continue;
    const own = slotMean(slots, start, end);
    if (own === null) continue;
    // Readings that settle after the two-hour sample buffer moved on still pair from slots.
    const observation = measured.get(end);
    const exactMean = observation?.from === start &&
      covered(observation.seconds, (end - start) / 1000);
    pairs.push({
      at: end,
      own: exactMean ? observation.own : own,
      host: readings[i].v / 100 * p.vcpus,
      ...(readings[i].v >= AT_CAP ? { capped: true as const } : {}),
    });
  }
  return pairs;
}
type Sample = {
  at: number;
  seconds?: number;
  busy: number;
  clockValid?: boolean;
  test?: boolean;
  limited?: boolean;
  unobserved?: boolean;
};
// Each local sample's overlap with (from, to], in milliseconds.
export function eachSampleOverlap(
  samples: Sample[],
  from: number,
  to: number,
  visit: (sample: Sample, ms: number) => void,
) {
  for (const sample of samples) {
    if (!sample.seconds) continue;
    const ms = Math.max(
      0,
      Math.min(to, sample.at) - Math.max(from, sample.at - sample.seconds * 1000),
    );
    if (ms) visit(sample, ms);
  }
}
// A ten-minute slot cannot recover a job transition inside a reading's boundary. Capture exact
// interval means while the two-hour local sample buffer still covers them, and retain those inputs.
export function pairSamples(
  p: Plan,
  readings: Reading[],
  samples: Sample[],
): NonNullable<History["meterPairs"]> {
  const observations: NonNullable<History["meterPairs"]> = [];
  const oldest = samples[0] ? samples[0].at - (samples[0].seconds ?? 0) * 1000 : Infinity;
  for (let i = 1; i < readings.length; i++) {
    const from = readings[i - 1].at, at = readings[i].at;
    if (from < oldest || !validSpacing(from, at)) continue;
    let seconds = 0, busy = 0, invalid = false;
    eachSampleOverlap(samples, from, at, (sample, ms) => {
      invalid ||= sample.clockValid === false || !!sample.test || !!sample.limited ||
        !!sample.unobserved;
      seconds += ms / 1000;
      busy += ms / 1000 * sample.busy * p.vcpus;
    });
    const duration = (at - from) / 1000;
    if (!invalid && covered(seconds, duration)) {
      observations.push({ at, from, own: busy / seconds, seconds });
    }
  }
  return observations;
}
// Readings after an interval longer than 2,700 seconds stay out of replays until data shows what
// they average over. Each is paired with the guest's mean over its whole interval and over its last
// 30 minutes; their residuals against the fit tell the two apart.
export type LongPair = { at: number; from: number; host: number; own: number; ownLast: number };
export function pairLongIntervals(
  p: Plan,
  readings: Reading[],
  slots: Slot[],
  after: number,
): LongPair[] {
  const pairs: LongPair[] = [];
  for (let i = Math.max(1, firstIndex(readings, (r) => r.at <= after)); i < readings.length; i++) {
    const from = readings[i - 1].at, at = readings[i].at;
    if (at - from <= MAX_SPACING_MS || at - from > LONG_INTERVAL_MAX_MS) continue;
    const own = slotMean(slots, from, at), ownLast = slotMean(slots, at - LAST_HALF_HOUR_MS, at);
    if (own === null || ownLast === null) continue;
    pairs.push({ at, from, host: readings[i].v / 100 * p.vcpus, own, ownLast });
  }
  return pairs;
}

function regression(xs: number[], ys: number[]): [number, number] | null {
  const x = mean(xs), y = mean(ys);
  let xx = 0, xy = 0;
  for (let i = 0; i < xs.length; i++) {
    xx += (xs[i] - x) ** 2;
    xy += (xs[i] - x) * (ys[i] - y);
  }
  if (xx < 1e-12) return null;
  const a = xy / xx;
  return [a, y - a * x];
}
// Numerical Recipes' LCG: a portable, fixed sequence for bootstrap resampling and the simulators.
export function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(1664525, value) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
function qualifies(pairs: Pair[], config: CalibrationConfig["fit"]): boolean {
  const high = pairs.filter((r) => r.own >= config.min_cores);
  return high.length >= config.min_pairs &&
    new Set(high.map((r) => Math.floor(r.at / DAY))).size >= config.min_days;
}
export function fitMeter(
  pairs: Pair[],
  config = CALIBRATION.fit,
  seed = FIT_SEED,
  now = pairs.at(-1)?.at ?? 0,
): MeterFit | null {
  if (!pairs.length) return null;
  const since = pairs.at(-1)!.at - config.days * DAY;
  const selected = pairs.filter((r) => r.at >= since);
  const qualifying = selected.filter((r) => r.own >= config.min_cores);
  const days = new Set(qualifying.map((r) => Math.floor(r.at / DAY))).size;
  if (qualifying.length < config.min_pairs || days < config.min_days) return null;
  const xs = selected.map((r) => r.own), ys = selected.map((r) => r.host);
  const fit = regression(xs, ys);
  if (!fit || fit[0] <= 0) return null;
  const [a, b] = fit;
  const groups = new Map<number, Pair[]>();
  for (const r of selected) {
    const d = Math.floor(r.at / DAY);
    const group = groups.get(d) ?? [];
    group.push(r);
    groups.set(d, group);
  }
  // Do not repeatedly resample the two points of an unfinished UTC day as if they were an
  // entire day. That gives a nearly singular tiny group a 3.7% chance of dominating a 3-day fit.
  // A day counts once it is whole or holds its share of the qualifying pairs, and the bound needs
  // two of them: resampling a single day gives no day-to-day spread, so aHi would equal a.
  // A day without a qualifying pair carries no slope. Resampling idle weekend days made draws of
  // mostly idle days, whose slope set aHi as high as 1.233 against an a of 1.04.
  const perDay = Math.ceil(config.min_pairs / config.min_days);
  const completeDays = [...groups].filter(([day, rs]) => {
    const high = rs.filter((r) => r.own >= config.min_cores).length;
    return high >= perDay ||
      high > 0 && day < Math.floor(now / DAY) && rs[0].at <= day * DAY + 2_700_000;
  }).map(([, rs]) => rs);
  if (completeDays.length < Math.min(2, config.min_days)) return null;
  const wholeDays = completeDays.map((rs) => ({
    n: rs.length,
    x: rs.reduce((n, r) => n + r.own, 0),
    y: rs.reduce((n, r) => n + r.host, 0),
    xx: rs.reduce((n, r) => n + r.own * r.own, 0),
    xy: rs.reduce((n, r) => n + r.own * r.host, 0),
  }));
  const random = seeded(seed), slopes: number[] = [];
  for (let i = 0; i < 1000; i++) {
    let n = 0, x = 0, y = 0, xx = 0, xy = 0;
    for (let j = 0; j < wholeDays.length; j++) {
      const d = wholeDays[Math.floor(random() * wholeDays.length)];
      n += d.n;
      x += d.x;
      y += d.y;
      xx += d.xx;
      xy += d.xy;
    }
    if (xx - x * x / n > 1e-12) slopes.push((xy - x * y / n) / (xx - x * x / n));
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const absolute = xs.map((x, i) => Math.abs(ys[i] - (a * x + b)));
  const noise = regression(xs, absolute) ?? [0, mean(absolute)];
  // The line through |residual| can reach zero at the idle end when busy pairs spread more, and
  // then every ordinary idle residual counts as extreme. The noise is never below what the
  // light-load pairs show; above them the line rises past it, so the premium doesn't change.
  const light = absolute.filter((_, i) => xs[i] < config.min_cores);
  return {
    a,
    b,
    aHi: Math.max(a, slopes[Math.ceil(0.975 * slopes.length) - 1]),
    sigma: [
      Math.max(1e-6, Math.sqrt(Math.PI / 2) * noise[1]),
      Math.max(0, Math.sqrt(Math.PI / 2) * noise[0]),
    ],
    ...(light.length >= LIGHT_PAIRS ? { sigmaFloor: Math.sqrt(Math.PI / 2) * mean(light) } : {}),
    pairs: selected.length,
    days,
  };
}
export const sigmaAt = (fit: MeterFit, u: number) =>
  Math.max(1e-6, fit.sigmaFloor ?? 0, fit.sigma[0] + fit.sigma[1] * u);
const referenceSigma = (c: CalibrationConfig, u: number) =>
  Math.max(1e-6, c.sigma_ref[0] + c.sigma_ref[1] * u);
export function marginFromFit(
  p: Plan,
  fit: MeterFit,
  gap: number,
  previous: Settings,
  c = CALIBRATION,
): Settings {
  // Up to the next 0.001, never down; an exact thousandth stays, whatever floating point does.
  const mul = Math.max(c.start.mul, Math.ceil(fit.aHi * 1000 - 1e-9) / 1000);
  let add = previous.add;
  for (let i = 0; i < 3; i++) {
    const u = Math.max(0, (p.baseline - add) / mul);
    const premium = c.premium_ref * sigmaAt(fit, u) / referenceSigma(c, u);
    add = p.baseline - mul * (p.baseline - fit.b - gap - premium) / fit.a;
  }
  return {
    mul: Math.max(previous.mul, mul),
    add: Math.max(previous.add, c.start.add, add),
    floor: Math.max(previous.floor, c.start.floor),
  };
}
// Without a qualifying fit, the configured start stands for a zero gap on the reference meter. Each
// core of learned gap then costs mul/a of addition; mul bounds that while the slope is at least 1.
export function marginWithoutFit(c: CalibrationConfig, gap: number, previous: Settings): Settings {
  return { ...previous, add: Math.max(previous.add, c.start.add + gap * previous.mul) };
}
// `since` is the first pair of the run since the sum last left zero: an alarm's change point.
export type Cusum = {
  s: number;
  down: number;
  residual: number;
  own: number;
  alarm: boolean;
  since?: number;
};
export const emptyCusum = (): Cusum => ({ s: 0, down: 0, residual: 0, own: 0, alarm: false });
export function cusumStep(state: Cusum, pair: Pair, fit: MeterFit, c = CALIBRATION.cusum): Cusum {
  const residual = pair.host - fit.a * pair.own - fit.b;
  const z = residual / sigmaAt(fit, pair.own);
  const s = Math.max(0, state.s + z - c.k);
  return {
    s,
    down: Math.max(0, state.down - z - c.k),
    residual: s ? state.residual + residual : 0,
    own: s ? state.own + pair.own : 0,
    alarm: s > c.h,
    ...(s ? { since: state.s ? state.since ?? pair.at : pair.at } : {}),
  };
}
// The smallest gap in [0, 1] cores, to 1e-4, at which `empties` holds, and the largest at which it
// does not.
function bisect(empties: (gap: number) => boolean, top = 1): { lo: number; hi: number } {
  let lo = 0, hi = top;
  while (hi - lo > 0.0001) {
    const mid = (lo + hi) / 2;
    if (empties(mid)) hi = mid;
    else lo = mid;
  }
  return { lo, hi };
}
// The share of a slot the governor's own estimate didn't earn. Slots from before quiet seconds were
// kept count whole, and so does the clamp, a lower bound, for a limited slot.
function quietShare(slot: Slot, wholeSlots = false): number {
  if (!(slot.flags & FLAGS.noEarn)) return 0;
  if (slot.quiet === undefined || wholeSlots && slot.flags & FLAGS.limited) return 1;
  return Math.min(1, slot.quiet / Math.max(1, slot.seconds));
}
// The share of a slot's time Hostinger earned nothing: pressing on the limit while limited. A lift
// test presses for 30 seconds of its slot, so a slot earns for the rest. The clamp, a lower bound,
// takes a limited slot that pressed at all as pressing throughout (`wholeSlots`), as does a slot
// recorded without pressing seconds.
function pressingShare(slot: Slot, wholeSlots = false): number {
  if (!(slot.flags & FLAGS.limited)) return 0;
  if (wholeSlots || slot.pressed === undefined) return slot.flags & FLAGS.pressing ? 1 : 0;
  return Math.min(1, slot.pressed / Math.max(1, slot.seconds));
}
export type ReplayResult = {
  at: number;
  balance: number;
  complete: boolean;
  firstZero: number | null;
  charged: number;
  // Time, and the guest's busy core-seconds in it, that the readings could not place: inside the
  // reading that covers `to`, and across bridged gaps.
  estimated: { seconds: number; busy: number };
  bridged: number;
  trace?: { at: number; balance: number }[];
};
// How a replay crosses an interval outside 900-2,700 seconds, or time no reading covers. The clamp
// bills the guest's count at the settings in force, like the tail after the newest reading; gap
// learning bills Hostinger's fitted relation plus the gap under test.
// A corroboration bills its rise on top of the fit only from `rise.from`, where the readings turned
// extreme: gaps before that crossed the old meter.
export type Bridge = { margin: Margin } | { fit: MeterFit; rise?: { from: number; by: number } };
export type ReplayOptions = {
  gap?: number;
  to?: number;
  trace?: boolean;
  // Bisection only asks whether the bank empties; it can stop there.
  untilZero?: boolean;
  bridge?: Bridge;
  // Readings drift detection marked invalid, bridged like any other gap.
  invalid?: InvalidSpan[];
  // Bridge the time after the last reading up to `to` as well. Gap learning never does: settled
  // readings that do not reach t_lo send it to the own-count fallback (#13 §6, step 3).
  bridgeTail?: boolean;
  // The clamp's lower bound: a limited slot that pressed at all earns nothing.
  wholeSlots?: boolean;
};
// Readings at `from` or later, and before `to`, are invalid. `to` stays null while they still are.
// `applied` and `gap` are the learned state when the span opened: a corroborated change refits
// against them.
export type InvalidSpan = { from: number; to: number | null; applied?: Settings; gap?: number };
const inSpan = (spans: InvalidSpan[] | undefined, at: number) =>
  !!spans?.some((x) => at >= x.from && (x.to === null || at < x.to));
// Readings are already settled. Without a bridge, a gap ends the replay; missing guest coverage,
// a reboot or an invalid clock always does.
export function replaySettled(
  p: Plan,
  readings: Reading[],
  slots: Slot[],
  anchor: Anchor,
  options: ReplayOptions = {},
): ReplayResult {
  const { gap = 0, to = readings.at(-1)?.at ?? anchor.at, trace = false, untilZero = false } =
    options;
  const bridge = options.bridge;
  let balance = anchor.balance, at = anchor.at, firstZero: number | null = null, cost = 0;
  let bridged = 0;
  const estimated = { seconds: 0, busy: 0 };
  const points: { at: number; balance: number }[] | undefined = trace ? [] : undefined;
  const result = (): ReplayResult => ({
    at,
    balance,
    complete: at >= to,
    firstZero,
    charged: cost,
    estimated,
    bridged,
    ...(points ? { trace: points } : {}),
  });
  // Slot pieces of (start, end], or null where local coverage is missing or untrustworthy.
  const piecesOf = (start: number, end: number) => {
    const pieces: { slot: Slot; seconds: number; busy: number }[] = [];
    for (let j = firstSlot(slots, start); j < slots.length && slots[j].at < end; j++) {
      const s = slots[j], fraction = overlap(s, start, end);
      if (!fraction) continue;
      if (s.flags & (FLAGS.clockInvalid | FLAGS.reboot)) return null;
      pieces.push({ slot: s, seconds: s.seconds * fraction, busy: s.busy * fraction });
    }
    return covered(pieces.reduce((n, s) => n + s.seconds, 0), (end - start) / 1000) ? pieces : null;
  };
  type Piece = { slot: Slot; seconds: number; busy: number };
  // Steps the bank across the pieces of (start, end] inside the replay. `bill` receives each piece,
  // the seconds replayed and their share of the piece. Returns false once the replay can stop.
  const step = (
    start: number,
    end: number,
    pieces: Piece[],
    bill: (piece: Piece, seconds: number, share: number) => number,
    estimate: boolean,
    earnUnlessNoEarn = false,
  ) => {
    for (const piece of pieces) {
      const lo = Math.max(start, piece.slot.at, at),
        hi = Math.min(end, piece.slot.at + SLOT_MS, to);
      if (hi <= lo) continue;
      const s = (hi - lo) / 1000;
      const share = s / (Math.min(end, piece.slot.at + SLOT_MS) / 1000 -
        Math.max(start, piece.slot.at) / 1000);
      const billed = bill(piece, s, share);
      const earning = 1 - Math.max(
        earnUnlessNoEarn ? quietShare(piece.slot, options.wholeSlots) : 0,
        pressingShare(piece.slot, options.wholeSlots),
      );
      const delta = p.baseline * s * earning - billed;
      if (firstZero === null && delta < 0 && balance + delta <= 0) {
        firstZero = lo + balance / -delta * (hi - lo);
        if (untilZero) return false;
      }
      balance = bounded(balance + delta, p);
      cost += billed;
      at = hi;
      points?.push({ at, balance });
      if (estimate) {
        estimated.seconds += s;
        estimated.busy += piece.busy * share;
      }
    }
    return true;
  };
  const bridgeSpan = (start: number, end: number): boolean => {
    const rise = bridge && "fit" in bridge ? bridge.rise : undefined;
    if (rise && start < rise.from && rise.from < end) {
      return bridgeSpan(start, rise.from) && at >= rise.from && bridgeSpan(rise.from, end);
    }
    const pieces = bridge ? piecesOf(start, end) : null;
    if (!bridge || !pieces) return false;
    const before = at;
    const extra = rise && start >= rise.from ? rise.by : 0;
    const ok = "fit" in bridge
      ? step(
        start,
        end,
        pieces,
        (piece, s, share) => bridge.fit.a * piece.busy * share + (bridge.fit.b + gap + extra) * s,
        true,
      )
      : step(
        start,
        end,
        pieces,
        (piece, s, share) => bridge.margin.mul * piece.busy * share + bridge.margin.add * s,
        true,
        true,
      );
    bridged += (at - before) / 1000;
    return ok;
  };
  const lo = Math.max(1, firstIndex(readings, (r) => r.at <= anchor.at));
  for (let i = lo; i < readings.length && at < to; i++) {
    const start = readings[i - 1].at, end = readings[i].at;
    if (end <= at) continue;
    // Time before this reading's interval that no reading covers.
    if (start > at && (!bridgeSpan(at, start) || at < start)) return result();
    if (!validSpacing(start, end) || inSpan(options.invalid, end)) {
      if (!bridgeSpan(start, end) || at < Math.min(end, to)) return result();
      continue;
    }
    const pieces = piecesOf(start, end);
    if (!pieces) return result();
    const seconds = (end - start) / 1000, observed = pieces.reduce((n, s) => n + s.seconds, 0);
    const busy = pieces.reduce((n, s) => n + s.busy, 0);
    const readingCharge = readings[i].v / 100 * p.vcpus * seconds;
    const ok = step(start, end, pieces, (piece, s, share) => {
      const weight = busy > 0 ? piece.busy / busy : piece.seconds / observed;
      return readingCharge * weight * share + gap * s;
    }, to < end);
    if (!ok) return result();
  }
  if (options.bridgeTail && at < to) bridgeSpan(at, to);
  return result();
}
export function replayOwn(
  p: Plan,
  slots: Slot[],
  anchor: Anchor,
  margin: Margin | null,
  to: number,
  extra = 0,
  // Hostinger's earning rule alone: slots the governor kept from earning in its own estimate, such
  // as lift tests, still earn.
  hostinger = false,
  wholeSlots = false,
): Omit<ReplayResult, "estimated" | "bridged"> {
  let balance = anchor.balance, at = anchor.at, firstZero: number | null = null, cost = 0;
  for (let i = firstSlot(slots, anchor.at); i < slots.length; i++) {
    const slot = slots[i];
    const lo = Math.max(at, slot.at), hi = Math.min(slot.at + SLOT_MS, to);
    if (hi <= lo) continue;
    if (
      slot.at > at || slot.seconds < (hi - slot.at) / 1000 * (1 - COVERAGE) ||
      (slot.flags & (FLAGS.clockInvalid | FLAGS.reboot))
    ) {
      break;
    }
    const seconds = (hi - lo) / 1000, fraction = seconds / Math.max(1, slot.seconds);
    const billed = margin
      ? margin.mul * slot.busy * fraction + (margin.add + extra) * seconds
      : slot.charged * fraction + extra * seconds;
    const earning = 1 -
      Math.max(hostinger ? 0 : quietShare(slot, wholeSlots), pressingShare(slot, wholeSlots));
    const delta = p.baseline * seconds * earning - billed;
    if (firstZero === null && delta < 0 && balance + delta <= 0) {
      firstZero = lo + balance / -delta * (hi - lo);
    }
    balance = bounded(balance + delta, p);
    at = hi;
    cost += billed;
  }
  return { balance, at, firstZero, complete: at >= to, charged: cost };
}
// Across consecutive slots at capacity, a lower bound for the bank earns the baseline and pays the
// governor's charge plus the gap's upper bound. Slots that pay more lower it too, so the bank is
// certified full only while that bound itself sits at capacity.
export function certifiedAnchors(p: Plan, slots: Slot[], upper: number): Anchor[] {
  let bound = 0, end = -Infinity;
  const anchors: Anchor[] = [];
  for (const s of slots) {
    const full = (s.flags & FLAGS.atCapacity) && s.seconds >= FULL_SLOT_S &&
      !(s.flags & (FLAGS.noEarn | FLAGS.clockInvalid | FLAGS.reboot | FLAGS.pressing));
    const spare = p.baseline * s.seconds - s.charged - upper * s.seconds;
    // A missing slot, or any slot below capacity, starts a new run.
    bound = full ? Math.max(0, Math.min(p.capacity, (s.at === end ? bound : 0) + spare)) : 0;
    end = s.at + SLOT_MS;
    if (bound >= p.capacity) anchors.push({ at: end, balance: p.capacity, exact: true });
  }
  return anchors;
}
// A lift test runs up to 15 minutes after Hostinger lifts a limit at 20% of capacity. The detected
// lift is a lower bound for the bank at that moment; the last test that still found the limit, also
// taken at 20%, is an upper bound. Gap learning uses the upper bound so it never under-learns; the
// clamp and restores use the lower bound so they never overstate the bank.
export type AnchorSide = "low" | "high";
// After a reboot the open estimate restarts from an empty bank; so can the clamp, from the first
// reading that local samples cover again. An empty bank is a lower bound, never a learning anchor.
function rebootAnchors(h: History): Anchor[] {
  const anchors: Anchor[] = [];
  for (let i = 0; i + 1 < h.slots.length; i++) {
    if (!(h.slots[i].flags & FLAGS.reboot)) continue;
    // The first slot back usually starts partway through, so coverage resumes at the next whole one.
    let k = i + 1;
    while (
      k < h.slots.length &&
      (h.slots[k].flags & (FLAGS.reboot | FLAGS.clockInvalid) ||
        !covered(h.slots[k].seconds, SLOT_MS / 1000))
    ) k++;
    if (k === h.slots.length) continue;
    const resumed = h.slots[k].at;
    const reading = h.readings[firstIndex(h.readings, (r) => r.at < resumed)];
    if (reading) anchors.push({ at: reading.at, balance: 0, exact: false });
  }
  return anchors;
}
export function historyAnchors(
  p: Plan,
  h: History,
  upper: number,
  side: AnchorSide = "low",
): Anchor[] {
  return [
    ...certifiedAnchors(p, h.slots, upper),
    ...(side === "low" ? rebootAnchors(h) : []),
    ...h.limits.flatMap((l): Anchor[] =>
      l.class === "credit"
        ? [
          { at: l.onset, balance: 0, exact: true },
          ...(l.lift !== undefined
            ? [{
              at: side === "high" ? l.limitedAt ?? l.lift : l.lift,
              balance: p.recovered,
              exact: true,
            }]
            : []),
        ]
        : []
    ),
  ].sort((a, b) => a.at - b.at);
}
export type GapDiagnosis = {
  gap: number | null;
  source: "readings" | "own" | "unavailable";
  anchor: Anchor | null;
  onset: number;
  eta: number;
  explained: boolean;
  left: number | null;
  // No gap up to a whole core empties the replayed bank by t_lo: the pinned rules cannot explain it.
  beyond?: boolean;
  // Seconds of the span bridged with the fit.
  bridged?: number;
  // The uncapped own-count result of a repeat credit limit while readings were invalid or stale:
  // a gap for the temporary hold only. `gap` stays the capped step that learning may keep.
  held?: number;
  // The central gap from the lower-bound anchor, which the mismatch tests use.
  lower?: number;
};
export type DiagnosisOptions = {
  // The anchor recorded with the diagnosis, in place of the history's.
  anchor?: Anchor | null;
  useReadings?: boolean;
  invalid?: InvalidSpan[];
  // A second confirmed credit limit within confirm_days while readings are invalid or stale: the
  // full own-count result goes to the temporary hold (#13 §6, step 3).
  fullOwnStep?: boolean;
};
// Bisection on the readings replay, bridged across gaps with the fit (#13 §6). Without usable
// readings, or once bridging covers more than a tenth of the span, it root-finds on the guest's own
// charges instead.
// A limit flags the slot it entered in from that slot's start, but the bank earned there until the
// limit began. Replays that end before a limit read its entry slot as unlimited.
function beforeLimit(slots: Slot[], record: LimitRecord): Slot[] {
  const i = firstSlot(slots, record.entry), slot = slots[i];
  if (!slot || slot.at > record.entry || !(slot.flags & FLAGS.limited)) return slots;
  return slots.with(i, { ...slot, flags: slot.flags & ~FLAGS.limited });
}
// A lift anchor puts the bank at Hostinger's lift point, so that limit is over from there, but the
// governor flags its slots limited until it detects the lift. Learning's replays from a lift read
// them as unlimited; the clamp, a lower bound, keeps them.
function afterLift(slots: Slot[], limits: LimitRecord[], anchor: Anchor): Slot[] {
  const record = limits.find((l) =>
    l.class === "credit" && l.lift !== undefined &&
    (anchor.at === l.lift || anchor.at === l.limitedAt)
  );
  if (!record) return slots;
  let out = slots;
  const last = firstSlot(slots, record.lift!);
  for (let i = firstSlot(slots, anchor.at); i <= last && i < slots.length; i++) {
    if (!(slots[i].flags & FLAGS.limited)) continue;
    if (out === slots) out = slots.slice();
    out[i] = { ...slots[i], flags: slots[i].flags & ~FLAGS.limited };
  }
  return out;
}
// The lower-bound anchor of a span that starts at a credit limit: its detected lift, where the bank
// held at least the recovery level.
function liftAnchor(p: Plan, h: History, anchor: Anchor, onset: number): Anchor | null {
  const lifted = h.limits.find((l) =>
    l.class === "credit" && l.limitedAt === anchor.at && l.lift !== undefined && l.lift < onset
  );
  return lifted ? { at: lifted.lift!, balance: p.recovered, exact: true } : null;
}
export function diagnoseGap(
  p: Plan,
  h: History,
  record: LimitRecord,
  c: CalibrationConfig,
  upper: number,
  fit: MeterFit | null,
  options: DiagnosisOptions = {},
): GapDiagnosis {
  const { useReadings = true, invalid = [], fullOwnStep = false } = options;
  const onset = record.onset - c.learning.onset_margin_s * 1000;
  const anchor = options.anchor === undefined
    ? historyAnchors(p, h, upper, "high").findLast((a) => a.at < onset) ?? null
    : options.anchor;
  const unavailable: GapDiagnosis = {
    gap: null,
    source: "unavailable",
    anchor,
    onset,
    eta: 0,
    explained: false,
    left: null,
  };
  if (!anchor) return unavailable;
  const duration = (onset - anchor.at) / 1000;
  const bridge = fit ? { fit } : undefined;
  const slots = afterLift(beforeLimit(h.slots, record), h.limits, anchor);
  const zero = useReadings
    ? replaySettled(p, h.readings, slots, anchor, { to: onset, bridge, invalid })
    : null;
  const source = zero?.complete && zero.bridged <= BRIDGE_SHARE * duration ? "readings" : "own";
  const replay = (gap: number, untilZero = true, to = onset) =>
    source === "readings"
      ? replaySettled(p, h.readings, slots, anchor, { gap, to, untilZero, bridge, invalid })
      : replayOwn(p, slots, anchor, null, to, gap, true);
  const base = source === "readings" ? zero! : replay(0, false);
  if (!base.complete) return unavailable;
  const bridged = source === "readings" ? zero!.bridged : 0;
  if (base.firstZero !== null) {
    return { ...unavailable, gap: record.gap, source, explained: true, left: 0, bridged };
  }
  // Each purpose takes its cautious anchor. Learning and holds start from the upper bound, so the
  // box tightens enough. The mismatch check starts from the detected lift, whose bank is a lower
  // bound: only a gap beyond a whole core even from there is a mismatch.
  const low = liftAnchor(p, h, anchor, onset);
  const lowSlots = low ? afterLift(beforeLimit(h.slots, record), h.limits, low) : [];
  // The mismatch tests, all three, take the central estimate from the cautious anchor, without any
  // allowance, to the recorded onset, the latest plausible one, so a mismatch needs even the
  // smallest gap to break the rules. Bisected to t_lo, five minutes earlier, a repeat limit an hour
  // after a lift read 0.366 cores for a true 0.18, past gap_max, and the whole-core test read a
  // 1-core meter jump as 1.024 cores, where to the onset it is 0.975. A replay cut short after t_lo,
  // by a reboot, still reaches t_lo.
  const to = record.onset;
  const breaks = (gap: number) =>
    (!low
      ? replay(gap, true, to)
      : source === "readings"
      ? replaySettled(p, h.readings, lowSlots, low, { gap, to, untilZero: true, bridge, invalid })
      : replayOwn(p, lowSlots, low, null, to, gap, true)).firstZero !== null;
  if (!breaks(1)) {
    return {
      ...unavailable,
      gap: 1,
      source,
      beyond: true,
      left: base.balance,
      bridged,
    };
  }
  const { hi } = replay(1).firstZero === null
    ? { hi: 1 }
    : bisect((gap) => replay(gap).firstZero !== null);
  const lower = breaks(0) ? 0 : bisect(breaks).hi;

  // Estimated time, inside the reading at t_lo and across bridged gaps, raises the gap by eta_sigmas
  // of the meter's noise at the guest's load in it; the reference noise stands in before a fit
  // qualifies. A full own-count step estimates the whole span, for the temporary hold alone, which
  // takes hold_sigmas.
  const full = source === "own" && fullOwnStep;
  const estimated = source === "readings"
    ? zero!.estimated
    : full
    ? { seconds: duration, busy: busyBetween(slots, anchor.at, onset) }
    : { seconds: 0, busy: 0 };
  const u = estimated.seconds ? estimated.busy / estimated.seconds : 0;
  const sigma = fit ? sigmaAt(fit, u) : referenceSigma(c, u);
  const eta = (full ? c.learning.hold_sigmas : c.learning.eta_sigmas) * sigma * estimated.seconds;
  const gap = source === "readings" ? hi + eta / duration : record.gap + Math.min(OWN_STEP, hi);
  return {
    gap,
    source,
    anchor,
    onset,
    eta,
    explained: false,
    left: base.balance,
    bridged,
    // Charges at entry already reflected any hold, so the full step builds on its gap.
    ...(full ? { held: (record.heldGap ?? record.gap) + hi + eta / duration } : {}),
    lower,
  };
}
// The guest's busy core-seconds in slots over (from, to].
function busyBetween(slots: Slot[], from: number, to: number): number {
  let busy = 0;
  for (let j = firstSlot(slots, from); j < slots.length && slots[j].at < to; j++) {
    busy += slots[j].busy * overlap(slots[j], from, to);
  }
  return busy;
}
// Keep the exact meter and slot span used by a diagnosis. Later revisions and clock changes may
// alter retained history, but explain can still rerun this decision from its original inputs.
export function diagnosisEvidence(
  h: History,
  c: CalibrationConfig,
  upper: number,
  fit: MeterFit | null,
  diagnosis: GapDiagnosis,
  options: Required<Omit<DiagnosisOptions, "anchor">>,
): NonNullable<LimitRecord["diagnosisEvidence"]> {
  const { useReadings: readingsUsable, invalid, fullOwnStep } = options;
  const anchor = diagnosis.anchor;
  if (!anchor) {
    return {
      config: structuredClone(c),
      upper,
      fit: structuredClone(fit),
      anchor,
      readings: [],
      slots: [],
      readingsUsable,
      invalid: [],
      fullOwnStep,
    };
  }
  let first = 0;
  while (first + 1 < h.readings.length && h.readings[first + 1].at <= anchor.at) first++;
  // Through the recorded onset, which the mismatch tests replay to, past t_lo.
  const until = diagnosis.onset + c.learning.onset_margin_s * 1000;
  let last = first;
  while (last + 1 < h.readings.length && h.readings[last].at < until) last++;
  const end = Math.max(until, h.readings[last]?.at ?? until);
  const begin = Math.min(anchor.at, h.readings[first]?.at ?? anchor.at);
  // The earlier limit a replay from its lift reads (afterLift, liftAnchor): the 50 records history
  // keeps can drop it before this diagnosis is rerun.
  const limits = h.limits.filter((l) =>
    l.lift !== undefined && (l.lift === anchor.at || l.limitedAt === anchor.at)
  ).map(({ diagnosisEvidence: _, ...l }) => l);
  return structuredClone({
    config: c,
    upper,
    fit,
    anchor,
    readings: h.readings.slice(first, last + 1),
    slots: h.slots.slice(firstSlot(h.slots, begin), firstSlot(h.slots, end) + 1),
    limits,
    readingsUsable,
    invalid: invalid.filter((x) => x.from <= end && (x.to === null || x.to > begin))
      .map(({ from, to }) => ({ from, to })),
    fullOwnStep,
  });
}

// Pressing makes earning under Hostinger's 33% rule unpredictable. Pressing until the governor first
// holds the slice below the limit is expected; pressing after recovery has begun is not. Lift tests
// press deliberately.
function pressedDuringRecovery(slots: Slot[], record: LimitRecord): boolean {
  let recovering = false;
  for (let i = firstSlot(slots, record.entry); i < slots.length; i++) {
    const s = slots[i];
    if (s.at >= record.lift!) break;
    if (s.flags & FLAGS.test) continue;
    if (!(s.flags & FLAGS.pressing)) recovering = true;
    else if (recovering) return true;
  }
  return false;
}
// Seconds from onset until the readings replay, from an empty bank plus the learned gap, reaches
// Hostinger's lift point. Past the lift the readings carry the load the lift released, so the replay
// goes no further than the longest prediction the actual recovery could still match, nor past the
// next limit's onset; null when it does not reach the lift point by then. `complete` is false while
// settled readings do not yet reach that end.
export function predictRecovery(
  p: Plan,
  h: History,
  record: LimitRecord,
  gap: number,
  fit: MeterFit | null = null,
  invalid: InvalidSpan[] = [],
): { predicted: number | null; pressing: boolean; complete: boolean } {
  if (pressedDuringRecovery(h.slots, record)) {
    return { predicted: null, pressing: true, complete: true };
  }
  const next = h.limits.reduce(
    (end, l) => l.onset > record.onset ? Math.min(end, l.onset) : end,
    Infinity,
  );
  const to = Math.min(record.onset + (record.lift! - record.onset) / LIFT_HORIZON, next);
  const result = replaySettled(p, h.readings, h.slots, {
    at: record.onset,
    balance: 0,
    exact: true,
  }, {
    gap,
    to,
    trace: true,
    invalid,
    ...(fit ? { bridge: { fit } } : {}),
  });
  let previous = { at: record.onset, balance: 0 };
  for (const point of result.trace ?? []) {
    if (point.balance >= p.recovered) {
      const time = previous.at +
        (p.recovered - previous.balance) / Math.max(1e-9, point.balance - previous.balance) *
          (point.at - previous.at);
      return { predicted: (time - record.onset) / 1000, pressing: false, complete: true };
    }
    previous = point;
  }
  return { predicted: null, pressing: false, complete: result.complete };
}

// Cap rows recorded while steal showed the slice pressing on the limit, by at least the credit band:
// delivery within 0.3 cores of demand measures the demand, not Hostinger's cap, and a slice the
// governor holds low can still see steal. Without any, the burner delivery of the first lift test
// whose burners ran stands in for the cap.
function caps(record: LimitRecord) {
  const pressing = record.caps.filter((x) => x.pressing && x.demand - x.busy >= CAP_BAND - EPSILON);
  return pressing.length
    ? pressing
    : record.testDelivery
    ? [{ at: record.entry, busy: record.testDelivery.busy }]
    : [];
}
// A credit limit holds the VM flat at the plan's limit share ("band"). A flat cap below that fits a
// credit limit under harsher rules than the pinned ones ("low").
export function creditCap(p: Plan, record: LimitRecord): "band" | "low" | null {
  const busy = caps(record).map((x) => x.busy);
  if (!busy.length) return null;
  if (busy.every((b) => Math.abs(b - p.limit) <= CAP_BAND + EPSILON)) return "band";
  return busy.every((b) => b <= p.limit + CAP_BAND + EPSILON) &&
      Math.max(...busy) - Math.min(...busy) <= LOW_CAP_SPREAD + EPSILON
    ? "low"
    : null;
}
// Decided once, at the lift, from every cap the limit recorded. Learning also needs the existing
// confirmation: a lift test during the limit failed with limited evidence. Readings never change the
// class; a gap they cannot explain is a rules mismatch instead (updateCalibration).
export function classifyLimit(p: Plan, record: LimitRecord): LimitClass {
  const rows = caps(record);
  // High means above the credit band as well: on KVM 1, 45% of vCPUs is 0.45 cores, inside the band
  // of 0.4 plus or minus 0.3.
  const first = rows[0]?.busy ?? 0;
  const high = first >= SUSTAINED_HIGH * p.vcpus && first > p.limit + CAP_BAND + EPSILON;
  // The steepest decline between any two caps at least 30 minutes apart, so a fast drop that
  // then holds still counts. On small plans 20% an hour is 0.1 or 0.2 cores between rows, inside
  // a flat cap's noise, so the decline must also leave the credit band's width.
  let falling = false;
  for (let i = 0; i < rows.length && !falling; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const hours = (rows[j].at - rows[i].at) / 3_600_000;
      if (hours < 0.5) continue;
      const fall = Math.max(SUSTAINED_FALL_PER_HOUR * p.vcpus * hours, CAP_BAND + EPSILON);
      if (rows[i].busy - rows[j].busy >= fall) {
        falling = true;
        break;
      }
    }
  }
  if (high || falling) return "sustained-use";
  return record.confirmed && creditCap(p, record) ? "credit" : "unknown";
}
// The open estimate a sustained-use limit's reset hid: the pre-entry estimate advanced over the limit
// with the normal earning rule on the own count, then carried to now. Readings don't bound it: they
// stay diagnostic in off and shadow, and in apply the clamp holds the acted estimate to them.
export function sustainedRestore(
  p: Plan,
  h: History,
  record: LimitRecord,
  s: CalibrationState,
  now: number,
  // The settings the open estimate uses now: calibration's in apply, the legacy margin otherwise.
  current: Margin = effectiveSettings(s),
): number | null {
  if (record.lift === undefined) return null;
  const restored = replayOwn(
    p,
    h.slots,
    { at: record.entry, balance: record.balance, exact: false },
    record.settings,
    record.lift,
  );
  if (!restored.complete) return null;
  // From the lift on, the settings in force now, as the open estimate has used.
  const tail = replayOwn(
    p,
    h.slots,
    { at: record.lift, balance: restored.balance, exact: false },
    current,
    now,
  );
  return tail.complete ? tail.balance : null;
}

export type CalibrationState = {
  // Learned settings; they only tighten until an operator reset or the fit after a drift change.
  applied: Settings;
  gap: number;
  gapUpperBound: number;
  fit: MeterFit | null;
  cusum: Cusum;
  // A drift change (#13 §8): a CUSUM alarm awaiting verification, or a verified or corroborated
  // change waiting for a fit on the readings after `at`. `fit` is the meter in force meanwhile and
  // `hold` the settings it gives. Both are temporary: the learned settings change only once a fit
  // on the readings after the change qualifies.
  // `residual` and `n` sum the pairs since the change against `oldFit`, which refine its size.
  // `from` and `gapFrom` are the learned margin and gap before the change: the fit after it
  // tightens only against them, so nothing the change taught meanwhile is counted twice.
  pending: {
    at: number;
    from: Settings;
    gapFrom: number;
    oldFit: MeterFit;
    fit: MeterFit;
    hold: Settings;
    readings: number;
    z: number;
    verified: boolean;
    residual: number;
    n: number;
  } | null;
  lastPaired: number;
  lastSettled: number | null;
  // When the newest settled reading first appeared. Staleness counts from here, not from the
  // reading's own timestamp, which is already 30 to 90 minutes old when it settles.
  settledSeenAt: number;
  apiStaleSince: number | null;
  // The 1.05x + 0.08 fallback while readings stay stale or invalid; it ends when they resume.
  hold: { since: number; reason: "stale" | "invalid" } | null;
  // The full own-count step of a repeat credit limit while readings are invalid or stale, as a gap
  // and the settings it gives. Temporary like the hold: it ends when readings resume.
  // `central` is the gap the limits measured without the allowance for estimated time.
  ownHold: { gap: number; settings: Settings; central?: number } | null;
  invalid: boolean;
  metricInvalid: boolean;
  residualInvalid: boolean;
  extreme: number;
  cleanReadings: number;
  // The first reading of the current run of extreme residuals, and of normal ones while invalid.
  extremeFrom: number | null;
  cleanFrom: number | null;
  // Readings that three extreme residuals marked invalid, until three normal ones arrived. Replays
  // bridge them as gaps; at most the last span is open, and only while residuals are invalid.
  invalidSpans: InvalidSpan[];
  // The end of the last long reading interval paired.
  longPairedAt: number;
  startedAt: number;
  evaluatedAt: number;
  // Counts evaluations and resets, so a start can tell which of persist.json and history is newer
  // without trusting the wall clock.
  serial?: number;
  boundAt: number;
  fitAt?: number;
  // The last drift change point. Refits never reach back past it, so no window mixes the meter
  // from before a change with the meter after it. `fitFrom` is the learned margin from before it.
  fitSince?: number;
  fitFrom?: Settings;
  rulesMismatch: boolean;
  // Lift times of recent lift-check mismatches.
  mismatches: number[];
  suspects: { at: number; gap: number }[];
  pendingLimits: number[];
  cooldownUntil: number;
  // The floor before limits raised it while readings couldn't be used. Readings a limit or the
  // own-count hold corroborates show a meter change that explains those raises, and the floor
  // returns here; readings that resume normal make them stay.
  provisionalFloor?: number | null;
  // The clamp's settled base at the newest reading, and the tracking estimate's: across reading gaps
  // the clamp bills the settings in force, tracking the fitted meter without the premium (#13 §11).
  // Where the clamp's replay reached; `origin` is the anchor it grew from, or the time of the
  // operator's seed or `limit off` that set it.
  replayBase?: (Anchor & { gap: number; track?: number; origin?: number }) | null;
  estimates: { open: number; clamp: number | null; track: number | null; acted: number };
};
export function initialCalibration(
  c: CalibrationConfig,
  now: number,
  inherited?: Margin,
): CalibrationState {
  const start = {
    ...c.start,
    ...(inherited
      ? { mul: Math.max(c.start.mul, inherited.mul), add: Math.max(c.start.add, inherited.add) }
      : {}),
  };
  return {
    applied: marginWithoutFit(c, c.gap_start, start),
    gap: c.gap_start,
    gapUpperBound: GAP_BOUND,
    fit: null,
    cusum: emptyCusum(),
    pending: null,
    lastPaired: 0,
    lastSettled: null,
    settledSeenAt: now,
    apiStaleSince: null,
    hold: null,
    ownHold: null,
    invalid: false,
    metricInvalid: false,
    residualInvalid: false,
    extreme: 0,
    cleanReadings: 0,
    extremeFrom: null,
    cleanFrom: null,
    invalidSpans: [],
    longPairedAt: 0,
    startedAt: now,
    evaluatedAt: now,
    boundAt: 0,
    rulesMismatch: false,
    mismatches: [],
    suspects: [],
    pendingLimits: [],
    cooldownUntil: 0,
    estimates: { open: 0, clamp: null, track: null, acted: 0 },
  };
}
// An operator reset returns the learned state to the configured start: margin, floor, gap, fit and
// drift detection, and the rules-mismatch latch. Limits from before it cannot teach it. What the
// readings and limits are doing right now stays: staleness, invalid readings, both holds and any
// sustained-use cooldown.
// The first switch to apply resets the same way, from the margin a confirmed limit widened if any.
export function resetCalibration(
  c: CalibrationConfig,
  previous: CalibrationState,
  now: number,
  inherited?: Margin,
): CalibrationState {
  const start = initialCalibration(c, now, inherited);
  // The meter's change point stays: it is a fact about the meter, not a learned setting, and a refit
  // reaching back past it would mix the meters from before and after the change (#13 §3).
  const { fitAt: _at, fitFrom: _from, ...kept } = structuredClone(previous);
  // A verified drift change is a change point too, though no fit after it has qualified yet. The
  // reset drops its hold, but the next fit must not mix the meters on either side of it.
  const changed = previous.pending?.verified ? previous.pending.at : undefined;
  // A residual alarm was judged against the fit the reset drops, and nothing could end it without
  // one. It ends here; the readings it marked stay out of fits and replays, and the next fit judges
  // new readings again. Staleness, an invalid metric or spacing, and the holds stay until the next
  // evaluation finds the readings usable.
  const open = kept.invalidSpans.find((x) => x.to === null);
  return {
    ...kept,
    ...(changed !== undefined ? { fitSince: Math.max(kept.fitSince ?? -Infinity, changed) } : {}),
    ...(open
      ? {
        residualInvalid: false,
        invalidSpans: kept.invalidSpans.map((x) => x === open ? { from: x.from, to: now } : x),
      }
      : {}),
    extreme: 0,
    extremeFrom: null,
    cleanReadings: 0,
    cleanFrom: null,
    applied: start.applied,
    gap: start.gap,
    gapUpperBound: start.gapUpperBound,
    boundAt: start.boundAt,
    fit: null,
    cusum: start.cusum,
    pending: null,
    rulesMismatch: false,
    mismatches: [],
    suspects: [],
    pendingLimits: [],
    provisionalFloor: null,
    startedAt: now,
    serial: (previous.serial ?? 0) + 1,
    // The clamp's replay base stays. With an anchor in history the next evaluation replays from it
    // with the start's gap; without one, the base carries the bank as replayed so far, and the
    // replay bills the start's gap from there on, rather than the clamp turning off.
  };
}
// No clamp or tracking estimate yet: the governor acts on its own estimate.
export const openEstimates = (balance: number): CalibrationState["estimates"] => ({
  open: balance,
  clamp: null,
  track: null,
  acted: balance,
});
// The latest evaluation history recorded, rerun from its inputs. Null unless its digest verifies,
// so explain and recovery only ever use an evaluation the daemon really made.
export function replayCheckpoint(
  p: Plan,
  checkpoint: NonNullable<History["checkpoint"]>,
): Evaluation | null {
  const replayed: Evaluation = checkpoint.action === "reset"
    ? {
      state: {
        ...resetCalibration(checkpoint.config, checkpoint.before, checkpoint.at),
        estimates: openEstimates(checkpoint.open),
      },
      changes: [],
      limits: [],
      longPairs: [],
    }
    : updateCalibration(
      p,
      checkpoint.history,
      checkpoint.before,
      checkpoint.config,
      checkpoint.at,
      checkpoint.open,
    );
  return inputsDigest(replayed) === checkpoint.digest ? replayed : null;
}
// The configured start bounds the learned settings from below (#13 §4), so a tighter start, a higher
// gap_start or a raised start floor takes effect at once; the saved state only adds to it.
export function withStart(p: Plan, c: CalibrationConfig, s: CalibrationState): CalibrationState {
  const gap = Math.max(s.gap, c.gap_start), lower = maxSettings(s.applied, c.start);
  const next = s.fit ? marginFromFit(p, s.fit, gap, lower, c) : marginWithoutFit(c, gap, lower);
  // marginFromFit iterates from the margin it's given, so a margin it set itself can come back
  // differing in the last digits; only a real rise counts.
  const raised = gap > s.gap || next.mul > s.applied.mul || next.floor > s.applied.floor ||
    next.add > s.applied.add + 1e-6;
  return raised ? { ...s, gap, applied: maxSettings(s.applied, next) } : s;
}
// Persisted state comes from disk. Anything malformed restarts calibration from the configured start.
export function validCalibrationState(s: unknown): s is CalibrationState {
  const v = s as CalibrationState;
  if (!v || typeof v !== "object") return false;
  const e = v.estimates, cusum = v.cusum, base = v.replayBase;
  return validSettings(v.applied) &&
    finite(
      v.gap,
      v.gapUpperBound,
      v.lastPaired,
      v.settledSeenAt,
      v.extreme,
      v.cleanReadings,
      v.longPairedAt,
      v.startedAt,
      v.evaluatedAt,
      v.boundAt,
      v.cooldownUntil,
    ) &&
    (v.provisionalFloor === undefined || v.provisionalFloor === null ||
      finite(v.provisionalFloor) && v.provisionalFloor >= 0) &&
    v.gap >= 0 &&
    (v.serial === undefined || Number.isSafeInteger(v.serial) && v.serial >= 0) &&
    [v.invalid, v.metricInvalid, v.residualInvalid, v.rulesMismatch].every((b) =>
      typeof b === "boolean"
    ) &&
    Array.isArray(v.mismatches) && v.mismatches.every((n) => finite(n)) &&
    (v.extremeFrom === null || finite(v.extremeFrom)) &&
    (v.cleanFrom === null || finite(v.cleanFrom)) &&
    Array.isArray(v.invalidSpans) &&
    v.invalidSpans.every((x, i, all) =>
      !!x && finite(x.from) &&
      (x.to === null
        ? i === all.length - 1 && v.residualInvalid
        : finite(x.to) && x.to >= x.from) &&
      (x.applied === undefined || validSettings(x.applied)) &&
      (x.gap === undefined || finite(x.gap))
    ) &&
    Array.isArray(v.pendingLimits) && v.pendingLimits.every((n) => finite(n)) &&
    Array.isArray(v.suspects) && v.suspects.every((x) => !!x && finite(x.at, x.gap)) &&
    (v.fitAt === undefined || finite(v.fitAt)) &&
    (v.fitSince === undefined || finite(v.fitSince)) &&
    (v.fitFrom === undefined || validSettings(v.fitFrom)) &&
    (v.lastSettled === null || finite(v.lastSettled)) &&
    (v.apiStaleSince === null || finite(v.apiStaleSince)) &&
    (v.hold === null ||
      !!v.hold && finite(v.hold.since) && ["stale", "invalid"].includes(v.hold.reason)) &&
    (v.ownHold === null ||
      !!v.ownHold && finite(v.ownHold.gap) && v.ownHold.gap >= 0 &&
        validSettings(v.ownHold.settings) &&
        (v.ownHold.central === undefined || finite(v.ownHold.central))) &&
    (v.fit === null || validFit(v.fit)) &&
    (v.pending === null || validPending(v.pending)) &&
    !!cusum && finite(cusum.s, cusum.down, cusum.residual, cusum.own) &&
    typeof cusum.alarm === "boolean" && (cusum.since === undefined || finite(cusum.since)) &&
    (base === undefined || base === null ||
      !!base && finite(base.at, base.balance, base.gap) &&
        (base.track === undefined || finite(base.track)) &&
        (base.origin === undefined || finite(base.origin))) &&
    !!e && finite(e.open, e.acted) && (e.clamp === null || finite(e.clamp)) &&
    (e.track === null || finite(e.track));
}
// The sustained-use cooldown (#13 §5) as the limit records give it, and at least the state's. It
// follows from history alone, so a crash between history and persist.json can't drop it.
export function sustainedCooldown(h: History, c: CalibrationConfig, s: CalibrationState): number {
  let until = s.cooldownUntil;
  for (const r of h.limits) {
    if (r.class === "sustained-use" && r.lift !== undefined) {
      until = Math.max(until, r.lift + c.sustained_cooldown_s * 1000);
    }
  }
  return until;
}
// Today's legacy margin, the floor of every fallback.
export const fallbackMargin = (m: Settings): Settings => ({
  ...m,
  mul: Math.max(m.mul, MARGIN.mul),
  add: Math.max(m.add, MARGIN.add),
});
// The settings in force: learned settings, under the stale or invalid hold while it lasts.
export function effectiveSettings(s: CalibrationState): Settings {
  let settings = s.hold ? fallbackMargin(s.applied) : { ...s.applied };
  if (s.ownHold) settings = maxSettings(settings, s.ownHold.settings);
  if (s.pending) settings = maxSettings(settings, s.pending.hold);
  return settings;
}
export const maxSettings = (a: Settings, b: Settings): Settings => ({
  mul: Math.max(a.mul, b.mul),
  add: Math.max(a.add, b.add),
  floor: Math.max(a.floor, b.floor),
});
export type Trigger =
  | "fit"
  | "cusum-alarm"
  | "cusum-keep"
  | "cusum-revert"
  | "limit-classified"
  | "limit-diagnosis"
  | "rules-mismatch"
  | "stale-fallback"
  | "readings-invalid"
  | "readings-resumed"
  | "readings-corroborated"
  | "drift-hold"
  | "reset";
export type Change = {
  trigger: Trigger;
  inputs: Record<string, unknown>;
  from: Settings;
  to: Settings;
};
export type LimitUpdate =
  & { onset: number }
  & Partial<Pick<LimitRecord, "class" | "diagnosis" | "diagnosisEvidence" | "liftCheck">>;
export type Evaluation = {
  state: CalibrationState;
  changes: Change[];
  limits: LimitUpdate[];
  longPairs: LongPair[];
};
// Most of the last day spent in intervals outside 900-2,700 seconds. Measured in time, so sparse
// readings count as fully as dense ones. An interval over 6 hours is an outage, which staleness
// covers; counting it would keep readings that have resumed unusable for most of a day.
function spacingInvalid(readings: Reading[], now: number): boolean {
  const from = now - DAY;
  let invalid = 0, total = 0;
  for (let i = readings.length - 1; i > 0 && readings[i].at > from; i--) {
    const start = readings[i - 1].at, end = readings[i].at;
    if (end - start > LONG_INTERVAL_MAX_MS) continue;
    const span = end - Math.max(start, from);
    total += span;
    if (!validSpacing(start, end)) invalid += span;
  }
  // Most of a day: more than 12 of the last 24 hours, outages left out. Half of the counted time,
  // once 20 hours were counted, never judged a day with an outage over 4 hours, however its
  // readings were spaced.
  return invalid > DAY / 2;
}
const residualZ = (pair: Pair, fit: MeterFit) =>
  (pair.host - fit.a * pair.own - fit.b) / sigmaAt(fit, pair.own);

// One evaluation's inputs and the operations every phase records its decisions with.
type Run = {
  p: Plan;
  h: History;
  c: CalibrationConfig;
  now: number;
  previous: CalibrationState;
  s: CalibrationState;
  latest: number | null;
  // Fresh pairs this evaluation judged against the fit and found normal.
  normal: number;
  change(trigger: Trigger, inputs: Record<string, unknown>, apply?: () => void): void;
  update(record: LimitRecord, patch: Omit<LimitUpdate, "onset">): void;
  // Learning tightens the learned settings. A drift change only holds, so nothing it withdraws can
  // take learning with it.
  tighten(next: (m: Settings, fit: MeterFit | null) => Settings): void;
};
export function updateCalibration(
  p: Plan,
  h: History,
  previous: CalibrationState,
  c: CalibrationConfig,
  now: number,
  open: number,
): Evaluation {
  const { run, s, history, changes, updates } = newRun(p, h, previous, c, now);
  s.evaluatedAt = now;
  s.serial = (previous.serial ?? 0) + 1;
  const { pairs, usable: fresh, stale } = assessReadings(run);
  trackMeter(run, pairs, fresh);
  // Readings beyond 6 sigma that agree with the rise the own-count hold measured count again.
  const agreeing = holdCorroboration(run);
  if (agreeing) corroborate(run, null, agreeing.to, agreeing);
  // Only now, with this evaluation's residuals judged, can readings end a hold. Three extreme
  // residuals here make them unusable for the rest of the evaluation too.
  const usable = readingsValidity(run, stale, agreeing ? "corroborated" : "final") && fresh;
  if (usable) updateBound(run);
  classifyLifted(run);
  checkLifts(run, usable);
  const residualInvalid = s.residualInvalid;
  learnGaps(run, usable);
  // Readings a limit corroborated count again in this evaluation, and the holds end with them.
  if (residualInvalid && !s.residualInvalid) readingsValidity(run, stale, "corroborated");
  if (s.rulesMismatch) run.tighten(fallbackMargin);
  const longPairs = pairLongIntervals(p, h.readings, h.slots, s.longPairedAt);
  if (longPairs.length) s.longPairedAt = longPairs.at(-1)!.at;
  s.replayBase = settledBase(p, history, s);
  s.estimates = calculateEstimates(p, history, s, c, now, open);
  return { state: s, changes, limits: [...updates.values()], longPairs };
}
// Classification alone, for an evaluation that failed: it needs only the limit records, so off's
// widen() gate and the sustained-use cooldown never depend on the rest of calibration.
export function classifyLimits(
  p: Plan,
  h: History,
  previous: CalibrationState,
  c: CalibrationConfig,
  now: number,
): Evaluation {
  const { run, s, changes, updates } = newRun(p, h, previous, c, now);
  classifyLifted(run);
  return { state: s, changes, limits: [...updates.values()], longPairs: [] };
}
function newRun(
  p: Plan,
  h: History,
  previous: CalibrationState,
  c: CalibrationConfig,
  now: number,
) {
  const s = structuredClone(previous), changes: Change[] = [];
  const history: History = { ...h, limits: h.limits.map((r) => ({ ...r })) };
  const updates = new Map<number, LimitUpdate>();
  const run: Run = {
    p,
    h: history,
    c,
    now,
    previous,
    s,
    latest: h.readings.at(-1)?.at ?? null,
    normal: 0,
    change(trigger, inputs, apply = () => {}) {
      const from = effectiveSettings(s);
      apply();
      changes.push({ trigger, inputs, from, to: effectiveSettings(s) });
    },
    update(record, patch) {
      Object.assign(record, patch);
      updates.set(record.onset, { ...updates.get(record.onset), onset: record.onset, ...patch });
    },
    tighten(next) {
      s.applied = maxSettings(s.applied, next(s.applied, s.fit));
    },
  };
  return { run, s, history, changes, updates };
}
// Freshness and validity (#13 §10): which pairs are new, whether readings can be used, and the hold.
function assessReadings(run: Run) {
  const { p, h, c, now, s, latest } = run;
  if (latest !== null && latest !== s.lastSettled) {
    s.lastSettled = latest;
    s.settledSeenAt = now;
  }
  const stale = now - s.settledSeenAt >= c.stale.pause_s * 1000;
  const oldest = h.readings[0]?.at ?? -Infinity;
  s.invalidSpans = s.invalidSpans.filter((x) => x.to === null || x.to > oldest);
  // Only the fit window's pairs are used; its first reading also needs the one before it.
  const since = now - c.fit.days * DAY;
  const first = firstIndex(h.readings, (r) => r.at < since);
  const pairs = stale
    ? []
    : pairReadings(p, h.readings.slice(Math.max(0, first - 1)), h.slots, h.meterPairs).filter((r) =>
      r.at >= since
    );
  // Keep checking new residuals during a residual alarm, or it could never clear itself.
  if (s.residualInvalid && s.fit) {
    for (const pair of pairs.filter((r) => r.at > s.lastPaired)) {
      s.lastPaired = pair.at;
      const z = residualZ(pair, s.pending?.fit ?? s.fit);
      if (censored(pair, z)) continue;
      if (Math.abs(z) <= EXTREME_Z) {
        if (!s.cleanReadings) s.cleanFrom = pair.at;
        s.cleanReadings++;
      } else {
        s.cleanReadings = 0;
        s.cleanFrom = null;
      }
      if (s.cleanReadings >= CLEAN_READINGS) {
        const to = s.cleanFrom ?? pair.at;
        s.invalidSpans = s.invalidSpans.map((x) => x.to === null ? { from: x.from, to } : x);
        s.residualInvalid = false;
        s.extreme = 0;
        s.extremeFrom = null;
        s.cleanFrom = null;
        // The readings that ended it are valid, so drift detection sees them too: a jump that
        // stays under 6 sigma at high load still shows in them.
        s.lastPaired = to - 1;
        break;
      }
    }
  }
  return { pairs, usable: readingsValidity(run, stale, "provisional"), stale };
}
// Whether the readings can be used, and the stale or invalid hold that follows from it. Readings
// that come back are judged before they end anything: the provisional check, before this
// evaluation's residuals, neither ends a hold nor restarts the fallback's clock. The final one needs
// a fresh pair the fit found normal, and no streak of extreme residuals that may yet make the
// readings invalid. The first reading after an outage spans it, so it can't be paired or judged.
// Readings a confirmed limit corroborated need neither: the limit judged them.
function readingsValidity(
  { h, c, now, previous, s, latest, normal, change }: Run,
  stale: boolean,
  check: "provisional" | "final" | "corroborated" = "final",
): boolean {
  const reasons = [
    ...(s.metricInvalid ? ["metric"] : []),
    ...(spacingInvalid(h.readings, now) ? ["spacing"] : []),
    ...(s.residualInvalid ? ["residuals"] : []),
  ];
  if (reasons.length && !s.invalid) {
    change("readings-invalid", { reasons, readings: h.readings.length }, () => {
      s.invalid = true;
    });
  }
  s.invalid = reasons.length > 0;
  const usable = !stale && !s.invalid;
  const judged = usable && (check === "corroborated" ||
    check === "final" && s.extreme === 0 && (!s.fit || normal > 0));
  if (judged) {
    s.apiStaleSince = null;
    // Readings the fit finds normal again show no meter change, so floor raises from meanwhile stay.
    s.provisionalFloor = null;
  } else if (!usable) s.apiStaleSince ??= stale ? s.settledSeenAt : now;
  const holding = !usable && s.apiStaleSince !== null &&
    now - s.apiStaleSince >= c.stale.fallback_s * 1000;
  if (holding && !s.hold) {
    const since = s.apiStaleSince!;
    change("stale-fallback", { since, reasons: stale ? ["stale", ...reasons] : reasons }, () => {
      s.hold = { since, reason: stale ? "stale" : "invalid" };
    });
  } else if (judged && (s.hold || s.ownHold || previous.invalid)) {
    // Readings own the meter side again: a refit absorbs any real jump, so both holds end. Valid
    // but stale readings are not back yet.
    change("readings-resumed", { since: s.hold?.since ?? null, at: latest }, () => {
      s.hold = null;
      s.ownHold = null;
    });
  }
  return usable;
}
// Meter fit and drift detection (#13 §3, §8).
function trackMeter(run: Run, pairs: Pair[], usable: boolean) {
  const { p, c, now, s, change } = run;
  // Invalid readings, and any residual beyond 6 sigma against the meter in force, never fit the
  // meter either: like drift detection, the fit must not let a bad feed tighten the margin. Only a
  // refit or new pairs need them, so most passes never filter.
  const model = s.pending?.fit ?? s.fit;
  const filtered = new Map<number, Pair[]>();
  const eligible = (from = -Infinity) => {
    const since = Math.max(from, s.fitSince ?? -Infinity);
    let out = filtered.get(since);
    if (!out) {
      out = pairs.filter((r) =>
        r.at >= since && !inSpan(s.invalidSpans, r.at) &&
        (!model || Math.abs(residualZ(r, model)) <= EXTREME_Z)
      );
      filtered.set(since, out);
    }
    return out;
  };
  const changed = s.pending;
  if (usable && changed?.verified) {
    // A verified change refits on the readings after it alone, so a window mixing both sides of the
    // change cannot distort the slope or the noise. That fit sets the learned margin, tightening
    // only against the margin learned before the change, and the hold ends.
    const after = eligible(changed.at);
    const post = qualifies(after, c.fit) ? fitMeter(after, c.fit, FIT_SEED, now) : null;
    if (post) {
      s.fitAt = now;
      // Limits during the change were explained by it, and this fit carries it, so what they
      // taught is superseded: the gap and margin start again from before the change. The floor
      // stays, and the hold this fit replaces covered everything meanwhile.
      // Under a rules mismatch it only tightens, so widen() steps learned meanwhile stay.
      const gap = Math.max(c.gap_start, Math.min(s.gap, changed.gapFrom));
      const from = s.rulesMismatch ? s.applied : { ...changed.from, floor: s.applied.floor };
      change("fit", { fit: post, gap, since: changed.at }, () => {
        s.fit = post;
        s.gap = gap;
        s.applied = marginFromFit(p, post, gap, from, c);
        s.fitSince = changed.at;
        s.fitFrom = { ...changed.from };
        s.pending = null;
        s.cusum = emptyCusum();
      });
    }
  } else if (!changed) {
    const fitted =
      usable && (!s.fit || (pairs.at(-1)?.at ?? 0) > s.lastPaired && now - (s.fitAt ?? 0) >= DAY)
        ? fitMeter(eligible(), c.fit, FIT_SEED, now)
        : null;
    if (fitted) s.fitAt = now;
    if (fitted && !s.fit) {
      change("fit", { fit: fitted, gap: s.gap }, () => {
        s.fit = fitted;
        s.applied = marginFromFit(p, fitted, s.gap, s.applied, c);
      });
    } else if (fitted && s.fit) {
      // Until its window has moved past a drift change, a refit still sees only the readings after
      // it, and more of them. Like the fit that ended the change, it sets the margin against the one
      // learned before the change, so an early fit's split of a change into slope and offset is not
      // kept alongside a later one. The floor and any gap learned since stay; widen() steps under a
      // rules mismatch are not refit.
      const settling = !!s.fitFrom && now - (s.fitSince ?? -Infinity) < c.fit.days * DAY &&
        !s.rulesMismatch;
      const base = settling ? { ...s.fitFrom!, floor: s.applied.floor } : s.applied;
      const proposed = marginFromFit(p, fitted, s.gap, base, c);
      const changed = settling
        ? proposed.mul !== s.applied.mul || proposed.add !== s.applied.add
        : proposed.mul > s.applied.mul || proposed.add > s.applied.add;
      if (changed) {
        change(
          "fit",
          { fit: fitted, gap: s.gap, ...(settling ? { since: s.fitSince } : {}) },
          () => {
            s.applied = proposed;
            s.fit = fitted;
          },
        );
      }
    }
  }
  const fresh = usable ? pairs.filter((r) => r.at > s.lastPaired) : [];
  const qualified = fresh.length > 0 && qualifies(eligible(), c.fit);
  for (const pair of fresh) {
    s.lastPaired = pair.at;
    // The extreme test needs only a fit; drift detection also needs the window to qualify, so a box
    // that went idle still catches a broken feed.
    if (!s.fit) continue;
    const z = residualZ(pair, s.pending?.fit ?? s.fit);
    if (censored(pair, z)) continue;
    // An extreme residual is not evidence of drift: neither CUSUM nor a pending verification sees
    // it. Three in a row make the readings invalid, from the first of them.
    if (Math.abs(z) > EXTREME_Z) {
      if (!s.extreme) s.extremeFrom = pair.at;
      s.extreme++;
      if (s.extreme < EXTREME_READINGS) continue;
      const from = s.extremeFrom ?? pair.at;
      change("readings-invalid", { reasons: ["residuals"], pair, z, from }, () => {
        s.residualInvalid = true;
        s.invalid = true;
        s.cleanReadings = 0;
        s.cleanFrom = null;
        s.invalidSpans = [
          ...s.invalidSpans,
          { from, to: null, applied: { ...s.applied }, gap: s.gap },
        ];
        s.apiStaleSince ??= now;
      });
      break;
    }
    s.extreme = 0;
    s.extremeFrom = null;
    run.normal++;
    if (!qualified) continue;
    const pending = s.pending;
    if (pending) {
      // The pairs since the change refine its size: the hold rises to cover their mean residual,
      // so a change first seen through a few pairs is not left half covered.
      pending.residual += pair.host - pending.oldFit.a * pair.own - pending.oldFit.b;
      pending.n++;
      const offset = pending.residual / pending.n;
      if (pending.n >= REFINE_PAIRS && offset > pending.fit.b - pending.oldFit.b) {
        const raised = { ...pending.oldFit, b: pending.oldFit.b + offset };
        const hold = maxSettings(pending.hold, marginFromFit(p, raised, s.gap, s.applied, c));
        if (hold.add - pending.hold.add >= 0.01 || hold.mul > pending.hold.mul) {
          change("drift-hold", { offset, pairs: pending.n, since: pending.at }, () => {
            pending.fit = raised;
            pending.hold = hold;
          });
        } else pending.fit = raised;
      }
      // A verified change waits for its fit; drift detection resumes after it.
      if (pending.verified) continue;
      pending.readings++;
      pending.z += residualZ(pair, pending.oldFit);
      if (pending.readings >= c.cusum.verify_readings) {
        const keep = pending.z / pending.readings >= c.cusum.verify_z;
        change(keep ? "cusum-keep" : "cusum-revert", {
          meanZ: pending.z / pending.readings,
          readings: pending.readings,
        }, () => {
          // Kept, the change holds until a fit on the readings after it qualifies. Withdrawn, it
          // leaves nothing behind: it never changed the learned settings.
          if (keep) pending.verified = true;
          else s.pending = null;
          s.cusum = emptyCusum();
        });
      }
      continue;
    }
    s.cusum = cusumStep(s.cusum, pair, s.fit, c.cusum);
    if (s.cusum.alarm) {
      const oldFit = s.fit, since = s.cusum.since ?? pair.at;
      // The run can start on noise before the change, so its sums understate the change. The
      // clearly shifted pairs of the run measure it, read as an offset or as a slope. Capped pairs
      // only bound the meter from below, so neither reading takes them.
      const run = eligible().filter((r) => r.at >= since && r.at <= pair.at && !r.capped);
      const shifted = run.filter((r) => residualZ(r, oldFit) > 1);
      const residual = (r: Pair) => r.host - oldFit.a * r.own - oldFit.b;
      const offset = Math.max(0, mean(shifted.map(residual)));
      // A slope only shows where there is load to scale: near idle, any offset divided by a tiny
      // load reads as a multiplier several times the meter's. Only pairs at min_cores or more,
      // where the fit qualifies, measure it; without them the change reads as an offset alone.
      const slopeOf = (rs: Pair[]) => {
        const loaded = rs.filter((r) => r.own >= c.fit.min_cores);
        const own = loaded.reduce((n, r) => n + r.own, 0);
        return own ? loaded.reduce((n, r) => n + residual(r), 0) / own : 0;
      };
      const slope = Math.max(slopeOf(run), slopeOf(shifted));
      const a = Math.max(oldFit.a, oldFit.a + slope);
      const steeper = { ...oldFit, a, aHi: Math.max(oldFit.aHi, a) };
      const raised = { ...oldFit, b: oldFit.b + offset };
      change("cusum-alarm", { pair, cusum: s.cusum, oldFit, a, offset }, () => {
        // Neither reading is learned: an additive jump read as a slope would stay a higher
        // multiplier. The hold covers both at every load, the offset reading spots extreme
        // residuals meanwhile, and the readings after this alarm alone refit the meter.
        s.pending = {
          at: pair.at,
          from: { ...s.applied },
          gapFrom: s.gap,
          oldFit,
          fit: raised,
          hold: maxSettings(
            marginFromFit(p, steeper, s.gap, s.applied, c),
            marginFromFit(p, raised, s.gap, s.applied, c),
          ),
          readings: 0,
          z: 0,
          verified: false,
          residual: 0,
          n: 0,
        };
      });
    }
  }
}
// The daily no-limit bound is plausibility evidence only. Its replays stop at every gap, which can
// only make it looser.
function updateBound({ p, h, c, now, s, latest }: Run) {
  if (now - s.boundAt < DAY) return;
  const bounds: number[] = [];
  const syncs = historyAnchors(p, h, s.gapUpperBound, "high").filter((a) => a.balance > 0);
  for (let i = 0; i < syncs.length; i++) {
    const anchor = syncs[i];
    const next = h.limits.reduce<LimitRecord | null>(
      (first, l) => l.onset > anchor.at && l.onset < (first?.onset ?? Infinity) ? l : first,
      null,
    );
    const until = Math.min(
      latest ?? anchor.at,
      syncs[i + 1]?.at ?? Infinity,
      // The bank was positive at least until the earliest plausible onset.
      next ? next.onset - c.learning.onset_margin_s * 1000 : Infinity,
    );
    if (until - anchor.at < DAY) continue;
    const bound = noLimitBound(
      p,
      h.readings,
      afterLift(next ? beforeLimit(h.slots, next) : h.slots, h.limits, anchor),
      anchor,
      until,
      s.invalidSpans,
    );
    if (bound !== null) bounds.push(bound);
  }
  if (bounds.length) s.gapUpperBound = bounds.reduce((lo, v) => Math.min(lo, v), Infinity);
  s.boundAt = now;
}
// Classification at the lift (#13 §5).
function classifyLifted({ p, h, c, s, change, update }: Run) {
  for (const record of h.limits) {
    if (record.lift === undefined || record.class !== undefined) continue;
    const classification = classifyLimit(p, record);
    change("limit-classified", {
      onset: record.onset,
      class: classification,
      cap: creditCap(p, record),
      confirmed: record.confirmed,
      firstTest: record.firstTest ?? null,
    }, () => {
      update(record, { class: classification });
      if (classification === "sustained-use") {
        s.cooldownUntil = Math.max(s.cooldownUntil, record.lift! + c.sustained_cooldown_s * 1000);
      }
      if (
        classification === "credit" && record.learn && record.entry >= s.startedAt &&
        !s.pendingLimits.includes(record.onset)
      ) s.pendingLimits.push(record.onset);
    });
  }
}
// Lift check (#13 §7): recovery time against the readings' prediction. Invalid readings, or ones
// that do not yet reach the end of the prediction, are retried while the API can still serve them.
function checkLifts({ p, h, now, s, change, update, tighten }: Run, usable: boolean) {
  for (const record of h.limits) {
    if (
      record.class !== "credit" || record.lift === undefined || record.liftCheck ||
      !record.learn || record.entry < s.startedAt
    ) continue;
    const retrying = now - record.lift < LIFT_RETRY_MS;
    if (!usable && retrying) continue;
    // Pressing during recovery disqualifies the check at once: predictRecovery reports it complete.
    const { predicted, complete } = usable
      ? predictRecovery(p, h, record, s.gap, s.fit, s.invalidSpans)
      : { predicted: null, complete: false };
    if (predicted === null && !complete && retrying) continue;
    const ratio = predicted ? (record.lift - record.onset) / 1000 / predicted : null;
    update(record, { liftCheck: { at: now, predicted, ratio } });
    if (ratio === null || ratio <= LIFT_RATIO) continue;
    s.mismatches = [
      ...s.mismatches.filter((at) => record.lift! - at <= MISMATCH_WINDOW_MS),
      record.lift,
    ];
    // Only the mismatch that latches it alerts; later ones are logged under the latch.
    const latched = !s.rulesMismatch && s.mismatches.length >= MISMATCHES;
    change("rules-mismatch", {
      onset: record.onset,
      ratio,
      predicted,
      mismatches: s.mismatches.length,
      latched,
    }, () => {
      s.rulesMismatch ||= latched;
      if (s.rulesMismatch) tighten(fallbackMargin);
    });
  }
}
// Gap learning from confirmed credit limits (#13 §6). Readings settle 30 to 90 minutes after their
// interval, so a diagnosis waits for valid readings that cover t_lo; after the stale pause the
// guest's own count stands in.
function learnGaps(run: Run, usable: boolean) {
  const { p, h, c, now, s, latest, change, update } = run;
  for (const onset of [...s.pendingLimits]) {
    const record = h.limits.find((r) => r.onset === onset);
    if (!record) {
      s.pendingLimits = s.pendingLimits.filter((at) => at !== onset);
      continue;
    }
    if (record.lift === undefined) continue;
    const readable = usable && (latest ?? -Infinity) >= onset - c.learning.onset_margin_s * 1000;
    if (!readable && now - record.lift < c.stale.pause_s * 1000) continue;
    const invalid = s.invalidSpans, window = c.learning.confirm_days * DAY;
    // A repeat while readings are invalid or stale is billing evidence the feed cannot give: the
    // second confirmed credit limit within confirm_days applies the full own-count result.
    const fullOwnStep = !readable &&
      h.limits.some((l) =>
        l.onset < onset && onset - l.onset <= window && l.class === "credit" && l.confirmed &&
        l.learn && l.entry >= s.startedAt
      );
    const options = { useReadings: usable, invalid, fullOwnStep };
    const diagnosis = diagnoseGap(p, h, record, c, s.gapUpperBound, s.fit, options);
    // Readings that corroborate the rise show the meter changed and the pinned rules still hold.
    const corroborated = corroboration(run, record, diagnosis);
    const latched = s.rulesMismatch;
    const mismatch = !corroborated && rulesMismatched(p, c, s, record, diagnosis);
    const inputs = {
      onset,
      diagnosis,
      gapUpperBound: s.gapUpperBound,
      ...(diagnosis.source === "unavailable"
        ? { note: diagnosis.anchor ? "gap not measurable" : "no earlier anchor" }
        : {}),
    };
    change("limit-diagnosis", inputs, () => {
      s.pendingLimits = s.pendingLimits.filter((at) => at !== onset);
      update(record, {
        diagnosis,
        diagnosisEvidence: diagnosisEvidence(h, c, s.gapUpperBound, s.fit, diagnosis, options),
      });
      // A corroborated limit is explained by the rise it measured: that rise empties the bank at
      // t_lo, so no optimism is left for the floor, and the drift change it opens carries the meter.
      // The own-count replay at the old margin would pin the floor at floor_max instead. A mismatch
      // learns under its own decision.
      if (!corroborated && !mismatch) learn(run, record, diagnosis, !usable);
    });
    // Every mismatch is logged; only the one that latches alerts. Like a lift check's, it carries
    // the latch and the fallback it applies.
    if (mismatch) {
      change("rules-mismatch", {
        onset,
        gap: diagnosis.gap,
        gapMax: c.gap_max,
        cap: creditCap(p, record),
        latched: !latched,
      }, () => {
        s.rulesMismatch = true;
        learn(run, record, diagnosis, !usable);
      });
    }
    if (corroborated) corroborate(run, record.onset, diagnosis.onset, corroborated);
  }
}
// Corroborated resume (#13 §8): a confirmed credit limit measures the rise in billing since the
// readings turned extreme without using them. Its replay bills the settled readings up to that
// point and the fit plus a rise after it, and bisects the rise that empties the bank at t_lo. If the
// readings' mean residual over the same span agrees, both positive and within CORROBORATION of each
// other, they track billing: a units change cannot show the same rise in limits. The readings count
// again and the meter refits from where they turned extreme.
function corroboration({ p, h, s }: Run, record: LimitRecord, d: GapDiagnosis) {
  const open = s.invalidSpans.find((x) => x.to === null), fit = s.fit;
  if (!open || !s.residualInvalid || !fit || !d.anchor || d.source !== "own") return null;
  // A verified change holds until its own fit. A second change opened from its point would let the
  // fit after it mix both meters, so readings that turn extreme meanwhile stay invalid.
  if (s.pending?.verified) return null;
  // Like the mismatch tests, the lift's lower-bound bank where there is one.
  const anchor = liftAnchor(p, h, d.anchor, d.onset) ?? d.anchor;
  const slots = afterLift(beforeLimit(h.slots, record), h.limits, anchor);
  // The rise starts inside the first extreme reading's interval, so it bills from that interval's
  // start. Billed across every bridged gap, it had the old meter's gaps too and came out low.
  const from = h.readings[firstIndex(h.readings, (r) => r.at < open.from) - 1]?.at ?? open.from;
  const replay = (rise: number, untilZero = true) =>
    replaySettled(p, h.readings, slots, anchor, {
      gap: s.gap,
      to: d.onset,
      untilZero,
      bridge: { fit, rise: { from, by: rise } },
      invalid: s.invalidSpans,
      // The rise bills everything after the readings turned extreme, settled or not yet.
      bridgeTail: true,
    });
  // A real jump can exceed a core; billing cannot exceed the whole VM.
  if (!replay(0, false).complete || replay(0).firstZero !== null) return null;
  if (replay(p.vcpus).firstZero === null) return null;
  const rise = bisect((x) => replay(x).firstZero !== null, p.vcpus).hi;
  const residual = meanResidual(p, h, fit, Math.max(open.from - 1, anchor.at), d.onset);
  if (residual === null || residual <= 0 || !agree(rise, residual)) return null;
  return { open, rise, residual };
}
// The own-count hold stands for the same evidence: confirmed credit limits raised it by the rise in
// billing they measured while the readings couldn't be used. Readings that come back beyond 6 sigma
// and agree with that rise track billing: a real jump during an outage. Without this, the hold keeps
// the box from the limits that could corroborate them, and readings that changed with the meter
// would stay invalid, the hold in force, for good. A units change shows no such rise.
function holdCorroboration({ p, h, s, latest }: Run) {
  const open = s.invalidSpans.find((x) => x.to === null), fit = s.fit;
  if (!open || !s.residualInvalid || !fit || !s.ownHold || s.pending?.verified) return null;
  // The allowance for estimated time would inflate the rise by up to half again.
  const rise = (s.ownHold.central ?? s.ownHold.gap) - s.gap;
  if (rise <= 0 || latest === null) return null;
  const residual = meanResidual(p, h, fit, open.from - 1, latest);
  if (residual === null || residual <= 0 || !agree(rise, residual)) return null;
  return { open, rise, residual, to: latest };
}
function corroborate(
  { p, h, c, s, change }: Run,
  onset: number | null,
  to: number,
  { open, residual, rise }: { open: InvalidSpan; residual: number; rise: number },
) {
  // Trusted again, the readings since the change measure it for the hold, over all its pairs.
  const oldFit = s.fit!, held = meanResidual(p, h, oldFit, open.from - 1, to) ?? residual;
  const fit = { ...oldFit, b: oldFit.b + held };
  const at = Math.min(open.from, s.pending?.at ?? Infinity);
  // An earlier drift change it adopts keeps the margin and gap from before that change, so what
  // limits taught meanwhile is dropped with the rest (#13 rule 3).
  const earlier = s.pending && s.pending.at <= open.from ? s.pending : null;
  change(
    "readings-corroborated",
    { onset, rise, residual, held, since: at, ...(onset === null ? { by: "own-count hold" } : {}) },
    () => {
      // The meter change explains the optimism limits left while the readings were unusable.
      if (typeof s.provisionalFloor === "number") {
        s.applied = { ...s.applied, floor: Math.min(s.applied.floor, s.provisionalFloor) };
      }
      s.provisionalFloor = null;
      s.invalidSpans = s.invalidSpans.filter((x) => x !== open);
      s.residualInvalid = false;
      s.extreme = 0;
      s.extremeFrom = null;
      s.cleanReadings = 0;
      s.cleanFrom = null;
      s.pending = {
        at,
        from: earlier ? { ...earlier.from } : open.applied ? { ...open.applied } : { ...s.applied },
        gapFrom: earlier ? earlier.gapFrom : open.gap ?? s.gap,
        oldFit,
        fit,
        hold: marginFromFit(p, fit, s.gap, s.applied, c),
        readings: 0,
        z: 0,
        verified: true,
        residual: 0,
        n: 0,
      };
    },
  );
}
// The readings' mean residual against `fit` over (from, to], invalid readings included, in cores.
function meanResidual(p: Plan, h: History, fit: MeterFit, from: number, to: number): number | null {
  const first = Math.max(0, firstIndex(h.readings, (r) => r.at <= from) - 1);
  const pairs = pairReadings(p, h.readings.slice(first), h.slots, h.meterPairs)
    .filter((r) => r.at > from && r.at <= to && !r.capped);
  return pairs.length ? mean(pairs.map((r) => r.host - fit.a * r.own - fit.b)) : null;
}
// Harsher real rules leave a gap the meter cannot explain: beyond a whole core, above gap_max,
// or above the plausible bound for a flat cap below the pinned limit.
function rulesMismatched(
  p: Plan,
  c: CalibrationConfig,
  s: CalibrationState,
  record: LimitRecord,
  d: GapDiagnosis,
): boolean {
  const plausible = Math.min(s.gapUpperBound, GAP_BOUND) + c.learning.plausible_extra;
  // During a drift change the fit does not yet describe the meter the span crossed, so nothing
  // there can judge the pinned rules; the fit after the change resets what such limits taught.
  if (s.pending) return false;
  // A mismatch takes the cautious estimate: the lower-bound anchor, without the allowance. The own
  // count faces only the whole-core bound (#13 §6, step 3): its step is capped, and without usable
  // readings nothing tells harsher rules from a jump in the meter.
  if (d.gap === null || d.explained) return false;
  if (d.beyond) return true;
  const gap = d.lower ?? d.gap;
  return d.source === "readings" &&
    (gap > c.gap_max || creditCap(p, record) === "low" && gap > plausible);
}
function learn(
  { p, h, c, s, tighten }: Run,
  record: LimitRecord,
  d: GapDiagnosis,
  provisional: boolean,
) {
  const raiseFloor = (left: number) => {
    const floor = Math.min(c.floor_max, c.start.floor + left / p.capacity);
    // Without usable readings nothing tells optimism the margin misses from a meter change that
    // isn't measured yet. A first limit during an outage left a jump's optimism to the floor,
    // which then stayed at floor_max after the readings showed the jump.
    if (provisional && floor > s.applied.floor) s.provisionalFloor ??= s.applied.floor;
    tighten((m) => ({ ...m, floor: Math.max(m.floor, floor) }));
  };
  const plausible = Math.min(s.gapUpperBound, GAP_BOUND) + c.learning.plausible_extra;
  if (s.rulesMismatch) {
    // The pinned rules do not hold, so a billing gap means nothing. Learn the way off mode always
    // has: widen() from the estimate's optimism at entry, on top of the fixed fallback.
    tighten((m) => {
      const base = fallbackMargin(m);
      return { ...base, ...widen(base, record.balance, record.used) };
    });
    return;
  }
  // Without usable readings nothing tells harsher rules from a jump in the meter, so the plausible
  // bound and gap_max do not gate the hold: it is temporary, and it ends when readings resume.
  if (d.held !== undefined) {
    const gap = Math.max(s.ownHold?.gap ?? 0, d.held);
    const held = s.fit
      ? marginFromFit(p, s.fit, gap, s.applied, c)
      : marginWithoutFit(c, gap, s.applied);
    // The own-count replay billed the governor's charges, at the settings in force at entry, and
    // found billing above them by the step. Those settings may hold more than the gap does, such as
    // the stale fallback's 0.08, so the hold covers them plus the step as well.
    const step = d.held - (record.heldGap ?? record.gap);
    const charged = { ...record.settings, add: record.settings.add + step };
    const span = d.anchor ? (d.onset - d.anchor.at) / 1000 : 0;
    const central = span > 0 ? d.held - d.eta / span : d.held;
    s.ownHold = {
      gap,
      settings: maxSettings(maxSettings(s.ownHold?.settings ?? held, held), charged),
      central: Math.max(s.ownHold?.central ?? 0, central),
    };
  }
  // The first limit has no earlier anchor, so no gap. The estimate it still showed at entry is
  // the only measure of optimism: step 8 with the live estimate in place of a replay. In apply
  // that is the clamped estimate the governor acted on.
  const shown = record.acted ?? record.balance;
  if (!d.anchor) return raiseFloor(shown);
  // A reboot, an invalid clock or missing slots between the anchor and t_lo leave the gap not
  // measurable. The estimate at entry still measures optimism, as for the first limit.
  if (d.gap === null) return raiseFloor(shown);
  if (d.beyond) return;
  // Readings that reach zero without a gap leave the gap to drift detection (#13 §6, step 4).
  if (!d.explained) {
    const match = s.suspects.find((v) =>
      record.lift! - v.at <= c.learning.confirm_days * DAY &&
      Math.abs(v.gap - d.gap!) <= SUSPECT_MATCH
    );
    // The own count's capped step faces only the whole-core bound, so it isn't held as suspect.
    if (d.source === "readings" && d.gap > plausible && !match) {
      s.suspects = [...s.suspects, { at: record.lift!, gap: d.gap }].filter((v) =>
        record.lift! - v.at <= c.learning.confirm_days * DAY
      );
      return;
    }
    s.gap = Math.max(s.gap, d.gap, match?.gap ?? 0);
    tighten((m, fit) => fit ? marginFromFit(p, fit, s.gap, m, c) : marginWithoutFit(c, s.gap, m));
  }
  // Whatever the margin now in force leaves at t_lo is optimism it does not explain. That holds for
  // a limit the readings explain too: until a fit qualifies, only the floor can absorb it. A hold
  // in force explains its share until it ends, and what ends it carries that share on: a refit
  // after a meter change, or readings that resume. Replaying at the learned margin alone pinned
  // the floor at floor_max after every simulated meter jump during an outage.
  const slots = afterLift(beforeLimit(h.slots, record), h.limits, d.anchor);
  const replay = replayOwn(p, slots, d.anchor, effectiveSettings(s), d.onset);
  if (replay.complete) raiseFloor(replay.balance);
}
// The largest gap that keeps the readings replay off zero from a sync until the next one or a limit.
// No limit came, so billing ran at most that far above the readings. Bisection, not the bank divided
// by the time since the sync: a bank that refills to capacity forgives every earlier shortfall.
function noLimitBound(
  p: Plan,
  readings: Reading[],
  slots: Slot[],
  anchor: Anchor,
  until: number,
  invalid: InvalidSpan[],
): number | null {
  const base = replaySettled(p, readings, slots, anchor, { to: until, invalid });
  // Readings alone emptying the bank without a limit say nothing about billing above them.
  if (base.at - anchor.at < DAY || base.firstZero !== null) return null;
  const empties = (gap: number) =>
    replaySettled(p, readings, slots, anchor, { gap, to: base.at, untilZero: true, invalid })
      .firstZero !== null;
  if (!empties(1)) return null;
  return bisect(empties).lo;
}
// The clamp across clock-invalid time (#13 §9). The governor counts CPU on kernel uptime, so its
// busy time and charges there still hold; only placing them in wall time fails. Each run of
// clock-invalid slots, with the holes beside it, becomes whole slots at the run's own rates, and
// readings ending in it are bridged with the settings in force, like a reading gap. Earning goes
// on: nothing says it stopped. A run with a reboot, or with no time counted, stays as it is.
export function clockBridged(slots: Slot[]): { slots: Slot[]; spans: InvalidSpan[] } {
  if (!slots.some((x) => x.flags & FLAGS.clockInvalid)) return { slots, spans: [] };
  const out: Slot[] = [], spans: InvalidSpan[] = [];
  for (let i = 0; i < slots.length;) {
    if (!(slots[i].flags & FLAGS.clockInvalid)) {
      out.push(slots[i++]);
      continue;
    }
    let j = i;
    while (j < slots.length && slots[j].flags & FLAGS.clockInvalid) j++;
    const run = slots.slice(i, j);
    const seconds = run.reduce((n, x) => n + x.seconds, 0);
    if (!seconds || run.some((x) => x.flags & FLAGS.reboot)) {
      out.push(...run);
      i = j;
      continue;
    }
    const from = i ? Math.min(run[0].at, slots[i - 1].at + SLOT_MS) : run[0].at;
    const to = j < slots.length ? slots[j].at : run.at(-1)!.at + SLOT_MS;
    const rate = (k: "busy" | "charged") => run.reduce((n, x) => n + x[k], 0) / seconds;
    const busy = rate("busy"), charged = rate("charged"), each = SLOT_MS / 1000;
    // A limit, or time the governor kept from earning, inside the run stays in force across it, and
    // pressing keeps its share of the time.
    const flags = run.reduce((f, x) => f | x.flags, 0) &
      (FLAGS.limited | FLAGS.noEarn | FLAGS.pressing);
    const pressed = run.reduce((n, x) => n + pressingShare(x) * x.seconds, 0) / seconds;
    const quiet = run.reduce((n, x) => n + quietShare(x) * x.seconds, 0) / seconds;
    for (let at = from; at < to; at += SLOT_MS) {
      out.push({
        at,
        seconds: each,
        busy: busy * each,
        steal: 0,
        managed: 0,
        outside: 0,
        charged: charged * each,
        flags,
        ...(pressed ? { pressed: pressed * each } : {}),
        ...(quiet ? { quiet: quiet * each } : {}),
      });
    }
    spans.push({ from, to });
    i = j;
  }
  return { slots: out, spans };
}
// The slots a tick's estimates need from the replay base on. A clock-invalid run is billed at its
// own rate from the slot before it, so any run the tail reaches into stays whole, with that slot,
// and the tail gives what the full evaluation gives.
export function tailSlots(slots: Slot[], at: number): Slot[] {
  let first = firstSlot(slots, at);
  while (first > 0 && slots[first - 1].flags & FLAGS.clockInvalid) first--;
  return slots.slice(Math.max(0, first - 1));
}
// B_clamp's settled part: settled readings plus the learned gap from the last anchor, bridged
// across gaps and clock-invalid time with the settings in force (#13 §9).
function settledBase(
  p: Plan,
  h: History,
  s: CalibrationState,
): NonNullable<CalibrationState["replayBase"]> | null {
  const newest = h.readings.at(-1)?.at ?? -Infinity, previous = s.replayBase;
  // A base from an earlier evaluation continues the same replay: the bank there sums up everything
  // before it. Without it, the clamp would turn off once its only anchor aged out of the 90-day
  // history on a box that never certifies full again, or once a replay from the history's anchor
  // met time local samples don't cover. A base at or past the newest reading, from an evaluation
  // without a new reading or from an operator's seed, has nothing new to replay.
  const rolling = previous ? { at: previous.at, balance: previous.balance, exact: false } : null;
  const anchor = historyAnchors(p, h, s.gapUpperBound).findLast((a) => a.at < newest);
  // A base grown from an operator's seed goes first until history has a newer anchor: the seed is
  // newer evidence than any anchor before it. Otherwise history's anchor goes first, so a changed
  // gap or newly invalid readings are replayed again from it.
  const seeded = previous?.origin !== undefined && previous.origin > (anchor?.at ?? -Infinity);
  const { slots, spans } = clockBridged(h.slots);
  const options = {
    gap: s.gap,
    invalid: spans.length ? [...s.invalidSpans, ...spans] : s.invalidSpans,
  };
  for (const from of seeded ? [rolling, anchor] : [anchor, rolling]) {
    if (!from) continue;
    if (from === rolling && previous!.at >= newest) return { ...previous!, gap: s.gap };
    const trackFrom = from === rolling && previous!.track !== undefined
      ? { ...from, balance: previous!.track }
      : from;
    const replay = replaySettled(p, h.readings, slots, from, {
      ...options,
      bridge: { margin: effectiveSettings(s) },
      wholeSlots: true,
    });
    if (!replay.complete) continue;
    // Without a bridged gap both replays bill the readings alone, so they agree, unless a slot
    // pressed on a limit: the clamp, a lower bound, lets such a slot earn nothing, while Hostinger's
    // rule, which tracking follows, lets it earn for the time it didn't press.
    const pressed = slots.some((x) =>
      x.at + SLOT_MS > from.at && x.at < replay.at && pressingShare(x, true) > pressingShare(x)
    );
    const tracked = s.fit && (replay.bridged > 0 || trackFrom !== from || pressed)
      ? replaySettled(p, h.readings, slots, trackFrom, {
        ...options,
        to: replay.at,
        bridge: { fit: s.fit },
      })
      : null;
    return {
      at: replay.at,
      balance: replay.balance,
      exact: true,
      gap: s.gap,
      ...(from !== rolling
        ? { origin: from.at }
        : previous!.origin !== undefined
        ? { origin: previous!.origin }
        : {}),
      ...(tracked?.complete ? { track: tracked.balance } : {}),
    };
  }
  return null;
}
// B_clamp replays settled readings plus the learned gap, then advances with the settings in force.
// acted = min(B_open, B_clamp + tau) (#13 §9); readings can lower it but never raise it above
// B_open.
export function calculateEstimates(
  p: Plan,
  h: History,
  s: CalibrationState,
  c: CalibrationConfig,
  now: number,
  open: number,
): CalibrationState["estimates"] {
  let clamp: number | null = null, track: number | null = null;
  const base =
    s.replayBase?.gap === s.gap && s.replayBase.at >= (h.readings.at(-1)?.at ?? -Infinity)
      ? s.replayBase
      : settledBase(p, h, s);
  if (base) {
    const { slots } = clockBridged(h.slots);
    const tail = replayOwn(p, slots, base, effectiveSettings(s), now, 0, false, true);
    if (tail.complete) clamp = tail.balance;
    if (s.fit) {
      const tracked = replayOwn(
        p,
        slots,
        { at: base.at, balance: base.track ?? base.balance, exact: true },
        { mul: s.fit.a, add: s.fit.b + s.gap },
        now,
        0,
        // Hostinger's earning rule, as in the settled part: lift tests still earn there.
        true,
      );
      if (tracked.complete) track = tracked.balance;
    }
  }
  return {
    open,
    clamp,
    track,
    acted: c.mode === "apply" && c.clamp.enabled && clamp !== null
      ? Math.min(open, clamp + c.clamp.tolerance * p.capacity)
      : open,
  };
}
// Long reading intervals against the fit: residuals in cores and in sigma, if each reading averaged
// its whole interval or only its last 30 minutes. Evidence for widening the valid spacing, not an
// input.
export function longIntervalResidual(pair: LongPair, fit: MeterFit) {
  const r = (own: number) => pair.host - fit.a * own - fit.b;
  return {
    whole: r(pair.own),
    lastHalfHour: r(pair.ownLast),
    zWhole: r(pair.own) / sigmaAt(fit, pair.own),
    zLastHalfHour: r(pair.ownLast) / sigmaAt(fit, pair.ownLast),
  };
}
function longIntervalResiduals(pairs: LongPair[], fit: MeterFit | null) {
  if (!pairs.length) return null;
  const rs = fit ? pairs.map((r) => longIntervalResidual(r, fit)) : [];
  const average = (k: keyof ReturnType<typeof longIntervalResidual>) =>
    fit ? mean(rs.map((r) => r[k])) : null;
  return {
    count: pairs.length,
    whole: average("whole"),
    lastHalfHour: average("lastHalfHour"),
    zWhole: average("zWhole"),
    zLastHalfHour: average("zLastHalfHour"),
  };
}
// What state.json, hooks and calibrate --explain report about calibration.
export type CalibrationStatus = {
  mode: CalibrationMode;
  start: Settings;
  // The settings in force: in off and shadow the legacy margin and floor. Learned settings exclude
  // the temporary holds.
  applied: Settings;
  learned: Settings;
  hold: CalibrationState["hold"];
  ownHold: CalibrationState["ownHold"];
  gap: number;
  gapUpperBound: number;
  fit: MeterFit | null;
  cusum: Cusum & { pending: CalibrationState["pending"] };
  apiStaleSince: number | null;
  readingsInvalid: boolean;
  newestFinal: boolean;
  // Mean residuals of long-interval pairs against the fit, in cores and in sigma, if each reading
  // averaged its whole interval or only its last half hour.
  longIntervals: {
    count: number;
    whole: number | null;
    lastHalfHour: number | null;
    zWhole: number | null;
    zLastHalfHour: number | null;
  } | null;
  estimates: CalibrationState["estimates"];
  rulesMismatch: boolean;
  // Every rules mismatch in the retained decisions, alerting or not.
  mismatches: {
    at: number;
    onset: number;
    kind: "lift" | "gap";
    value: number | null;
    latched: boolean;
  }[];
  invalidSpans: InvalidSpan[];
  cooldownUntil: number | null;
  lastLimit:
    | {
      class: LimitClass | null;
      onset: number;
      lift: number | null;
      diagnosis: GapDiagnosis | null;
    }
    | null;
};
// `inForce` is what the governor actuates: in off and shadow, the legacy margin and floor.
export function calibrationSummary(
  c: CalibrationConfig,
  state: CalibrationState,
  history: History,
  inForce: Settings = effectiveSettings(state),
): CalibrationStatus {
  const last = history.limits.at(-1), cooldown = sustainedCooldown(history, c, state);
  return {
    mode: c.mode,
    start: c.start,
    applied: { ...inForce },
    learned: state.applied,
    hold: state.hold,
    ownHold: state.ownHold,
    gap: state.gap,
    gapUpperBound: state.gapUpperBound,
    fit: state.fit,
    cusum: { ...state.cusum, pending: state.pending },
    apiStaleSince: state.apiStaleSince,
    readingsInvalid: state.invalid,
    newestFinal: newestFinal(history, state.evaluatedAt),
    longIntervals: longIntervalResiduals(history.longPairs ?? [], state.fit),
    estimates: state.estimates,
    rulesMismatch: state.rulesMismatch,
    // Since the last reset, or apply's first start: what came before doesn't count toward the latch.
    // Since the last reset by the log's order, which a reset sharing its pass's time can't confuse,
    // and since apply's first start.
    mismatches: history.calibrations.slice(
      history.calibrations.findLastIndex((d) => d.trigger === "reset") + 1,
    ).filter((d) => d.trigger === "rules-mismatch" && d.at >= state.startedAt).map((d) => {
      const lift = "ratio" in d.inputs;
      return {
        at: d.at,
        onset: d.inputs.onset as number,
        kind: lift ? "lift" : "gap",
        value: ((lift ? d.inputs.ratio : d.inputs.gap) ?? null) as number | null,
        latched: !!d.inputs.latched,
      };
    }),
    invalidSpans: state.invalidSpans,
    cooldownUntil: cooldown > state.evaluatedAt ? cooldown : null,
    lastLimit: last
      ? {
        class: last.class ?? null,
        onset: last.onset,
        lift: last.lift ?? null,
        diagnosis: last.diagnosis ?? null,
      }
      : null,
  };
}
// Stable digest of recorded inputs, independent of object insertion order.
export function inputsDigest(input: unknown): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object"
      ? `{${
        // Like JSON, which persist.json and history go through, a key without a value is absent.
        Object.entries(v).filter(([, v]) => v !== undefined).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        ).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(v) ?? "null";
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(canonical(input))) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
