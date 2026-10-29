// Compact, VM-bound evidence. Runtime calculations use the same rounded slots that go on disk.
import { gunzipSync, gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import type {
  CalibrationConfig,
  CalibrationMode,
  CalibrationState,
  GapDiagnosis,
  InvalidSpan,
  LongPair,
  MeterFit,
  Trigger,
} from "./calibration.ts";
import type { Anchor, Margin, Reading } from "./credits.ts";
import { InvalidReadingsError, validReading } from "./hostinger.ts";
import { appendText, parentDirectory, writeText } from "./storage.ts";

export const DAY = 86_400_000;
export const SLOT_MS = 600_000;
export const HISTORY_DAYS = 90;
// Local samples must account for a reading's interval, or a slot's, to within 1%.
export const COVERAGE = 0.01;
export const covered = (seconds: number, duration: number) =>
  seconds >= duration * (1 - COVERAGE) && seconds <= duration * (1 + COVERAGE);
export const FLAGS = {
  limited: 1,
  test: 2,
  pressing: 4,
  clockInvalid: 8,
  reboot: 16,
  noEarn: 32,
  atCapacity: 64,
  // The daemon did not watch this time, after a stop longer than two passes: one sample spread its
  // average over it, so it cannot place the guest's CPU within a reading.
  unobserved: 128,
} as const;
const ALL_FLAGS = Object.values(FLAGS).reduce((a, b) => a | b, 0);
export type Slot = {
  at: number;
  seconds: number;
  busy: number;
  steal: number;
  managed: number;
  outside: number;
  charged: number;
  flags: number;
  // Seconds of the slot that pressed on the limit, when any did. Hostinger stops earning only for
  // those, so one 30-second lift test doesn't stop a whole slot earning.
  pressed?: number;
  // Seconds the governor's own estimate didn't earn, when any: a probe, a lift test, pressing on a
  // limit, or time no sample saw. Replays of that estimate earn for the rest of the slot.
  quiet?: number;
};
export type Settings = Margin & { floor: number };
export const finite = (...ns: unknown[]) =>
  ns.every((n) => typeof n === "number" && Number.isFinite(n));
export const sameSettings = (a: Settings, b: Settings) =>
  a.mul === b.mul && a.add === b.add && a.floor === b.floor;
export const validSettings = (s: Settings) =>
  !!s && finite(s.mul, s.add, s.floor) && s.mul >= 1 && s.add >= 0 && s.floor >= 0;
export const validFit = (f: MeterFit) =>
  !!f && finite(f.a, f.b, f.aHi, f.pairs, f.days) && Array.isArray(f.sigma) &&
  f.sigma.length === 2 && finite(...f.sigma) &&
  (f.sigmaFloor === undefined || finite(f.sigmaFloor) && f.sigmaFloor >= 0);
// A drift change as persist.json and decisions record it (#13 §8).
export const validPending = (v: NonNullable<CalibrationState["pending"]>) =>
  !!v && finite(v.at, v.readings, v.z, v.gapFrom, v.residual, v.n) && validSettings(v.from) &&
  validFit(v.oldFit) && validFit(v.fit) && validSettings(v.hold) &&
  typeof v.verified === "boolean";
export type LimitClass = "credit" | "sustained-use" | "unknown";
export type LimitRecord = {
  onset: number;
  entry: number;
  path: "evident" | "probe" | "operator";
  balance: number;
  used: number;
  settings: Settings;
  gap: number;
  mode: CalibrationMode;
  track: number | null;
  caps: { at: number; busy: number; demand: number; ceiling: number; pressing: boolean }[];
  firstTest?: "limited" | "lifted" | "unknown";
  testDelivery?: { busy: number; demand: number };
  // A failed test's delivery that waits for a later failed test to show it ran into the limit.
  testCandidate?: { busy: number; demand: number };
  legacyLearned?: boolean;
  // Off's legacy margin after widen() learned from this limit.
  legacyMargin?: { mul: number; add: number };
  confirmed: boolean;
  learn: boolean;
  // The last lift test that still found the limit, when the bank was below Hostinger's 20%.
  limitedAt?: number;
  lift?: number;
  recovery?: {
    elapsedSeconds: number;
    estimatedRecoverySeconds: number | null;
    estimatedPausedSeconds: number;
  };
  class?: LimitClass;
  diagnosis?: GapDiagnosis;
  // The temporary hold's gap at entry, when a full own-count step had raised it.
  heldGap?: number;
  // In apply, the clamped estimate the governor acted on at entry, when it was below `balance`.
  acted?: number;
  diagnosisEvidence?: {
    config: CalibrationConfig;
    upper: number;
    fit: MeterFit | null;
    anchor: Anchor | null;
    readings: Reading[];
    slots: Slot[];
    // Whether the diagnosis could use readings, and the readings it treated as invalid.
    readingsUsable?: boolean;
    invalid?: InvalidSpan[];
    fullOwnStep?: boolean;
    // Earlier limit records the diagnosis read, without their own evidence.
    limits?: LimitRecord[];
  };
  restored?: boolean;
  liftCheck?: { at: number; predicted: number | null; ratio: number | null };
};
export type Decision = {
  at: number;
  trigger: Trigger;
  inputs: Record<string, unknown>;
  digest: string;
  from: Settings;
  to: Settings;
  mode: CalibrationMode;
  // Calibration after the decision, so losing persist.json cannot loosen apply.
  learned?: Settings;
  gap?: number;
  rulesMismatch?: boolean;
  // A drift change still holding, which recovery restores; an unverified one starts verification
  // over.
  pending?: NonNullable<CalibrationState["pending"]>;
  // The last drift change point and the learned margin before it, which refits after the change
  // still use (#13 §3).
  fitSince?: number;
  fitFrom?: Settings;
  // Made after apply first ran, when the state carries across modes: recovery may restore from it.
  activated?: true;
  // Readings marked invalid when it was made, which recovery keeps out of fits and replays.
  invalidSpans?: InvalidSpan[];
  // The calibration state's serial after it, which tells a start whether persist.json saw it.
  serial?: number;
};
export type History = {
  planKey: string;
  vmId: number | null;
  since: number;
  readings: Reading[];
  // The newest reading of the last fetch, and when one was first seen again in a later fetch.
  unsettled?: Reading;
  newestSince?: number;
  meterPairs?: { at: number; from: number; own: number; seconds: number }[];
  // Readings after long intervals, paired but kept out of replays (calibration.ts).
  longPairs?: LongPair[];
  revisions: { at: number; old: number; new: number; seenAt: number }[];
  slots: Slot[];
  limits: LimitRecord[];
  calibrations: Decision[];
  checkpoint?: {
    action?: "reset";
    at: number;
    open: number;
    config: CalibrationConfig;
    before: CalibrationState;
    history: Omit<History, "checkpoint">;
    digest: string;
  };
};
export const planKey = (p: { vcpus: number; baseline: number; capacity: number }) =>
  `${p.vcpus}:${p.baseline}:${p.capacity}`;
export function emptyHistory(key: string, vmId: number | null, now: number): History {
  return {
    planKey: key,
    vmId,
    since: now,
    readings: [],
    revisions: [],
    slots: [],
    meterPairs: [],
    limits: [],
    calibrations: [],
  };
}
const round = (n: number) => Math.round(n * 100) / 100;
// A stored reading counts as revised when it moves by more than 0.01 percentage points.
const REVISED = 0.01 + 1e-8;
export const LIMITS_KEPT = 50, DECISIONS_KEPT = 100;
// Revisions only answer whether the newest reading is final. A feed that revised its whole 48-hour
// window on every fetch would otherwise grow the file past what decodes.
export const REVISIONS_KEPT = 1000;
export function boundHistory(h: History, now: number) {
  const cutoff = now - HISTORY_DAYS * DAY;
  // Rows stay in time order, so a pass with nothing to drop keeps the same arrays.
  const after = <T extends { at: number }>(rows: T[]) =>
    (rows[0]?.at ?? Infinity) < cutoff ? rows.slice(firstIndex(rows, (r) => r.at < cutoff)) : rows;
  h.readings = after(h.readings);
  if (h.meterPairs) h.meterPairs = after(h.meterPairs);
  if (h.longPairs) h.longPairs = after(h.longPairs);
  h.revisions = h.revisions.filter((r) => r.seenAt >= cutoff).slice(-REVISIONS_KEPT);
  h.slots = after(h.slots);
  h.limits = h.limits.slice(-LIMITS_KEPT);
  h.calibrations = h.calibrations.slice(-DECISIONS_KEPT);
}
export function mergeReadings(h: History, readings: Reading[], now: number) {
  const map = new Map(h.readings.map((r) => [r.at, r.v]));
  for (const { at, v } of readings) {
    if (!validReading({ at, v }, now)) throw new InvalidReadingsError("invalid CPU metric reading");
    const value = round(v);
    const old = map.get(at);
    if (old !== undefined && Math.abs(value - old) > REVISED) {
      h.revisions.push({ at, old, new: value, seenAt: now });
    }
    map.set(at, value);
  }
  h.readings = [...map].sort(([a], [b]) => a - b).map(([at, v]) => ({ at, v }));
  boundHistory(h, now);
}
// The newest point is not a settled observation. In particular, a timestamp that disappears on
// the next fetch must not survive as a phantom completed interval. Wherever the previous newest
// timestamp comes back, newest again or settled, compare it: that answers whether it was final.
export function mergeFetchReadings(h: History, readings: Reading[], now: number) {
  const sorted = [...readings].sort((a, b) => a.at - b.at);
  if (sorted.some((r) => !validReading(r, now))) {
    throw new InvalidReadingsError("invalid CPU metric reading");
  }
  const newest = sorted.at(-1);
  const again = h.unsettled && sorted.find((r) => r.at === h.unsettled!.at);
  if (h.unsettled && again) {
    h.newestSince ??= now;
    if (Math.abs(round(again.v) - h.unsettled.v) > REVISED) {
      h.revisions.push({ at: again.at, old: h.unsettled.v, new: round(again.v), seenAt: now });
    }
  }
  mergeReadings(h, sorted.slice(0, -1), now);
  h.unsettled = newest ? { ...newest, v: round(newest.v) } : h.unsettled;
}
export function settledReadings(h: History, useNewest = false): Reading[] {
  if (!useNewest || !h.unsettled || h.readings.some((r) => r.at === h.unsettled!.at)) {
    return h.readings;
  }
  return [...h.readings, h.unsettled].sort((a, b) => a.at - b.at);
}
// Seven days of comparing newest readings with their later values, without a revision.
export const newestFinal = (h: History, now: number) =>
  h.newestSince !== undefined && now - h.newestSince >= 7 * DAY &&
  now - (h.revisions.at(-1)?.seenAt ?? -Infinity) >= 7 * DAY;

export type Observation = Omit<Slot, "at" | "seconds" | "pressed" | "quiet"> & {
  from: number;
  to: number;
  seconds: number;
};
// Samples crossing a UTC boundary are split, including gaps and invalid wall-clock intervals.
export function accumulateSlot(
  open: Slot | undefined,
  o: Observation,
): { open?: Slot; closed: Slot[] } {
  const closed: Slot[] = [];
  if (o.to <= o.from || Math.abs((o.to - o.from) / 1000 - o.seconds) > 2) {
    if (open) closed.push(roundedSlot({ ...open, flags: open.flags | FLAGS.clockInvalid }));
    return {
      closed,
      open: {
        at: Math.floor(o.to / SLOT_MS) * SLOT_MS,
        seconds: 0,
        busy: 0,
        steal: 0,
        managed: 0,
        outside: 0,
        charged: 0,
        // The observation's numbers cannot be placed, but a reboot it carries still counts.
        flags: FLAGS.clockInvalid | (o.flags & FLAGS.reboot),
      },
    };
  }
  let cursor = o.from;
  while (cursor < o.to) {
    const at = Math.floor(cursor / SLOT_MS) * SLOT_MS;
    if (open && open.at !== at) {
      closed.push(roundedSlot(open));
      open = undefined;
    }
    const end = Math.min(o.to, at + SLOT_MS);
    const share = (end - cursor) / (o.to - o.from);
    if (!open) {
      open = {
        at,
        seconds: 0,
        busy: 0,
        steal: 0,
        managed: 0,
        outside: 0,
        charged: 0,
        flags: o.flags,
      };
    }
    // Certification requires the entire slot to have stayed at capacity.
    const allFull = (open.flags & FLAGS.atCapacity) && (o.flags & FLAGS.atCapacity);
    open.flags = (open.flags | o.flags) & ~FLAGS.atCapacity;
    if (allFull) open.flags |= FLAGS.atCapacity;
    for (const k of ["seconds", "busy", "steal", "managed", "outside", "charged"] as const) {
      open[k] += o[k] * share;
    }
    if (o.flags & FLAGS.pressing) open.pressed = (open.pressed ?? 0) + o.seconds * share;
    if (o.flags & FLAGS.noEarn) open.quiet = (open.quiet ?? 0) + o.seconds * share;
    cursor = end;
    if (end === at + SLOT_MS) {
      closed.push(roundedSlot(open));
      open = undefined;
    }
  }
  return { open, closed };
}
export function roundedSlot(s: Slot): Slot {
  const { pressed, quiet, ...rest } = s;
  const slot = {
    ...rest,
    seconds: round(s.seconds),
    busy: round(s.busy),
    steal: round(s.steal),
    managed: round(s.managed),
    outside: round(s.outside),
    charged: round(s.charged),
  };
  // Never more than the slot's own seconds, which round separately. Seconds that round to nothing
  // keep the smallest step: a slot flagged pressing without them counts as pressing throughout, so
  // 4 ms of a sample crossing into it cost the slot its whole earning.
  const kept = (n: number | undefined) =>
    n && n > 0 ? Math.min(Math.max(0.01, round(n)), slot.seconds) : 0;
  const p = kept(pressed), q = kept(quiet);
  return { ...slot, ...(p > 0 ? { pressed: p } : {}), ...(q > 0 ? { quiet: q } : {}) };
}
// The closed slots with the open one, merged as addSlots will merge it when it closes: after a
// backward clock step, the slot it reopens is marked clock-invalid instead of appearing twice.
export function withOpenSlot(slots: Slot[], open: Slot | undefined): Slot[] {
  if (!open) return slots;
  const slot = roundedSlot(open);
  if (!slots.length || slots.at(-1)!.at < slot.at) return [...slots, slot];
  const i = slots.findLastIndex((s) => s.at === slot.at);
  if (i >= 0) return slots.with(i, { ...slots[i], flags: slots[i].flags | FLAGS.clockInvalid });
  return [...slots, slot].sort((a, b) => a.at - b.at);
}
export function addSlots(h: History, slots: Slot[]) {
  let unordered = false;
  for (const slot of slots) {
    const i = h.slots.findLastIndex((s) => s.at === slot.at);
    if (i >= 0) {
      // A new array, not a change in place, so the store sees the flag (Persisted).
      h.slots = h.slots.with(i, { ...h.slots[i], flags: h.slots[i].flags | FLAGS.clockInvalid });
      continue;
    }
    unordered ||= (h.slots.at(-1)?.at ?? -Infinity) > slot.at;
    h.slots.push(slot);
  }
  // Slots close in time order unless the clock stepped back, so most passes need no sort. A sorted
  // insert is a new array, like any change that isn't an append (Persisted).
  if (unordered) h.slots = h.slots.toSorted((a, b) => a.at - b.at);
}

// Binary search over rows in time order: the first index whose row is not `before`.
export function firstIndex<T>(rows: T[], before: (row: T) => boolean): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before(rows[mid])) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
type RowReference<T> = { from: number; to: number; updates: T[]; removed: number[] };
const ascending = (rows: { at: number }[]) => rows.every((r, i) => !i || rows[i - 1].at < r.at);
function referenceRows<T extends { at: number }>(
  current: T[],
  previous: T[],
  keys: (keyof T)[],
): RowReference<T> {
  const from = previous[0]?.at ?? 0, to = previous.at(-1)?.at ?? -1;
  const updates: T[] = [], removed: number[] = [];
  if (ascending(current) && ascending(previous)) {
    // Both lists are in time order, so one merge pass finds every difference.
    let i = firstIndex(current, (r) => r.at < from), j = 0;
    while (j < previous.length || i < current.length && current[i].at <= to) {
      const now = i < current.length && current[i].at <= to ? current[i] : undefined;
      const was = previous[j];
      if (was && (!now || was.at < now.at)) {
        updates.push(was);
        j++;
      } else if (now && (!was || now.at < was.at)) {
        removed.push(now.at);
        i++;
      } else {
        if (keys.some((k) => was[k] !== now![k])) updates.push(was);
        i++;
        j++;
      }
    }
    return { from, to, updates, removed };
  }
  const byAt = new Map(current.map((r) => [r.at, r])), known = new Set(previous.map((r) => r.at));
  return {
    from,
    to,
    updates: previous.filter((r) => {
      const now = byAt.get(r.at);
      return !now || keys.some((k) => r[k] !== now[k]);
    }),
    removed: current.filter((r) => r.at >= from && r.at <= to && !known.has(r.at)).map((r) => r.at),
  };
}
function restoreRows<T extends { at: number }>(current: T[], ref: RowReference<T>): T[] {
  if (!ref || !Array.isArray(ref.updates) || !Array.isArray(ref.removed)) {
    throw new Error("invalid evidence reference");
  }
  const removed = new Set(ref.removed);
  const rows = new Map(
    current.filter((r) => r.at >= ref.from && r.at <= ref.to && !removed.has(r.at)).map((
      r,
    ) => [r.at, r]),
  );
  for (const row of ref.updates) rows.set(row.at, row);
  return [...rows.values()].sort((a, b) => a.at - b.at).map((r) => ({ ...r }));
}
const SLOT_KEYS: (keyof Slot)[] = [
  "at",
  "seconds",
  "busy",
  "steal",
  "managed",
  "outside",
  "charged",
  "flags",
  "pressed",
  "quiet",
];
type Evidence = NonNullable<LimitRecord["diagnosisEvidence"]>;
// Recorded inputs are mostly rows still in the retained history. Store only their differences,
// including revisions, overwritten clock flags and the partial open slot.
type EncodedEvidence = Omit<Evidence, "slots" | "readings"> & {
  references: { slots: RowReference<Slot>; readings: RowReference<Reading> };
};
function encodeEvidenceOf(h: Pick<History, "slots" | "readings">, evidence: Evidence) {
  const { slots, readings, ...rest } = evidence;
  return {
    ...rest,
    references: {
      slots: referenceRows(h.slots, slots, SLOT_KEYS),
      readings: referenceRows(h.readings, readings, ["at", "v"]),
    },
  };
}
function decodeEvidenceOf(h: Pick<History, "slots" | "readings">, encoded: EncodedEvidence) {
  const { references, ...evidence } = encoded;
  if (!references) throw new Error("invalid diagnosis evidence");
  return {
    ...evidence,
    slots: restoreRows(h.slots, references.slots),
    readings: restoreRows(h.readings, references.readings),
  };
}
function encodeEvidence(h: History, record: LimitRecord) {
  const evidence = record.diagnosisEvidence;
  return evidence ? { ...record, diagnosisEvidence: encodeEvidenceOf(h, evidence) } : record;
}
function decodeEvidence(h: Pick<History, "slots" | "readings">, record: LimitRecord) {
  const encoded = record.diagnosisEvidence as unknown as EncodedEvidence | undefined;
  return encoded ? { ...record, diagnosisEvidence: decodeEvidenceOf(h, encoded) } : record;
}
function encodeCheckpoint(h: History) {
  const checkpoint = h.checkpoint;
  if (!checkpoint) return undefined;
  const evidence = checkpoint.history;
  return {
    ...checkpoint,
    history: {
      ...evidence,
      slots: undefined,
      readings: undefined,
      meterPairs: undefined,
      limits: undefined,
    },
    references: {
      limits: {
        ids: evidence.limits.map((r) => r.onset),
        updates: evidence.limits.filter((r) => {
          const current = h.limits.find((l) => l.onset === r.onset);
          return !current || JSON.stringify(current) !== JSON.stringify(r);
        }).map((r) => encodeEvidence(h, r)),
      },
      slots: referenceRows(h.slots, evidence.slots, SLOT_KEYS),
      readings: referenceRows(h.readings, evidence.readings, ["at", "v"]),
      meterPairs: evidence.meterPairs
        ? referenceRows(h.meterPairs ?? [], evidence.meterPairs, ["at", "from", "own", "seconds"])
        : undefined,
    },
  };
}

