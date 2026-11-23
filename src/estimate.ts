// The credit estimate. Hostinger publishes no balance, so the governor replays Hostinger's own CPU
// readings through its published rules (the anchor), and covers the time no settled reading reaches
// yet, 30 to 100 minutes, with the guest's own count (the tail). Readings move the estimate both
// ways. Pure, so the simulators and the daemon run the same arithmetic.
import { type Margin, type Reading, validSpacing } from "./credits.ts";
import type { Plan } from "./plans.ts";

export const ESTIMATE = {
  // What the own count charges for busy CPU: mul x cores + add.
  mul: 1.05,
  add: 0.04,
  // Without a settled reading newer than this, the estimate runs on the own count alone.
  staleMs: 2 * 3_600_000,
  // Cores billed on top of every reading. A confirmed credit limit raises it (learnedPad).
  pad: 0.02,
  // Readings whose difference from the own count sets the addition: about a day of them.
  excessKept: 48,
  excessMin: 8,
};

export type Sample = {
  // Wall clock at the end of the sample, and the seconds of kernel uptime it covers.
  at: number;
  seconds: number;
  // Kernel uptime at the end. Absent on samples from before the last reboot.
  uptime?: number;
  // Shares of the whole VM.
  busy: number;
  steal: number;
  // Cores busy outside the slice.
  outside: number;
  users?: Record<string, number>;
  // A limit probe or lift test ran during it.
  test?: boolean;
  limited?: boolean;
  // False once the wall clock has stepped during or after it: its place among Hostinger's
  // readings is unknown.
  clockValid?: boolean;
  // Whether the bank earned the baseline. Not while pressing on a limit, during a test, or over
  // time the daemon didn't watch.
  earning: boolean;
  unobserved?: boolean;
  // The lowest the estimate read during it, in core-seconds.
  balance?: number;
};

export type Anchor = { at: number; balance: number };
export type Estimate = {
  // The bank at a settled reading's stamp, or where an operator or a lift put it.
  anchor?: Anchor;
  pad: number;
  // How far each recent reading ran above the own count's base charge, in cores.
  excess: number[];
  // When the bank was last known, and how far above the estimate it then was at least: full, or
  // a lift, where Hostinger's bank is at 20% and the estimate restarts lower.
  known: { at: number; slack: number };
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const stale = (readings: Reading[], now: number) =>
  now - (readings.at(-1)?.at ?? -Infinity) > ESTIMATE.staleMs;

// The most the own count may add, in cores. With more, the allowance at the spending floor would
// be under what the governor leaves the VM while it recovers from a credit limit, 0.2 cores under
// the plan's limit: it would hold the box harder in normal running than under a limit. Never
// under the fixed addition, which a low configured baseline would otherwise undercut.
export const mostAdded = (p: Plan) =>
  Math.max(ESTIMATE.add, p.baseline - ESTIMATE.mul * (p.limit - 0.2));

// The own count's margin. The addition is what the last day's readings showed above the own count,
// two deviations up, and never under the fixed one.
export function margin(p: Plan, e: Pick<Estimate, "pad" | "excess">): Margin {
  const xs = e.excess, n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const add = Math.max(ESTIMATE.add, n >= ESTIMATE.excessMin ? mean + 2 * sd : 0);
  return { mul: ESTIMATE.mul, add: Math.min(add + (e.pad - ESTIMATE.pad), mostAdded(p)) };
}

// Stolen cores the own count charges. Hostinger's readings count the neighbours' steal, so the own
// count charges every stolen core whole until a reading says what it cost. A credit limit's own
// steal is not billed, and a limit delivers no more than the plan's limit: steal while the VM
// delivers more than that is the neighbours', and at or under it may be a limit nobody has
// recognised yet. Charged there, the estimate would fall under a limit instead of rising, the
// ceiling would stay shut, and the steal a limit is recognised by would not grow.
export const billedSteal = (p: Plan, x: Pick<Sample, "busy" | "steal" | "limited">) =>
  x.limited || x.busy * p.vcpus <= p.limit + 0.1 ? 0 : x.steal * p.vcpus;

// Cores the own count charges for a sample.
export const ownCharge = (p: Plan, x: Pick<Sample, "busy" | "steal" | "limited">, m: Margin) =>
  m.mul * x.busy * p.vcpus + billedSteal(p, x) + m.add;

// Seconds of [from, to] a sample covers, in wall time. A sample from before a clock step has no
// place among the readings, and one over time the daemon was stopped knows only an average: it
// cannot say when the CPU ran, or check one reading out of the several it spans.
const overlap = (x: Sample, from: number, to: number) =>
  x.clockValid === false || x.unobserved
    ? 0
    : (Math.min(to, x.at) - Math.max(from, x.at - x.seconds * 1000)) / 1000;

// The guest's own count over a stretch of wall time: the seconds its samples cover, and mean busy,
// stolen and charged-steal cores over them.
function own(p: Plan, samples: Sample[], from: number, to: number) {
  let seconds = 0, busy = 0, steal = 0, billed = 0;
  for (const x of samples) {
    const s = overlap(x, from, to);
    if (s <= 0) continue;
    seconds += s;
    busy += x.busy * p.vcpus * s;
    steal += x.steal * p.vcpus * s;
    billed += billedSteal(p, x) * s;
  }
  const mean = (v: number) => seconds ? v / seconds : 0;
  return { seconds, busy: mean(busy), steal: mean(steal), billed: mean(billed) };
}

// Move the anchor through every reading that has settled since it. Returns whether it moved.
// Each reading is Hostinger's mean over the interval since the one before it. Without an anchor
// there is nothing to move: readings from before the governor watched are never replayed, since
// they cannot say whether a limit stopped the bank earning then.
export function settle(p: Plan, e: Estimate, readings: Reading[], samples: Sample[]): boolean {
  // Nor is there without a reading from at or before the anchor: the first interval after it
  // would begin later, and the time between would count for nothing.
  if (!e.anchor || readings.length < 2 || readings[0].at > e.anchor.at) return false;
  let a = e.anchor;
  const before = a.at;
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1], cur = readings[i];
    if (cur.at <= a.at) continue;
    const from = Math.max(prev.at, a.at), seconds = (cur.at - from) / 1000;
    const o = own(p, samples, from, cur.at), covered = o.seconds >= 0.9 * seconds;
    const reading = cur.v / 100 * p.vcpus;
    const m = margin(p, e);
    // Three readings say nothing usable. Nobody knows what one after a long interval averages.
    // One that began before the anchor averages time the anchor already settled. And one under
    // what the guest itself counted cannot be Hostinger's bill for it: the feed is broken.
    const usable = validSpacing(prev.at, cur.at) && prev.at >= a.at &&
      !(covered && reading < o.busy);
    // What the watched seconds cost, as a mean: the reading, or the own count in its place.
    let bill = m.mul * o.busy + o.billed + m.add;
    if (usable) {
      // A reading counts for no more than a generous ceiling on the guest's own count, so a feed
      // that breaks high cannot starve the box.
      const held = covered ? Math.min(reading, 1.3 * o.busy + o.steal + 0.3) : reading;
      bill = held + e.pad;
      if (covered) {
        e.excess = [...e.excess, held - ESTIMATE.mul * o.busy - o.billed].slice(
          -ESTIMATE.excessKept,
        );
      }
    }
    // A reading is a mean, and a bank that sits full for part of its interval forgets what that
    // part earned: spread the bill over the watched seconds in the shape of the own count. Idle
    // throughout, they have no shape, and the bill is spread evenly.
    let balance = a.balance, stepped = 0;
    for (const x of samples) {
      const s = overlap(x, from, cur.at);
      if (s <= 0) continue;
      stepped += s;
      const spent = o.busy > 0 ? bill * x.busy * p.vcpus / o.busy : bill;
      balance = clamp(balance + (p.baseline - spent) * s, 0, p.capacity);
    }
    // The seconds no sample watched earn nothing: a limit may have come and gone, and one pauses
    // earning while work presses on it, which no reading shows. They pay the reading, or without
    // a usable one the most the VM could have spent above what it earned. Under a second over,
    // or less than nothing, is the wall clock and uptime drifting apart, not time nobody watched.
    const rest = seconds - stepped < 1 ? 0 : seconds - stepped;
    balance = clamp(balance - (usable ? bill : maxDrain(p, m)) * rest, 0, p.capacity);
    // Full is a point to measure from, and never an earlier one than is already known.
    if (balance >= p.capacity && cur.at > e.known.at) e.known = { at: cur.at, slack: 0 };
    a = { at: cur.at, balance };
  }
  if (a.at === before) return false;
  e.anchor = a;
  return true;
}

