// Fixed-seed studies: eight simulated weeks of a CI workload against a model of Hostinger's meter
// and credit rules, one condition each. These synthetic days are assumptions, not production traces.
import { Governor, type GovernorIO, openGovernor } from "../src/governor.ts";
import { LIMIT_PRESSING, type Reading } from "../src/credits.ts";
import { ESTIMATE } from "../src/estimate.ts";
import { MAX_INTERVAL_MS } from "../src/hostinger.ts";
import { testDirectory } from "./temp.ts";
import { plan } from "../src/plans.ts";

// The generator the studies have always used, so a seed still means the same workload and noise.
export function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(1664525, value) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export type Study = {
  id: string;
  // Cores Hostinger bills above what its readings show.
  gap?: number;
  days?: number;
  noise?: number;
  // The meter's slope rises from 1.0463 to 1.07 on day 28, in readings and billing alike.
  drift?: boolean;
  sustained?: boolean;
  neighbours?: boolean;
  // Readings unavailable from day 14 to 16, or over the given days.
  outage?: boolean | { from: number; to: number };
  reboot?: boolean;
  irregular?: boolean;
  clockJump?: boolean;
  // persist.json is unreadable at a daemon restart on day 7.
  corrupt?: boolean;
  // No Hostinger API configured: the guest's own count alone.
  noReadings?: boolean;
  // Cores Hostinger's meter adds from day 7, in readings and billing alike: a real jump, not a gap.
  meterJump?: number;
  // A broken feed from day 7: readings report this multiple of the meter, billing does not change.
  readingScale?: number;
  // Hostinger publishes no readings over these hours, and never fills them in.
  hole?: { fromDay: number; hours: number };
  // Every core is asked for from this day on.
  flatDemand?: { fromDay: number; cores: number };
  // The box's wall clock runs `ms` off over these hours.
  clockOff?: { fromDay: number; hours: number; ms: number };
  // Neighbours' contention every third day from 10:00 to 13:00 UTC, from day 1: they take up to
  // `cores` of what the guest runs, at most a quarter of it. Hostinger's reading adds `meter`
  // cores per stolen core, as the audited KVM 8's did, and its billing adds `bill`: the reading's
  // unless given, since what the API shows and what the bank is charged are separate facts.
  // With `share`, the contention is steady instead: that share of what runs is stolen all the
  // time, redrawn every 10 seconds within `jitter` of it, as on a host that is always busy.
  contention?: { cores: number; meter: number; bill?: number; share?: number; jitter?: number };
  // The workload and meter noise seed; the recorded studies use 13.
  seed?: number;
  // Called after every control pass with the study clock in seconds, for tools that trace a run.
  observe?: (g: Governor, t: number) => void;
};
// S12 and S14 studied calibration modes that v1.0.0 no longer has.
export const STUDIES: Study[] = [
  { id: "S1", gap: 0 },
  { id: "S2", gap: 0.03 },
  { id: "S3", gap: 0.10 },
  { id: "S4", drift: true },
  { id: "S5", sustained: true },
  { id: "S6", neighbours: true },
  { id: "S7", outage: true },
  { id: "S8", reboot: true },
  { id: "S9", irregular: true },
  { id: "S10", clockJump: true },
  { id: "S11", corrupt: true },
  { id: "S13", noise: 1.5 },
  { id: "S15", contention: { cores: 1, meter: 0.5 } },
  { id: "S16", drift: true, contention: { cores: 0, meter: 0.5, share: 0.02, jitter: 0.25 } },
  { id: "S17", meterJump: 0.5 },
  { id: "S18", readingScale: 8 },
  { id: "S19", noReadings: true },
  { id: "S20", readingScale: 0.5 },
  { id: "S21", hole: { fromDay: 8.24, hours: 2.4 }, flatDemand: { fromDay: 8.25, cores: 8 } },
  { id: "S22", clockOff: { fromDay: 7, hours: 30, ms: 3 * 3_600_000 } },
];
// The study clock counts seconds.
const DAY_S = 86400;
// S8's VM is down this long for its reboot, so its samples miss that time.
const REBOOT_DOWN_S = 900;
// The window the broker serves (tools/hostinger-broker.py): at most 48 hours, starting no earlier
// than 48 hours and ending within 5 minutes of its own clock. A wider request fails as it would on
// a real box.
const SKEW_MS = 300_000;
export function brokerWindow(from: number, to: number, now: number) {
  if (
    !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from ||
    to - from > MAX_INTERVAL_MS || from < now - MAX_INTERVAL_MS - SKEW_MS ||
    Math.abs(to - now) > SKEW_MS
  ) throw new Error("Metrics interval is not authorized.");
}
const p = plan(8);
const start = Date.parse("2026-10-12T00:00:00Z");
export async function study(sc: Study) {
  const end = (sc.days ?? 56) * DAY_S;
  const random = seeded(sc.seed ?? 13);
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(1e-10, random()))) * Math.cos(2 * Math.PI * random());
  let t = 0,
    wallOffset = 0,
    boot = "a",
    uptime = 100,
    busyCount = 0,
    stealCount = 0,
    totalCount = 1000,
    managedCount = 0;
  let cap = 20, bank = p.capacity, limited = false, events = 0, limitedSeconds = 0, busyTotal = 0;
  // The VM is down: nothing runs, and the host's meter sees only its idle draw.
  let down = false;
  let burners = 0,
    sustainedAt: number | null = null,
    normalizedAt: number | null = null,
    sustainedTriggered = false;
  let highSeconds = 0, sustainedMean = 0;
  // Seeded CI jobs at twice the cores of a single CI stream: box A's week, doubled. Weekdays run
  // jobs nearly back to back from 06:00 to 22:00 UTC. Nights and weekends have shorter jobs and
  // long lulls, so the bank refills on most nights.
  const jobRandom = seeded(sc.seed ?? 13);
  // Every study starts with 8 idle hours, which fill the bank on day 0.
  let nextJob = 8 * 3600, jobDemand = 0.6, jobBusy = false;
  const meter: Reading[] = [{ at: start, v: 0 }];
  let intervalZ = normal(), shareZ = 0;
  let meterSum = 0,
    meterSeconds = 0,
    nextReading = 1500 + Math.floor(random() * 600),
    dayWobble = 0,
    lastDay = -1;
  let restarted = false, clockJumped = false, restoredClock = false;
  let corruptionRecovered = false, corrupted = false, gapBilled = 0;
  // The host's own record of each credit limit, to compare with what the governor saw.
  const hostLimits: { at: number; lift: number | null }[] = [];
  const advance = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      const day = Math.floor(t / DAY_S), hour = t % DAY_S / 3600;
      if (day !== lastDay) {
        // Box A's day-level means stay within about 0.02 cores at CI load.
        dayWobble = normal() * 0.01;
        lastDay = day;
      }
      if (t >= nextJob) {
        jobBusy = !jobBusy;
        // The studies start on a Monday.
        const working = day % 7 < 5 && hour >= 6 && hour < 22;
        const singleStreamDemand = jobBusy ? 3 + jobRandom() : 0.2 + 0.5 * jobRandom();
        jobDemand = Math.min(p.vcpus, 2 * singleStreamDemand);
        nextJob += jobBusy
          ? working ? 1800 + Math.floor(jobRandom() * 19800) : 600 + Math.floor(jobRandom() * 3000)
          : working
          ? 300 + Math.floor(jobRandom() * 1500)
          : 1800 + Math.floor(jobRandom() * 5400);
      }
      const demand = sc.flatDemand && t >= sc.flatDemand.fromDay * DAY_S
        ? sc.flatDemand.cores
        : jobDemand;
      const ownWant = down ? 0 : Math.min(
        p.vcpus,
        0.2 + Math.min(Math.max(0, demand - 0.2), cap / 100) + burners,
      );
      let hostCap = p.vcpus;
      if (sc.sustained && !sustainedTriggered && day >= 7 && ownWant >= 4.3) {
        highSeconds++;
        if (highSeconds >= 4 * 3600) {
          sustainedAt = t;
          sustainedTriggered = true;
        }
      }
      if (sustainedAt !== null) {
        hostCap = Math.max(
          0.25 * p.vcpus,
          0.75 * p.vcpus - Math.floor((t - sustainedAt) / 3600) * 0.25 * p.vcpus,
        );
        sustainedMean += (ownWant - sustainedMean) / 600;
        if (sustainedMean < 4.3) normalizedAt ??= t;
        else normalizedAt = null;
        if (normalizedAt !== null && t - normalizedAt >= 3 * 3600) {
          sustainedAt = null;
          hostCap = p.vcpus;
        }
      }
      if (limited) hostCap = Math.min(hostCap, p.limit);
      let busy = Math.min(ownWant, hostCap);
      if (sc.neighbours && day === 7 && hour >= 8 && hour < 8.1) busy *= 0.3;
      // A limit's cap is Hostinger's, not the neighbours': contention shows only outside one.
      let stolen = 0;
      if (sc.contention?.share !== undefined) {
        if (t % 10 === 0) shareZ = normal();
        if (!limited && !down) {
          stolen = Math.max(
            0,
            sc.contention.share * busy * (1 + (sc.contention.jitter ?? 0) * shareZ),
          );
          busy -= stolen;
        }
      } else if (sc.contention && !limited && !down && day % 3 === 1 && hour >= 10 && hour < 13) {
        stolen = Math.min(sc.contention.cores, 0.25 * busy);
        busy -= stolen;
      }
      const steal = ownWant - busy;
      const a = sc.drift && t >= 28 * DAY_S ? 1.07 : 1.0463;
      const noise = (0.0214 + 0.0119 * busy) * (sc.noise ?? 1) * intervalZ;
      // A whole interval shares its residual. Billing and the published mean use that same meter.
      const jump = sc.meterJump && day >= 7 ? sc.meterJump : 0;
      const stealMeter = (sc.contention?.meter ?? 0) * stolen;
      const metered = Math.max(0, a * busy + 0.0193 + jump + dayWobble + noise + stealMeter);
      meterSum += metered;
      meterSeconds++;
      const stealBill = (sc.contention?.bill ?? sc.contention?.meter ?? 0) * stolen;
      const bill = Math.max(0, metered - stealMeter + stealBill + (sc.gap ?? 0));
      gapBilled += bill - metered;
      // The simulated host stops earning while limited at the governor's own pressing test.
      const pressing = limited && steal / Math.max(0.001, ownWant) >= LIMIT_PRESSING;
      bank = Math.max(0, Math.min(p.capacity, bank + (pressing ? 0 : p.baseline) - bill));
      if (!limited && bank <= 0) {
        limited = true;
        events++;
        hostLimits.push({ at: start + t * 1000, lift: null });
      }
      if (limited) {
        limitedSeconds++;
        if (bank >= p.recovered) {
          limited = false;
          hostLimits.at(-1)!.lift = start + t * 1000;
        }
      }
      busyCount += busy * 100;
      stealCount += steal * 100;
      totalCount += p.vcpus * 100;
      managedCount += Math.min(cap / 100, Math.max(0, ownWant - burners - 0.2)) *
        (ownWant ? busy / ownWant : 0) * 1e6;
      busyTotal += busy;
      t++;
      uptime++;
      const inHole = !!sc.hole && t >= sc.hole.fromDay * DAY_S &&
        t < sc.hole.fromDay * DAY_S + sc.hole.hours * 3600;
      if (t >= nextReading && inHole) {
        meterSum = 0;
        meterSeconds = 0;
        nextReading += 1800;
      } else if (t >= nextReading) {
        meter.push({
          at: start + t * 1000,
          v: Math.max(
            0,
            Math.min(
              100,
              meterSum / meterSeconds / p.vcpus * 100 *
                (sc.readingScale && t >= 7 * DAY_S ? sc.readingScale : 1),
            ),
          ),
        });
        meterSum = 0;
        meterSeconds = 0;
        intervalZ = normal();
        // Box A saw one interval longer than 2,700 seconds in ten days; S9 sees one in 31. Both
        // draws happen either way, so S9's regular-spacing comparison meets the same noise.
        const long = random() < 1 / 240, spacing = random();
        nextReading += sc.irregular && meter.length % 31 === 0
          ? 3720
          : long
          ? 2701 + Math.floor(spacing * 1050)
          : 1500 + Math.floor(spacing * 601);
      }
    }
  };
  const demandSample = (ms: number) => {
    const before = { busyCount, stealCount, totalCount };
    advance(ms / 1000);
    const busy = busyCount - before.busyCount, steal = stealCount - before.stealCount;
    return {
      busy: busy / (totalCount - before.totalCount),
      steal: steal / Math.max(1, busy + steal),
      seconds: ms / 1000,
    };
  };
  const outage = typeof sc.outage === "object" ? sc.outage : { from: 14, to: 16 };
  const cfg = {
    vcpus: 8,
    ...(sc.noReadings
      ? {}
      : { hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" } }),
  };
  const io: GovernorIO = {
    // Kernel uptime has 10 ms resolution: let it run a few milliseconds off the wall clock, as it
    // does on a real box.
    clock: () =>
      Promise.resolve({
        at: start + t * 1000 + wallOffset,
        uptime: uptime * 1000 + Math.floor(t / 30) % 7 * 2,
        bootId: boot,
      }),
    counters: () => Promise.resolve({ busy: busyCount, steal: stealCount, total: totalCount }),
    usage: () =>
      Promise.resolve({ at: start + t * 1000 + wallOffset, total: managedCount, usage: {} }),
    cap: (_s, value) => {
      cap = value;
      return Promise.resolve(true);
    },
    ceiling: () => Promise.resolve(cap),
    readings: (_source, _id, from, to) => {
      const now = start + t * 1000 + wallOffset;
      if (sc.outage && t >= outage.from * DAY_S && t < outage.to * DAY_S) {
        return Promise.reject(new Error("outage"));
      }
      try {
        brokerWindow(from, to ?? now, now);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(meter.filter((r) => r.at >= from && r.at <= (to ?? now)));
    },
    hooks: () => Promise.resolve(),
    snapshot: () => Promise.resolve(),
    requestInfo: () => Promise.reject(new Error("unused")),
    requestBody: () => Promise.reject(new Error("unused")),
    pause: (ms) => {
      advance(ms / 1000);
      return Promise.resolve();
    },
    steal: (ms) => Promise.resolve(demandSample(ms).steal),
    demand: (ms) => Promise.resolve(demandSample(ms)),
    burner: () => {
      burners++;
      let stopped = false;
      return {
        status: Promise.resolve({ success: false, code: 124, signal: null }),
        kill: () => {
          if (!stopped) {
            burners--;
            stopped = true;
          }
        },
      };
    },
  };
  const dir = sc.reboot || sc.corrupt ? await testDirectory("study-") : undefined;
  const paths = dir ? { run: `${dir}/run`, lib: `${dir}/lib` } : undefined;
  if (paths) {
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
  }
  let g = new Governor(cfg, p, undefined, io, paths);
  const now = () => start + t * 1000 + wallOffset;
  // The lowest the real bank fell, the most the estimate ran above it outside a limit, and the
  // limits the governor entered that the host never imposed.
  let minBank = Infinity, maxOver = -Infinity, entries = 0, falseEntries = 0;
  const watch = (gov: Governor) => {
    const enter = gov.enterLimit.bind(gov);
    gov.enterLimit = (...args) => {
      entries++;
      if (!limited) falseEntries++;
      return enter(...args);
    };
  };
  watch(g);
  // What the reboot did to the estimate: the real bank and the estimate at the first pass after.
  let reboot: { bank: number; before: number; after: number } | null = null;
  let rebootBefore: number | null = null;
  let ticksAfterCorruption = 0, slowestTickMs = 0;
  // The pad before the sustained-use and neighbour episodes, which must teach nothing.
  const logger = console.log;
  try {
    while (t < end) {
      if (sc.reboot && !restarted && t >= 7 * DAY_S) {
        restarted = true;
        await g.closeDiagnostics();
        await g.save(now());
        rebootBefore = g.s.balance;
        down = true;
        advance(REBOOT_DOWN_S);
        down = false;
        boot = "b";
        uptime = 5;
        busyCount = stealCount = managedCount = 0;
        totalCount = 1000;
        g = await openGovernor(cfg, p, io, paths);
        watch(g);
      }
      if (sc.corrupt && !corrupted && t >= 7 * DAY_S) {
        // A daemon restart finds its saved state unreadable.
        corrupted = true;
        await g.closeDiagnostics();
        await g.save(now());
        const path = `${paths!.lib}/persist.json`;
        await Deno.writeTextFile(path, "broken");
        g = await openGovernor(cfg, p, io, paths);
        watch(g);
        const names = await Array.fromAsync(Deno.readDir(paths!.lib));
        corruptionRecovered = names.some((e) => e.name.startsWith("persist.json.bad-")) &&
          g.s.balance === 0;
      }
      if (sc.clockJump && !clockJumped && t >= 7 * DAY_S) {
        wallOffset += 3_600_000;
        clockJumped = true;
      }
      if (sc.clockJump && !restoredClock && t >= 7 * DAY_S + 3600) {
        wallOffset -= 3_600_000;
        restoredClock = true;
      }
      if (sc.clockOff) {
        const from = sc.clockOff.fromDay * DAY_S;
        wallOffset = t >= from && t < from + sc.clockOff.hours * 3600 ? sc.clockOff.ms : 0;
      }
      const tickStarted = performance.now();
      await g.tick();
      if (corrupted) {
        ticksAfterCorruption++;
        slowestTickMs = Math.max(slowestTickMs, performance.now() - tickStarted);
      }
      sc.observe?.(g, t);
      if (rebootBefore !== null && !reboot && g.s.samples.some((x) => x.uptime !== undefined)) {
        reboot = { bank, before: rebootBefore, after: g.s.balance };
      }
      minBank = Math.min(minBank, bank);
      if (!limited && !g.s.limit) maxOver = Math.max(maxOver, g.s.balance - bank);
      // Let a readings fetch that finished reach the next pass, without making this one wait.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      advance(30);
    }
    await g.closeDiagnostics();
    return {
      id: sc.id,
      creditLimits: events,
      hostLimits,
      limitedHours: limitedSeconds / 3600,
      cpuCoreHours: busyTotal / 3600,
      // Limits the governor entered, and how many of them the host never imposed.
      entries,
      falseEntries,
      minBank,
      maxOver,
      pad: g.s.estimate.pad,
      margin: g.margin,
      gapBilledCoreSeconds: gapBilled,
      sustainedTriggered,
      reboot,
      corruptionRecovered,
      ticksAfterCorruption,
      slowestTickMs,
      readingGaps: g.s.readings.slice(1).filter((r, i) => r.at - g.s.readings[i].at > 2_700_000)
        .length,
    };
  } finally {
    console.log = logger;
    if (dir) await Deno.remove(dir, { recursive: true });
  }
}

type Result = Awaited<ReturnType<typeof study>>;
// What each study must show. Outcomes only: limits Hostinger imposed, CPU delivered, and what the
// estimate did, never which mechanism fired.
export function assessStudy(sc: Study, r: Result, comparison: Result | null) {
  const notes: string[] = [];
  const must = (condition: boolean, message: string) => {
    if (!condition) notes.push(message);
  };
  const noLimit = () => must(r.creditLimits === 0, "A credit limit occurred.");
  const cpuWithin = (share: number, what: string) =>
    must(
      comparison !== null && r.cpuCoreHours >= (1 - share) * comparison.cpuCoreHours,
      `CPU is more than ${share * 100}% below ${what}.`,
    );
  switch (sc.id) {
    case "S1":
      noLimit();
      must(r.falseEntries === 0, "The governor entered a limit the host never imposed.");
      // Following the readings must deliver at least what the own count alone does.
      cpuWithin(0, "the same run without readings");
      break;
    case "S2":
      must(r.gapBilledCoreSeconds > 0, "The meter model did not charge the hidden billing gap.");
      must(r.creditLimits <= 1, "More than one credit limit occurred.");
      if (r.creditLimits) must(r.pad > ESTIMATE.pad, "The limit taught nothing.");
      break;
    case "S3":
      must(r.creditLimits <= 2, "More than two credit limits occurred.");
      must(r.pad >= 0.1, "The learned pad is below the 0.10-core gap.");
      break;
    case "S4":
    case "S7":
    case "S9":
    case "S10":
    case "S13":
    case "S15":
      noLimit();
      break;
    case "S5":
      must(r.sustainedTriggered, "The sustained-use limit never came.");
      must(r.creditLimits === 0, "A credit limit occurred.");
      must(r.pad === ESTIMATE.pad, "The sustained-use limit taught a billing gap.");
      break;
    case "S6":
      noLimit();
      must(r.pad === ESTIMATE.pad, "The neighbour episode taught a billing gap.");
      break;
    case "S8":
      noLimit();
      // The estimate after the reboot may not run above the real bank by more than the floor
      // holds back, and must not have been thrown away either.
      must(
        !!r.reboot && r.reboot.after - r.reboot.bank <= 0.05 * p.capacity &&
          r.reboot.after >= 0.5 * r.reboot.before,
        "The reboot left the estimate far above the bank, or threw it away.",
      );
      break;
    case "S11":
      noLimit();
      must(
        r.corruptionRecovered && r.ticksAfterCorruption > 0 && r.slowestTickMs < 1000,
        "Unreadable state was not set aside safely, or slowed the passes after it.",
      );
      break;
    case "S16":
      noLimit();
      // The neighbours take their 2% either way; charging for it must not take more than
      // another half a percent.
      cpuWithin(0.025, "the same drift without steal");
      break;
    case "S17":
      // The readings show the jump once they settle, up to 100 minutes on. Until then the own
      // count runs half a core short, which may cost one limit and no more.
      must(r.creditLimits <= 1, "More than one credit limit occurred.");
      break;
    case "S18":
      // A feed that reads eight times too high must neither limit the box nor starve it: a
      // reading counts for at most 1.3 times the guest's own CPU and 0.3 cores.
      noLimit();
      cpuWithin(0.2, "the same run with a working feed");
      break;
    case "S19":
      noLimit();
      break;
    case "S20":
      // A feed that reads half the meter says less than the guest counted itself, which no bill
      // can. The own count must stand in: no limit, and about what a box without readings gets.
      noLimit();
      cpuWithin(0.02, "the same run without readings");
      break;
    case "S21":
      // Readings missing for longer than the samples that could stand in for them reach back.
      noLimit();
      break;
    case "S22":
      // A clock three hours ahead lays every sample against the wrong reading.
      noLimit();
      must(
        r.maxOver <= 0.1 * p.capacity,
        "The estimate ran above the bank by more than the floor holds back.",
      );
      break;
  }
  return {
    status: notes.length ? "exception" : "pass",
    notes,
    ...(comparison
      ? {
        cpuCostPercent: (comparison.cpuCoreHours - r.cpuCoreHours) / comparison.cpuCoreHours * 100,
        limitsPrevented: comparison.creditLimits - r.creditLimits,
      }
      : {}),
  };
}

// The run each study is compared with.
const AGAINST: Record<string, Partial<Study>> = {
  S1: { noReadings: true },
  // The same drift on a host without the steady steal: S4.
  S16: { contention: undefined },
  S18: { readingScale: undefined },
  S20: { readingScale: undefined, noReadings: true },
};
export async function runStudies(only?: string, seed?: number) {
  const results: Record<string, unknown>[] = [];
  const log = console.log;
  for (const sc of STUDIES.filter((s) => !only || s.id === only.toUpperCase())) {
    console.log = () => {};
    try {
      const given = seed === undefined ? sc : { ...sc, seed };
      const r = await study(given);
      const against = AGAINST[sc.id];
      const comparison = against
        ? await study({ ...given, id: `${sc.id}-comparison`, ...against })
        : null;
      const result = { ...r, comparison, assessment: assessStudy(sc, r, comparison) };
      results.push(result);
      log(JSON.stringify(result));
    } finally {
      console.log = log;
    }
  }
  return results;
}

export const RESULTS = "docs/study-results.json";
export const WORKLOAD =
  "Seeded CI jobs at twice a single stream: 6-8 requested cores. Weekdays from 06:00 to 22:00 UTC run 0.5-6 hour jobs separated by 5-30 minute lulls at 0.4-1.4 cores; nights and weekends run 10-60 minute jobs separated by 30-120 minute lulls. Day-level meter wobble 0.01 cores. No production traces were available.";
// Record every study, or check that a rerun keeps each recorded outcome.
export async function recordStudies() {
  const results = await runStudies();
  await Deno.writeTextFile(
    RESULTS,
    JSON.stringify(
      {
        seed: 13,
        days: 56,
        start: "2026-10-12T00:00:00Z",
        workload: WORKLOAD,
        runtime: `Deno ${Deno.version.deno}`,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
export async function checkStudies(only?: string): Promise<string[]> {
  const recorded = JSON.parse(await Deno.readTextFile(RESULTS)).results as {
    id: string;
    creditLimits: number;
    assessment: { status: string };
  }[];
  const failures: string[] = [];
  const results = await runStudies(only);
  if (!results.length) failures.push(`${only ?? "all"}: no study ran`);
  for (const result of results) {
    const r = result as (typeof recorded)[number];
    const before = recorded.find((x) => x.id === r.id);
    if (!before) failures.push(`${r.id}: no recorded result`);
    else if (
      before.assessment.status !== r.assessment.status || before.creditLimits !== r.creditLimits
    ) {
      failures.push(
        `${r.id}: ${r.assessment.status} with ${r.creditLimits} limits; recorded ${before.assessment.status} with ${before.creditLimits}`,
      );
    }
  }
  return failures;
}