// Observed seconds come from kernel uptime at 10 ms resolution and wall-clock slot boundaries, so a
// slot can hold a little more than 600 seconds. Anything near double is corruption.
const MAX_SLOT_SECONDS = 2 * SLOT_MS / 1000;
// Slots and readings are integer tuples in centicore-seconds and centipercent, so 90 days of them
// fit well below 1 MB on KVM 8.
// Pressed and quiet seconds trail the tuple only when a slot has them, so most tuples keep eight
// numbers.
const slotTuple = (s: Slot, epoch: number) => [
  (s.at - epoch) / 1000,
  s.seconds,
  ...[s.busy, s.steal, s.managed, s.outside, s.charged].map((v) => Math.round(v * 100)),
  s.flags,
  ...(s.pressed || s.quiet ? [s.pressed ?? 0] : []),
  ...(s.quiet ? [s.quiet] : []),
];
const slotOf = (
  [at, seconds, busy, steal, managed, outside, charged, flags, pressed, quiet]: number[],
  epoch = 0,
): Slot => ({
  at: at * 1000 + epoch,
  seconds,
  busy: busy / 100,
  steal: steal / 100,
  managed: managed / 100,
  outside: outside / 100,
  charged: charged / 100,
  flags,
  ...(pressed ? { pressed } : {}),
  ...(quiet ? { quiet } : {}),
});
const readingTuple = (r: Reading) => [r.at / 1000, Math.round(r.v * 100)];
const readingOf = ([at, v]: number[]) => ({ at: at * 1000, v: v / 100 });
type Revision = History["revisions"][number];
const revisionTuple = (r: Revision) => [
  r.at / 1000,
  Math.round(r.old * 100),
  Math.round(r.new * 100),
  r.seenAt / 1000,
];
const revisionOf = ([at, old, value, seenAt]: number[]) => ({
  at: at * 1000,
  old: old / 100,
  new: value / 100,
  seenAt: seenAt * 1000,
});
function validTuples(data: { readings?: unknown; revisions?: unknown; slots?: unknown }) {
  const tuples = (rows: unknown, ...lengths: number[]) =>
    rows === undefined ||
    Array.isArray(rows) && rows.every((r) =>
        Array.isArray(r) && lengths.includes(r.length) &&
        r.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
      );
  return tuples(data.revisions, 4) && tuples(data.readings, 2) && tuples(data.slots, 8, 9, 10) &&
    ((data.readings ?? []) as number[][]).every((r) => r[1] <= 10000) &&
    ((data.slots ?? []) as number[][]).every((s) =>
      s[1] <= MAX_SLOT_SECONDS && Number.isInteger(s[7]) && (s[7] & ~ALL_FLAGS) === 0 &&
      s.slice(8).every((n) => n <= s[1] + 0.01)
    );
}
function decodeCheckpoint(h: History, encoded: unknown): History["checkpoint"] {
  const checkpoint = structuredClone(encoded) as NonNullable<History["checkpoint"]> & {
    references?: {
      slots: RowReference<Slot>;
      readings: RowReference<Reading>;
      meterPairs?: RowReference<NonNullable<History["meterPairs"]>[number]>;
      limits: { ids: number[]; updates: LimitRecord[] };
    };
  };
  const refs = checkpoint?.references;
  if (!refs || !checkpoint.history) throw new Error("invalid calibration checkpoint");
  checkpoint.history.slots = restoreRows(h.slots, refs.slots);
  checkpoint.history.readings = restoreRows(h.readings, refs.readings);
  if (refs.meterPairs) {
    checkpoint.history.meterPairs = restoreRows(h.meterPairs ?? [], refs.meterPairs);
  }
  const limits = new Map(h.limits.map((r) => [r.onset, r]));
  for (const limit of refs.limits.updates) limits.set(limit.onset, decodeEvidence(h, limit));
  checkpoint.history.limits = refs.limits.ids.map((onset) => {
    const limit = limits.get(onset);
    if (!limit) throw new Error("missing checkpoint limit");
    return structuredClone(limit);
  });
  delete checkpoint.references;
  if (
    !Number.isFinite(checkpoint.at) || !checkpoint.before || !checkpoint.config ||
    !Array.isArray(checkpoint.history.slots) || !Array.isArray(checkpoint.history.readings)
  ) throw new Error("invalid calibration checkpoint");
  return checkpoint;
}
// Each record on its own, so a reader can drop a bad one and keep the rest.
const validMeterPair = (r: MeterPair) =>
  !!r && finite(r.at, r.from, r.own, r.seconds) && r.from < r.at && r.own >= 0 && r.own <= 128 &&
  covered(r.seconds, (r.at - r.from) / 1000);