// The estimate now: the anchor, and the own count of every sample since. Time since the anchor that
// no sample covers, as after a reboot or lost state, counts at the most the VM could have spent,
// until the readings that cover it settle.
export function tail(p: Plan, anchor: Anchor, samples: Sample[], m: Margin, now: number): number {
  let balance = anchor.balance, covered = 0;
  for (const x of samples) {
    if (x.clockValid === false) continue;
    const seconds = Math.min(x.seconds, (x.at - anchor.at) / 1000);
    if (seconds <= 0) continue;
    covered += seconds;
    balance = step(p, balance, x, seconds, m);
  }
  const uncovered = (now - anchor.at) / 1000 - covered;
  return uncovered > UNCOVERED_SLACK_S
    ? Math.max(0, balance - maxDrain(p, m) * uncovered)
    : balance;
}
// Wall clock and uptime drift apart by a little; less than this is not a hole.
const UNCOVERED_SLACK_S = 60;
// The most the VM can spend above what it earns, in cores: every vCPU busy at the margin.
export const maxDrain = (p: Plan, m: Margin) => Math.max(0, m.mul * p.vcpus + m.add - p.baseline);

// The balance after `seconds` of a sample.
export const step = (p: Plan, balance: number, x: Sample, seconds: number, m: Margin) =>
  clamp(balance + ((x.earning ? p.baseline : 0) - ownCharge(p, x, m)) * seconds, 0, p.capacity);

// What a confirmed credit limit teaches. The bank emptied while the estimate still showed `entry`,
// `seconds` after the bank was last known with `slack` to spare: that rate is billing the readings
// miss, added to the pad with a quarter extra. Under an hour the rate is mostly noise, so an hour
// counts at least.
export const BILLING_GAP_MAX = 0.2;
export const billingGap = (entry: number, slack: number, seconds: number) =>
  (entry + slack) / Math.max(seconds, 3600);
export const learnedPad = (p: Plan, pad: number, gap: number) =>
  Math.min(pad + clamp(1.25 * gap, 0, 1), mostAdded(p));