const validLongPair = (r: LongPair) =>
  !!r && finite(r.at, r.from, r.host, r.own, r.ownLast) && r.from < r.at;
const validSpan = (x: InvalidSpan) =>
  !!x && finite(x.from) && (x.to === null || finite(x.to) && x.to >= x.from) &&
  (x.applied === undefined || validSettings(x.applied)) && (x.gap === undefined || finite(x.gap));
const nullOrFinite = (n: unknown) => n === null || finite(n);
const optionalFinite = (n: unknown) => n === undefined || finite(n);
const optionalBoolean = (b: unknown) => b === undefined || typeof b === "boolean";
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const validAnchor = (a: Anchor) =>
  isObject(a) && finite(a.at, a.balance) && typeof a.exact === "boolean";
// Explain prints a diagnosis field by field, so each must have its type.
const validDiagnosis = (d: GapDiagnosis) =>
  isObject(d) && nullOrFinite(d.gap) && ["readings", "own", "unavailable"].includes(d.source) &&
  (d.anchor === null || validAnchor(d.anchor)) && finite(d.onset, d.eta) &&
  typeof d.explained === "boolean" && nullOrFinite(d.left) && optionalBoolean(d.beyond) &&
  optionalFinite(d.bridged) && optionalFinite(d.held) && optionalFinite(d.lower);
const validEarlier = (limits: unknown) =>
  limits === undefined ||
  Array.isArray(limits) && limits.every((r) => validLimit(r) && r.diagnosisEvidence === undefined);
// Exported so a limit record from persist.json gets the same check before history adopts it.
export const validLimit = (r: LimitRecord): boolean =>
  isObject(r) && finite(r.onset, r.entry, r.balance, r.used, r.gap) &&
  validSettings(r.settings) &&
  ["off", "shadow", "apply"].includes(r.mode) &&
  ["evident", "probe", "operator"].includes(r.path) &&
  typeof r.confirmed === "boolean" && typeof r.learn === "boolean" &&
  // A record v0.2.5's limit carried over, or an older build wrote, may lack the estimate.
  (r.track === undefined || nullOrFinite(r.track)) &&
  Array.isArray(r.caps) && r.caps.every((c) =>
    isObject(c) && finite(c.at, c.busy, c.demand, c.ceiling) && typeof c.pressing === "boolean"
  ) &&
  (r.firstTest === undefined || ["limited", "lifted", "unknown"].includes(r.firstTest)) &&
  [r.testDelivery, r.testCandidate].every((t) =>
    t === undefined || isObject(t) && finite(t.busy, t.demand)
  ) &&
  optionalBoolean(r.legacyLearned) && optionalBoolean(r.restored) &&
  (r.legacyMargin === undefined ||
    isObject(r.legacyMargin) && finite(r.legacyMargin.mul, r.legacyMargin.add) &&
      r.legacyMargin.mul >= 1 && r.legacyMargin.add >= 0) &&
  optionalFinite(r.lift) && optionalFinite(r.limitedAt) && optionalFinite(r.heldGap) &&
  optionalFinite(r.acted) &&
  (r.class === undefined || ["credit", "sustained-use", "unknown"].includes(r.class)) &&
  (r.diagnosis === undefined || validDiagnosis(r.diagnosis)) &&
  // Its rows are checked as they are decoded, which differs between the files and persist.json. The
  // earlier records a diagnosis read are records too, kept without their own inputs.
  (r.diagnosisEvidence === undefined || isObject(r.diagnosisEvidence) && validEarlier(
        (r.diagnosisEvidence as { limits?: unknown }).limits,
      )) &&
  (r.liftCheck === undefined ||
    isObject(r.liftCheck) && finite(r.liftCheck.at) && nullOrFinite(r.liftCheck.predicted) &&
      nullOrFinite(r.liftCheck.ratio)) &&
  (r.recovery === undefined ||
    isObject(r.recovery) && finite(r.recovery.elapsedSeconds, r.recovery.estimatedPausedSeconds) &&
      nullOrFinite(r.recovery.estimatedRecoverySeconds));
const validDecision = (r: Decision) =>
  !!r && finite(r.at) && typeof r.trigger === "string" && !!r.inputs &&
  typeof r.inputs === "object" && !Array.isArray(r.inputs) &&
  validSettings(r.from) && validSettings(r.to) &&
  (r.learned === undefined || validSettings(r.learned)) &&
  (r.gap === undefined || finite(r.gap)) &&
  (r.pending === undefined || validPending(r.pending)) &&
  (r.fitSince === undefined || finite(r.fitSince)) &&
  (r.fitFrom === undefined || validSettings(r.fitFrom)) &&
  (r.activated === undefined || r.activated === true) &&
  (r.serial === undefined || Number.isSafeInteger(r.serial)) &&
  (r.invalidSpans === undefined ||
    Array.isArray(r.invalidSpans) && r.invalidSpans.every(validSpan));
function validateHistory(h: History) {
  for (const list of [h.readings, h.slots]) {
    if (list.some((r: { at: number }, i: number) => i > 0 && r.at <= list[i - 1].at)) {
      throw new Error("unordered history");
    }
  }
  if (
    !finite(h.since) || h.unsettled && !validReading(h.unsettled, Infinity) ||
    h.newestSince !== undefined && !finite(h.newestSince)
  ) throw new Error("invalid unsettled reading");
  if (h.meterPairs && (!Array.isArray(h.meterPairs) || !h.meterPairs.every(validMeterPair))) {
    throw new Error("invalid meter pairing");
  }
  if (h.longPairs && (!Array.isArray(h.longPairs) || !h.longPairs.every(validLongPair))) {
    throw new Error("invalid long-interval pairing");
  }
  if (!h.limits.every(validLimit) || !h.calibrations.every(validDecision)) {
    throw new Error("invalid history records");
  }
}

// A daily snapshot, history.json, and an append-only log, history.log, of what changed since it.
// The snapshot is a VM-bound envelope around gzipped JSON. Its generation and sequence tell which
// log lines extend it: lines from an older generation, left by a crash during compaction, are
// ignored.
const VERSION = 1;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
export type HistoryMeta = { generation: number; seq: number; compactedAt: number };
export function encodeHistory(h: History, meta?: HistoryMeta): string {
  const epoch = h.slots[0]?.at ?? 0;
  const payload = JSON.stringify({
    ...meta,
    since: h.since,
    unsettled: h.unsettled,
    newestSince: h.newestSince,
    meterPairs: h.meterPairs,
    longPairs: h.longPairs,
    limits: h.limits.map((r) => encodeEvidence(h, r)),
    calibrations: h.calibrations,
    checkpoint: encodeCheckpoint(h),
    slotEpoch: epoch / 1000,
    revisions: h.revisions.map(revisionTuple),
    readings: h.readings.map(readingTuple),
    slots: h.slots.map((s) => slotTuple(s, epoch)),
  });
  return JSON.stringify({
    version: VERSION,
    planKey: h.planKey,
    vmId: h.vmId,
    data: gzipSync(payload).toString("base64"),
  });
}
// A bad envelope, version, plan, VM or row tuple rejects the snapshot. A record that fails its own
// check is dropped and named in `dropped`, as a bad log line is: one daemon bug must not cost 90 days.
// History recorded without a VM had no readings, so nothing in it came from another meter: it binds
// to the configured VM. History bound to a VM stays bound when the config names none, for the next
// check, as calibration state in persist.json does. Only two different VMs mismatch. Before, adding
// `vm_id`, as rollout step 2 does, cost the history and limit records gathered without it.
export const sameVm = (recorded: number | null, configured: number | null) =>
  recorded === null || configured === null || recorded === configured;
export function decodeSnapshot(
  text: string,
  key: string,
  vmId: number | null,
): { history: History; meta: HistoryMeta; dropped: string[]; rebound: boolean } {
  const envelope = JSON.parse(text);
  if (
    !envelope || envelope.version !== VERSION || envelope.planKey !== key ||
    !(envelope.vmId === null || Number.isSafeInteger(envelope.vmId)) ||
    !sameVm(envelope.vmId, vmId) || typeof envelope.data !== "string"
  ) throw new Error("invalid or mismatched history");
  const data = JSON.parse(
    gunzipSync(Buffer.from(envelope.data, "base64"), { maxOutputLength: MAX_DECODED_BYTES })
      .toString(),
  );
  if (
    !data || !Number.isFinite(data.since) || !Number.isFinite(data.slotEpoch) ||
    ![data.readings, data.revisions, data.slots, data.limits, data.calibrations].every(
      Array.isArray,
    )
  ) throw new Error("invalid history");
  if (!validTuples(data)) throw new Error("invalid history evidence");
  for (const rows of [data.meterPairs, data.longPairs]) {
    if (rows !== undefined && !Array.isArray(rows)) throw new Error("invalid history");
  }
  const dropped: string[] = [];
  const valid = <T>(rows: T[], check: (r: T) => boolean, name: string) => {
    const kept = rows.filter(check);
    if (kept.length < rows.length) dropped.push(`${name} (${rows.length - kept.length})`);
    return kept;
  };
  const rows = {
    readings: data.readings.map(readingOf),
    slots: data.slots.map((t: number[]) => slotOf(t, data.slotEpoch * 1000)),
  };
  let evidenceDropped = 0;
  const limits = valid(data.limits as LimitRecord[], validLimit, "limit records").map((r) => {
    const decoded = withEvidence(r, () => decodeEvidence(rows, r));
    if (decoded === r) return r;
    if (!decoded.diagnosisEvidence) evidenceDropped++;
    return decoded;
  });
  if (evidenceDropped) dropped.push(`diagnosis inputs (${evidenceDropped})`);
  const h: History = {
    planKey: key,
    vmId: vmId ?? envelope.vmId,
    since: data.since,
    ...rows,
    revisions: data.revisions.map(revisionOf),
    limits,
    calibrations: valid(data.calibrations as Decision[], validDecision, "decisions"),
    ...(data.unsettled ? { unsettled: data.unsettled } : {}),
    ...(data.newestSince !== undefined ? { newestSince: data.newestSince } : {}),
    ...(data.meterPairs
      ? { meterPairs: valid(data.meterPairs as MeterPair[], validMeterPair, "meter pairs") }
      : {}),
    ...(data.longPairs
      ? { longPairs: valid(data.longPairs as LongPair[], validLongPair, "long-interval pairs") }
      : {}),
  };
  validateHistory(h);
  if (data.checkpoint) {
    // Explain waits for the next evaluation without it.
    try {
      h.checkpoint = decodeCheckpoint(h, data.checkpoint);
    } catch {
      dropped.push("calibration checkpoint (1)");
    }
  }
  const meta = {
    generation: data.generation ?? 0,
    seq: data.seq ?? 0,
    compactedAt: data.compactedAt ?? data.since,
  };
  if (![meta.generation, meta.seq, meta.compactedAt].every(Number.isFinite)) {
    throw new Error("invalid history generation");
  }
  return { history: h, meta, dropped, rebound: h.vmId !== envelope.vmId };
}
export const decodeHistory = (text: string, key: string, vmId: number | null) =>
  decodeSnapshot(text, key, vmId).history;

// Each line is checked on its own, so a line that can't be read ends the replay instead of
// discarding the file. Records in it are checked after, one by one (keptRecords).
function validLine(line: LogLine) {
  if (
    !Number.isSafeInteger(line.seq) || !validTuples(line) ||
    [line.meterPairs, line.longPairs, line.calibrations].some((rows) =>
      rows !== undefined && !Array.isArray(rows)
    ) ||
    line.removed !== undefined &&
      !(line.removed && typeof line.removed === "object" &&
        Object.values(line.removed).every((ats) =>
          Array.isArray(ats) && ats.every(Number.isFinite)
        )) ||
    line.revisionsDropped !== undefined &&
      !(Number.isSafeInteger(line.revisionsDropped) && line.revisionsDropped > 0) ||
    line.newestSince !== undefined && line.newestSince !== null &&
      !Number.isFinite(line.newestSince) ||
    line.limitOrder !== undefined &&
      !(Array.isArray(line.limitOrder) && line.limitOrder.every(Number.isFinite)) ||
    line.limits !== undefined &&
      !(Array.isArray(line.limits) && line.limits.every((l) => l?.record))
  ) return false;
  try {
    validateHistory({
      planKey: "",
      vmId: null,
      since: line.since ?? 0,
      ...(line.unsettled ? { unsettled: line.unsettled } : {}),
      ...(typeof line.newestSince === "number" ? { newestSince: line.newestSince } : {}),
      readings: [],
      revisions: [],
      slots: [],
      limits: [],
      calibrations: [],
    });
    return true;
  } catch {
    return false;
  }
}
// A record in a line that fails its check is dropped alone, as in the snapshot, and named in
// `dropped`; the rest of the line and the lines after it still replay.
function keptRecords(line: LogLine, dropped: string[]) {
  const keep = <T>(rows: T[] | undefined, check: (r: T) => boolean, name: string) => {
    if (!rows) return rows;
    const kept = rows.filter(check);
    if (kept.length < rows.length) dropped.push(`${name} (${rows.length - kept.length})`);
    return kept;
  };
  line.meterPairs = keep(line.meterPairs, validMeterPair, "meter pairs");
  line.longPairs = keep(line.longPairs, validLongPair, "long-interval pairs");
  line.calibrations = keep(line.calibrations, validDecision, "decisions");
  line.limits = keep(line.limits, (l) => validLimit(l.record), "limit records");
}
// One log line: the rows, records and fields that changed since the previous line, by value.
type MeterPair = NonNullable<History["meterPairs"]>[number];
type LogLine = {
  generation: number;
  seq: number;
  since?: number;
  unsettled?: Reading | null;
  newestSince?: number | null;
  slots?: number[][];
  readings?: number[][];
  meterPairs?: MeterPair[];
  longPairs?: LongPair[];
  revisions?: number[][];
  calibrations?: Decision[];
  // Records without evidence; `evidence` is absent when unchanged and null when removed.
  limits?: { record: LimitRecord; evidence?: EncodedEvidence | null }[];
  limitOrder?: number[];
  checkpoint?: unknown;
  // Rows the history no longer holds, such as those past the 90-day cutoff, by time, and how many of
  // the oldest revisions it dropped.
  removed?: { slots?: number[]; readings?: number[]; meterPairs?: number[]; longPairs?: number[] };
  revisionsDropped?: number;
};
// Times the history no longer holds, which the reader removes too. The rows are unique by time and
// every one of them is recorded by now, so a recorded set no larger than them has lost none.
function gone(known: Map<number, unknown> | Set<number>, rows: { at: number }[]): number[] {
  if (known.size <= rows.length) return [];
  const present = new Set(rows.map((r) => r.at)), out: number[] = [];
  for (const at of known.keys()) {
    if (present.has(at)) continue;
    known.delete(at);
    out.push(at);
  }
  return out;
}
// A record with its evidence decoded, or without the evidence when that fails to decode or to check:
// the record still counts, and only explain loses its inputs.
function withEvidence(r: LimitRecord, decode: () => LimitRecord): LimitRecord {
  if (!r.diagnosisEvidence) return r;
  try {
    const decoded = decode();
    if (validLimit(decoded)) return decoded;
  } catch { /* Dropped below. */ }
  return withoutEvidence(r);
}
const withoutEvidence = (r: LimitRecord) => {
  const copy = { ...r };
  delete copy.diagnosisEvidence;
  return copy;
};
const sameSlot = (a: Slot, b: Slot) =>
  a.seconds === b.seconds && a.busy === b.busy && a.steal === b.steal &&
  a.managed === b.managed && a.outside === b.outside && a.charged === b.charged &&
  a.flags === b.flags && (a.pressed ?? 0) === (b.pressed ?? 0) && (a.quiet ?? 0) === (b.quiet ?? 0);
const sameRevision = (a: Revision, b: Revision) =>
  a.at === b.at && a.old === b.old && a.new === b.new && a.seenAt === b.seenAt;
// What the files hold, row by row. A governor updating a limit record in place shows up as changed
// values; rows are replaced, never changed in place.
class Persisted {
  slots = new Map<number, Slot>();
  readings = new Map<number, number>();
  meterPairs = new Map<number, MeterPair>();
  longPairs = new Set<number>();
  revisions: Revision[] = [];
  calibrations = new WeakSet<Decision>();
  limits = new Map<number, { json: string; evidence: Evidence | undefined }>();
  limitOrder = "";
  since = 0;
  unsettled = "";
  newestSince: number | undefined;
  checkpoint: History["checkpoint"];
  // Each row array as last seen, its length and its last row.
  private rows = new Map<string, { rows: unknown[]; length: number; last: unknown }>();
  constructor(h: History) {
    this.changes(h);
  }
  // Passes append rows; anything else, such as a late clock flag, pruning or a fetch's merge,
  // replaces the array. So only an array not seen before needs reading whole; one seen before needs
  // only what was appended since. Most passes append nothing, and comparing 90 days of slots on
  // every pass would cost 2 ms without the JIT. The rule is checked, not trusted: the array seen
  // before must still end its known part with the same row, or it is read whole. A slot sorted
  // into place once looked appended and never reached the log.
  private unseen<T>(key: string, rows: T[]): { rows: T[]; whole: boolean } {
    const known = this.rows.get(key);
    this.rows.set(key, { rows, length: rows.length, last: rows.at(-1) });
    const appended = known?.rows === rows && known.length <= rows.length &&
      (known.length === 0 || rows[known.length - 1] === known.last);
    return appended ? { rows: rows.slice(known!.length), whole: false } : { rows, whole: true };
  }
  // Records the current values and returns those that differ from what was recorded before.
  changes(h: History): Omit<LogLine, "generation" | "seq"> | null {
    const line: Omit<LogLine, "generation" | "seq"> = {};
    if (h.since !== this.since) line.since = this.since = h.since;
    const unsettled = JSON.stringify(h.unsettled ?? null);
    if (unsettled !== this.unsettled) {
      this.unsettled = unsettled;
      line.unsettled = h.unsettled ?? null;
    }
    if (h.newestSince !== this.newestSince) {
      this.newestSince = h.newestSince;
      line.newestSince = h.newestSince ?? null;
    }
    const seen = {
      slots: this.unseen("slots", h.slots),
      readings: this.unseen("readings", h.readings),
      meterPairs: this.unseen("meterPairs", h.meterPairs ?? []),
      longPairs: this.unseen("longPairs", h.longPairs ?? []),
    };
    const slots = seen.slots.rows.filter((s) => {
      const known = this.slots.get(s.at);
      if (known && sameSlot(known, s)) return false;
      this.slots.set(s.at, { ...s });
      return true;
    });
    if (slots.length) line.slots = slots.map((s) => slotTuple(s, 0));
    const readings = seen.readings.rows.filter((r) => {
      if (this.readings.get(r.at) === r.v) return false;
      this.readings.set(r.at, r.v);
      return true;
    });
    if (readings.length) line.readings = readings.map(readingTuple);
    const pairs = seen.meterPairs.rows.filter((r) => {
      const known = this.meterPairs.get(r.at);
      if (known && known.from === r.from && known.own === r.own && known.seconds === r.seconds) {
        return false;
      }
      this.meterPairs.set(r.at, { ...r });
      return true;
    });
    if (pairs.length) line.meterPairs = pairs;
    // Long-interval pairs are added once and never change.
    const long = seen.longPairs.rows.filter((r) => !this.longPairs.has(r.at));
    for (const r of long) this.longPairs.add(r.at);
    if (long.length) line.longPairs = long;
    // Rows can only go from an array that was replaced; one that only grew lost none.
    const removed = {
      slots: seen.slots.whole ? gone(this.slots, h.slots) : [],
      readings: seen.readings.whole ? gone(this.readings, h.readings) : [],
      meterPairs: seen.meterPairs.whole ? gone(this.meterPairs, h.meterPairs ?? []) : [],
      longPairs: seen.longPairs.whole ? gone(this.longPairs, h.longPairs ?? []) : [],
    };
    if (Object.values(removed).some((ats) => ats.length)) {
      line.removed = Object.fromEntries(
        Object.entries(removed).filter(([, ats]) => ats.length),
      ) as LogLine["removed"];
    }
    // Revisions only grow; pruning drops the oldest. Anything past the recorded tail is new.
    const last = this.revisions.at(-1);
    const after = last ? h.revisions.findLastIndex((r) => sameRevision(r, last)) + 1 : 0;
    const revisions = h.revisions.slice(after);
    if (revisions.length) line.revisions = revisions.map(revisionTuple);
    // Pruning drops the oldest revisions; every recorded one before the tail found above is gone.
    if (this.revisions.length > after) line.revisionsDropped = this.revisions.length - after;
    this.revisions = h.revisions.map((r) => ({ ...r }));
    const decisions = h.calibrations.filter((d) => !this.calibrations.has(d));
    for (const d of decisions) this.calibrations.add(d);
    if (decisions.length) line.calibrations = decisions;
    const limits: NonNullable<LogLine["limits"]> = [];
    for (const r of h.limits) {
      const known = this.limits.get(r.onset);
      const json = JSON.stringify(withoutEvidence(r));
      const evidenceChanged = r.diagnosisEvidence !== known?.evidence;
      if (known && known.json === json && !evidenceChanged) continue;
      this.limits.set(r.onset, { json, evidence: r.diagnosisEvidence });
      limits.push({
        record: withoutEvidence(r),
        ...(evidenceChanged || !known
          ? { evidence: r.diagnosisEvidence ? encodeEvidenceOf(h, r.diagnosisEvidence) : null }
          : {}),
      });
    }
    if (limits.length) line.limits = limits;
    const order = h.limits.map((r) => r.onset).join(",");
    if (order !== this.limitOrder) {
      this.limitOrder = order;
      line.limitOrder = h.limits.map((r) => r.onset);
    }
    if (h.checkpoint !== this.checkpoint) {
      this.checkpoint = h.checkpoint;
      line.checkpoint = encodeCheckpoint(h) ?? null;
    }
    return Object.keys(line).length ? line : null;
  }
}

// The snapshot and its log as text. Only filesystem errors come from here; decoding comes after.
// A reader beside the daemon, such as explain, can meet a compaction between the two reads: an old
// snapshot with the new log would miss the day's lines unnoticed, so it reads them again.
export async function readHistoryFiles(
  path: string,
  read: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<{ snapshot: string; log: string }> {
  for (let attempt = 1;; attempt++) {
    const snapshot = await read(path);
    const log = await read(logPath(path)).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return "";
      throw error;
    });
    if (attempt === 3 || await read(path) === snapshot) return { snapshot, log };
  }
}
// `rebound`: history recorded without a VM, now bound to the configured one.
type Decoded = {
  history: History;
  meta: HistoryMeta;
  clean: boolean;
  dropped: string[];
  rebound: boolean;
};
export async function readHistory(
  path: string,
  key: string,
  vmId: number | null,
): Promise<Decoded> {
  return decodeHistoryFiles(await readHistoryFiles(path), key, vmId);
}
// The snapshot and every log line of its generation, in order. A line that cannot be read ends the
// replay; a record that fails its check, in the snapshot or a line, is dropped alone. Either way
// the store compacts on its next write.
// Only the last checkpoint is decoded, against the rows as they stood at its line.
export function decodeHistoryFiles(
  files: { snapshot: string; log: string },
  key: string,
  vmId: number | null,
): Decoded {
  const { history: h, meta, dropped, rebound } = decodeSnapshot(files.snapshot, key, vmId);
  const text = files.log;
  const lines: LogLine[] = [];
  // A last line that lost only its newline still parses, but the next append would join it into
  // one line the following replay can't read, so the store compacts instead of appending.
  let clean = !dropped.length && (!text || text.endsWith("\n")), seq = meta.seq;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: LogLine;
    try {
      line = JSON.parse(raw);
    } catch {
      clean = false;
      break;
    }
    if (!line || line.generation !== meta.generation) continue;
    if (line.seq !== seq + 1 || !validLine(line)) {
      clean = false;
      break;
    }
    const before = dropped.length;
    keptRecords(line, dropped);
    if (dropped.length > before) clean = false;
    seq = line.seq;
    lines.push(line);
  }
  const slots = new Map(h.slots.map((s) => [s.at, s]));
  const readings = new Map(h.readings.map((r) => [r.at, r]));
  const pairs = new Map((h.meterPairs ?? []).map((r) => [r.at, r]));
  const limits = new Map(h.limits.map((r) => [r.onset, r]));
  let order = h.limits.map((r) => r.onset);
  const rows = () => {
    h.slots = [...slots.values()].sort((a, b) => a.at - b.at);
    h.readings = [...readings.values()].sort((a, b) => a.at - b.at);
    if (h.meterPairs || pairs.size) h.meterPairs = [...pairs.values()].sort((a, b) => a.at - b.at);
    h.limits = order.map((onset) => limits.get(onset)).filter((r): r is LimitRecord => !!r);
  };
  const lastCheckpoint = lines.findLastIndex((l) => l.checkpoint !== undefined);
  // Recorded inputs that no longer restore are dropped; explain then waits for the next evaluation.
  const decoded = <T>(decode: () => T, name: string) => {
    try {
      return decode();
    } catch {
      clean = false;
      dropped.push(name);
      return undefined;
    }
  };
  try {
    lines.forEach((line, i) => {
      if (line.since !== undefined) h.since = line.since;
      for (const at of line.removed?.slots ?? []) slots.delete(at);
      for (const at of line.removed?.readings ?? []) readings.delete(at);
      for (const at of line.removed?.meterPairs ?? []) pairs.delete(at);
      if (line.removed?.longPairs) {
        const removed = new Set(line.removed.longPairs);
        h.longPairs = h.longPairs?.filter((r) => !removed.has(r.at));
      }
      if (line.revisionsDropped) h.revisions.splice(0, line.revisionsDropped);
      if (line.unsettled !== undefined) {
        if (line.unsettled) h.unsettled = line.unsettled;
        else delete h.unsettled;
      }
      if (line.newestSince !== undefined) {
        if (line.newestSince === null) delete h.newestSince;
        else h.newestSince = line.newestSince;
      }
      for (const t of line.slots ?? []) slots.set(t[0] * 1000, slotOf(t));
      for (const t of line.readings ?? []) readings.set(t[0] * 1000, readingOf(t));
      for (const r of line.meterPairs ?? []) pairs.set(r.at, r);
      if (line.longPairs) h.longPairs = [...h.longPairs ?? [], ...line.longPairs];
      h.revisions.push(...(line.revisions ?? []).map(revisionOf));
      h.calibrations.push(...(line.calibrations ?? []));
      if (line.limits?.some((l) => l.evidence) || i === lastCheckpoint) rows();
      for (const { record, evidence } of line.limits ?? []) {
        // A record dropped from an earlier line can still be in its order.
        if (!limits.has(record.onset) && !order.includes(record.onset)) order.push(record.onset);
        const kept = evidence === undefined
          ? limits.get(record.onset)?.diagnosisEvidence
          : evidence && decoded(() => decodeEvidenceOf(h, evidence), "diagnosis inputs (1)");
        const next = kept ? { ...record, diagnosisEvidence: kept } : record;
        // Evidence that decodes but fails its check goes alone, as in the snapshot; left in, it
        // failed the whole history at the end of the replay.
        if (kept && !validLimit(next)) {
          clean = false;
          dropped.push("diagnosis inputs (1)");
          limits.set(record.onset, record);
        } else limits.set(record.onset, next);
      }
      if (line.limitOrder) order = line.limitOrder;
      if (i === lastCheckpoint) {
        rows();
        const checkpoint = line.checkpoint
          ? decoded(() => decodeCheckpoint(h, line.checkpoint), "calibration checkpoint (1)")
          : undefined;
        if (checkpoint) h.checkpoint = checkpoint;
        else delete h.checkpoint;
      }
    });
    rows();
    // The daemon drops the oldest limits and decisions as it appends; every reader keeps the same.
    h.limits = h.limits.slice(-LIMITS_KEPT);
    h.calibrations = h.calibrations.slice(-DECISIONS_KEPT);
    validateHistory(h);
  } catch {
    throw new Error("invalid history log");
  }
  return { history: h, meta: { ...meta, seq }, clean, dropped, rebound };
}
export const logPath = (path: string) => path.replace(/\.json$/, "") + ".log";

// Quarantined files stay for inspection, but only the newest few: of `<path>.bad-<unix>`, the three
// newest. persist.json's quarantine uses it too.
const QUARANTINE_KEPT = 3;
export async function pruneQuarantine(path: string): Promise<void> {
  const dir = parentDirectory(path), prefix = `${path.slice(path.lastIndexOf("/") + 1)}.bad-`;
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.startsWith(prefix)) names.push(e.name);
    }
  } catch {
    return;
  }
  const stamp = (name: string) => Number(name.slice(prefix.length)) || 0;
  for (const name of names.sort((a, b) => stamp(b) - stamp(a)).slice(QUARANTINE_KEPT)) {
    await Deno.remove(`${dir}/${name}`).catch(() => {});
  }
}
const MAX_QUEUED = 64, WRITE_RETRY_MS = 600_000;
type Write = { snapshot: string } | { line: string };
export class HistoryStore {
  private pending = Promise.resolve();
  private queue: Write[] = [];
  private writing = false;
  private persisted?: Persisted;
  private meta: HistoryMeta = { generation: 0, seq: 0, compactedAt: -Infinity };
  // Bytes handed to the filesystem, for the disk budget.
  written = 0;
  // The files exist but this run could not read them: leave them for the next run, write nothing.
  unreadable = false;
  // A failed encode or write leaves history behind what the daemon holds until a later snapshot
  // succeeds. persist.json, written every pass, records that, so the next start knows its copy of
  // the open limit record is the newer one (#13 §1).
  private behind = false;
  private wroteAt = -Infinity;
  private retryAt = -Infinity;
  constructor(readonly path: string, private readonly log: (message: string) => void) {}
  get logPath() {
    return logPath(this.path);
  }
  // Everything handed to write() so far is on disk, once close() has settled.
  get durable() {
    return !this.unreadable && !this.behind;
  }
  async load(key: string, vmId: number | null, now: number): Promise<History> {
    let files;
    try {
      files = await readHistoryFiles(this.path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        this.log("history rebuilt: missing");
        // A log without its snapshot can't be replayed, but the first compaction would empty it.
        // It's set aside for inspection instead.
        const stamp = Math.floor(now / 1000);
        const kept = await Deno.rename(this.logPath, `${this.logPath}.bad-${stamp}`).then(
          () => true,
          (failure) => {
            if (!(failure instanceof Deno.errors.NotFound)) {
              this.log(`history log without a snapshot not set aside: ${failure}`);
            }
            return false;
          },
        );
        if (kept) {
          this.log("history log without a snapshot set aside");
          await pruneQuarantine(this.logPath);
        }
      } else {
        // A transient EACCES or EIO must not cost 90 days of evidence.
        this.unreadable = true;
        this.log(`history unreadable, left in place and not written this run: ${error}`);
      }
      this.persisted = undefined;
      return emptyHistory(key, vmId, now);
    }
    try {
      const { history, meta, clean, dropped, rebound } = decodeHistoryFiles(files, key, vmId);
      if (dropped.length) {
        this.log(`history: dropped invalid ${dropped.join(", ")}; compacting on the next write`);
      } else if (!clean) this.log("history log ends early; compacting on the next write");
      // The snapshot records the VM at once, so a later config can't bind the same history to
      // another VM after this one's readings joined it.
      if (rebound) this.log(`history bound to VM ${history.vmId}; compacting on the next write`);
      this.meta = meta;
      // What the files hold, so rows that aged out since they were written are logged as removed.
      this.persisted = clean && !rebound ? new Persisted(history) : undefined;
      boundHistory(history, now);
      return history;
    } catch {
      this.log("history rebuilt: invalid or mismatched");
      for (const path of [this.path, this.logPath]) {
        await Deno.rename(path, `${path}.bad-${Math.floor(now / 1000)}`).catch(() => {});
        await pruneQuarantine(path);
      }
      this.persisted = undefined;
      return emptyHistory(key, vmId, now);
    }
  }
  // Appends what changed; once a day, or after any failure, rewrites the snapshot and starts a new
  // log. Encoding happens after the pass sets its ceiling, and a failure costs a write, never a pass.
  write(history: History, now: number) {
    if (this.unreadable) return;
    // After a failure the next write is a whole snapshot, about 125 ms without the JIT. While the
    // disk keeps failing, that is tried every 10 minutes rather than every pass.
    if (!this.persisted && now < this.retryAt && this.retryAt - now <= WRITE_RETRY_MS) return;
    this.wroteAt = now;
    try {
      // A compaction stamped while the clock ran ahead must not hold off the next one until the
      // clock catches up.
      if (
        !this.persisted || now - this.meta.compactedAt >= DAY || now < this.meta.compactedAt ||
        this.queue.length >= MAX_QUEUED
      ) {
        this.meta = {
          generation: Math.max(now, this.meta.generation + 1),
          seq: 0,
          compactedAt: now,
        };
        const snapshot = encodeHistory(history, this.meta);
        this.persisted = new Persisted(history);
        // The snapshot holds everything the queued lines would have added.
        this.queue = [{ snapshot }];
      } else {
        const changes = this.persisted.changes(history);
        if (!changes) return;
        const line = { generation: this.meta.generation, seq: this.meta.seq + 1, ...changes };
        this.meta.seq = line.seq;
        this.queue.push({ line: JSON.stringify(line) + "\n" });
      }
    } catch (error) {
      this.persisted = undefined;
      this.behind = true;
      this.retryAt = now + WRITE_RETRY_MS;
      this.log(`history not encoded: ${error instanceof Error ? error.message : "unknown error"}`);
      return;
    }
    if (!this.writing) this.drain();
  }
  private drain() {
    this.writing = true;
    this.pending = (async () => {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        try {
          if ("snapshot" in next) {
            await writeText(this.path, next.snapshot, 0o600, true);
            // A crash before this reset leaves old-generation lines, which the reader ignores. The
            // new log is synced too, or a power cut could bring back the old one under the lines
            // appended after it.
            await writeText(this.logPath, "", 0o600, true);
            this.written += next.snapshot.length;
            this.behind = false;
          } else {
            await appendText(this.logPath, next.line, 0o600);
            this.written += next.line.length;
          }
        } catch (error) {
          // A gap would end the next replay early. Start over with a full snapshot.
          this.queue = [];
          this.persisted = undefined;
          this.behind = true;
          this.retryAt = this.wroteAt + WRITE_RETRY_MS;
          this.log(
            `history write failed: ${
              error instanceof Error ? error.message : "unknown write error"
            }`,
          );
        }
      }
    })().finally(() => {
      this.writing = false;
      if (this.queue.length) this.drain();
    });
  }
  async close() {
    do {
      await this.pending;
    } while (this.writing);
  }
}
