// Fixed-seed calibration studies. These synthetic CI days are assumptions, not production traces.
import { Governor, type GovernorIO, openGovernor } from "../src/governor.ts";
import { explainCalibration } from "../src/explain.ts";
import {
  CALIBRATION,
  type CalibrationOptions,
  inputsDigest,
  pairReadings,
  seeded,
} from "../src/calibration.ts";
import { LIMIT_PRESSING, MARGIN, type Reading } from "../src/credits.ts";
import { FLAGS, planKey, readHistory, settledReadings } from "../src/history.ts";
import { MAX_INTERVAL_MS } from "../src/hostinger.ts";
import { testDirectory } from "./temp.ts";
import { plan } from "../src/plans.ts";

export type Study = {
  id: string;
  gap?: number;
  days?: number;
  mode?: "off" | "shadow" | "apply";
  noise?: number;
  drift?: boolean;
  sustained?: boolean;
  neighbours?: boolean;
  // Readings unavailable from day 14 to 16, or over the given days.
  outage?: boolean | { from: number; to: number };
  reboot?: boolean;
  irregular?: boolean;
  clockJump?: boolean;
  clamp?: boolean;
  static?: boolean;
  corrupt?: boolean;
  recoveryPeriod?: number | null;
  // Cores Hostinger's meter adds from day 7, in readings and billing alike: a real jump, not a gap.
  meterJump?: number;
  // A broken feed from day 7: readings report this multiple of the meter, billing does not change.
  readingScale?: number;
  // The workload and meter noise seed; the recorded studies use 13.
  seed?: number;
  // Calibration settings over the study's own.
  calibration?: CalibrationOptions;
  // Called after every control pass with the study clock in seconds, for tools that trace a run.
  observe?: (g: Governor, t: number) => void;
};
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
  { id: "S12", mode: "shadow", drift: true },
  { id: "S13", noise: 1.5 },
  { id: "S14", drift: true },
];
// The study clock counts seconds; history.ts's DAY is in milliseconds.
const DAY_S = 86400;
// S8's VM is down this long for its reboot, so slots and samples miss that time.
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
  // Every study starts with 8 idle hours, which give it a certified-full bank on day 0.
  let nextJob = 8 * 3600, jobDemand = 0.6, jobBusy = false;
  const meter: Reading[] = [{ at: start, v: 0 }];
  let intervalZ = normal();
  let meterSum = 0,
    meterSeconds = 0,
    nextReading = 1500 + Math.floor(random() * 600),
    dayWobble = 0,
    lastDay = -1;
  let restarted = false, clockJumped = false, restoredClock = false;
  let rebootPreserved = false;
  // The first pass after the meter change where the clamp starts holding the acted estimate below
  // the open one. A clamp already holding it at the change doesn't count until it lets go.
  let firstClampAfterDrift: number | null = null, clampHolding = false;
  let corruptionRecovered = false, corrupted = false, gapBilled = 0;
  const quotaPeriods: (number | null | undefined)[] = [];
  // The host's own record of each credit limit, to compare with what the governor saw.
  const hostLimits: { at: number; lift: number | null }[] = [];
  const ceilings: number[] = [];
  let passes = 0, clampPasses = 0;
  // S10's clock steps and the two hours after them, when the clamp must bridge the invalid slots.
  let clockStepPasses = 0, clockStepClampPasses = 0;
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
      const demand = jobDemand;
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
      const steal = ownWant - busy;
      const a = sc.drift && t >= 28 * DAY_S ? 1.07 : 1.0463;
      const noise = (0.0214 + 0.0119 * busy) * (sc.noise ?? 1) * intervalZ;
      // A whole interval shares its residual. Billing and the published mean use that same meter.
      const jump = sc.meterJump && day >= 7 ? sc.meterJump : 0;
      const metered = Math.max(0, a * busy + 0.0193 + jump + dayWobble + noise);
      meterSum += metered;
      meterSeconds++;
      const bill = Math.max(0, metered + (sc.gap ?? 0));
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
      if (t >= nextReading) {
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
  const calibration: CalibrationOptions = {
    mode: sc.mode ?? "apply",
    clamp: { enabled: sc.static ? false : sc.clamp ?? true },
    ...(sc.static
      ? { fit: { min_pairs: 10000 }, cusum: { h: 10000 }, stale: { fallback_s: 30 * DAY_S } }
      : {}),
    ...sc.calibration,
  };
  const cfg = {
    vcpus: 8,
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration,
    recovery: { quota_period_ms: sc.recoveryPeriod },
  };
  const io: GovernorIO = {
    // Kernel uptime has 10 ms resolution: let it run a few milliseconds off the wall clock, so slots
    // can hold slightly more than 600 seconds, as they do on a real box.
    clock: () =>
      Promise.resolve({
        at: start + t * 1000 + wallOffset,
        uptime: uptime * 1000 + Math.floor(t / 30) % 7 * 2,
        bootId: boot,
      }),
    counters: () => Promise.resolve({ busy: busyCount, steal: stealCount, total: totalCount }),
    usage: () =>
      Promise.resolve({ at: start + t * 1000 + wallOffset, total: managedCount, usage: {} }),
    cap: (_s, value, period) => {
      cap = value;
      quotaPeriods.push(period);
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
  const dir = sc.reboot || sc.corrupt ? await testDirectory("calibration-study-") : undefined;
  const paths = dir ? { run: `${dir}/run`, lib: `${dir}/lib` } : undefined;
  if (paths) {
    await Deno.mkdir(paths.run);
    await Deno.mkdir(paths.lib);
  }
  let g = new Governor(cfg, p, undefined, io, paths);
  // Studies that restart the daemon keep history through the daemon's own store.
  if (paths) await g.loadHistory(start);
  let rebootKept = false, ticksAfterCorruption = 0, slowestTickMs = 0, historyReadable = false;
  // Checked at the first pass after the reboot, which has to start from an empty estimate.
  let rebootPending = false;
  let wouldBeLogs = 0;
  const logger = console.log;
  console.log = (...parts: unknown[]) => {
    const line = parts.map(String).join(" "), prefix = "calibration: ";
    if (line.startsWith(prefix)) {
      const decision = JSON.parse(line.slice(prefix.length));
      if (
        decision.mode !== "apply" && JSON.stringify(decision.from) !== JSON.stringify(decision.to)
      ) wouldBeLogs++;
    }
    logger(...parts);
  };
  try {
    while (t < end) {
      if (sc.reboot && !restarted && t >= 7 * DAY_S) {
        restarted = true;
        await g.closeDiagnostics();
        await g.save(start + t * 1000 + wallOffset);
        // A daemon stop waits for queued history writes before the process exits.
        await g.closeHistory();
        const saved = JSON.parse(await Deno.readTextFile(`${paths!.lib}/persist.json`));
        const explained = await explainCalibration(cfg, paths!.lib);
        if (JSON.stringify(explained.learned) !== JSON.stringify(saved.calibration.applied)) {
          throw new Error("replayed calibration differs across reboot");
        }
        // Everything learned survives a reboot; only the bank and the clamp start over.
        const learned = (c: typeof g.calibration) =>
          JSON.stringify({
            applied: c.applied,
            gap: c.gap,
            fit: c.fit,
            cusum: c.cusum,
            pending: c.pending,
            rulesMismatch: c.rulesMismatch,
            invalidSpans: c.invalidSpans,
          });
        const before = {
          learned: learned(g.calibration),
          readings: g.history.readings,
          limits: g.history.limits.length,
        };
        down = true;
        advance(REBOOT_DOWN_S);
        down = false;
        boot = "b";
        uptime = 5;
        busyCount = stealCount = managedCount = 0;
        totalCount = 1000;
        g = await openGovernor(cfg, p, start + t * 1000 + wallOffset, io, paths);
        rebootKept = learned(g.calibration) === before.learned &&
          JSON.stringify(g.history.readings) === JSON.stringify(before.readings) &&
          g.history.limits.length === before.limits;
        rebootPending = true;
      }
      if (sc.corrupt && !corrupted && t >= 7 * DAY_S) {
        // A daemon restart finds its history corrupted.
        corrupted = true;
        const now = start + t * 1000 + wallOffset;
        await g.closeDiagnostics();
        await g.save(now);
        // A daemon stop waits for queued history writes before the process exits.
        await g.closeHistory();
        const path = `${paths!.lib}/history.json`;
        await Deno.writeTextFile(path, "broken");
        g = await openGovernor(cfg, p, now, io, paths);
        corruptionRecovered = (await Deno.stat(`${path}.bad-${Math.floor(now / 1000)}`)).isFile &&
          g.history.readings.length === 0;
      }
      if (sc.clockJump && !clockJumped && t >= 7 * DAY_S) {
        wallOffset += 3_600_000;
        clockJumped = true;
      }
      if (sc.clockJump && !restoredClock && t >= 7 * DAY_S + 3600) {
        wallOffset -= 3_600_000;
        restoredClock = true;
      }
      const tickStarted = performance.now();
      await g.tick();
      if (corrupted) {
        ticksAfterCorruption++;
        slowestTickMs = Math.max(slowestTickMs, performance.now() - tickStarted);
      }
      passes++;
      if (g.calibration.estimates.clamp !== null) clampPasses++;
      if (sc.clockJump && t >= 7 * DAY_S && t < 7 * DAY_S + 3 * 3600) {
        clockStepPasses++;
        if (g.calibration.estimates.clamp !== null) clockStepClampPasses++;
      }
      sc.observe?.(g, t);
      if (rebootPending) {
        rebootPending = false;
        rebootPreserved = rebootKept && g.s.balance === 0 && g.calibration.estimates.acted === 0 &&
          g.history.readings.length > 0 &&
          // A reboot inside a slot keeps that slot open with its mark.
          !!(g.history.slots.at(-1)!.flags & FLAGS.reboot || g.s.rebootPending ||
            (g.s.openSlot?.flags ?? 0) & FLAGS.reboot);
      }
      const holding = g.calibration.estimates.acted < g.calibration.estimates.open;
      if (
        sc.drift && t >= 28 * DAY_S && firstClampAfterDrift === null && holding && !clampHolding
      ) {
        firstClampAfterDrift = t;
      }
      clampHolding = holding;
      // Let background publication complete without making the control tick wait for a request.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      ceilings.push(cap);
      advance(30);
    }
    await g.closeDiagnostics();
    if (paths) {
      await g.save(start + t * 1000 + wallOffset);
      // As the daemon's stop does, wait for queued history writes: this loop never yields to the
      // event loop, so they only progress when it awaits real I/O.
      await g.closeHistory();
      historyReadable = (await readHistory(`${paths.lib}/history.json`, planKey(p), 1)).clean;
    }
    return {
      id: sc.id,
      wouldBeLogs,
      creditLimits: events,
      hostLimits,
      clampShare: clampPasses / passes,
      clockStepClampShare: clockStepPasses ? clockStepClampPasses / clockStepPasses : null,
      limitedHours: limitedSeconds / 3600,
      cpuCoreHours: busyTotal / 3600,
      gap: g.calibration.gap,
      gapBilledCoreSeconds: gapBilled,
      corruptionRecovered,
      ticksAfterCorruption,
      slowestTickMs,
      historyReadable,
      widened: !!g.s.marginLearned,
      // Off and shadow learn with widen(), which marks each limit it ran on; S5 and S6 must not call
      // it, and the legacy margin must stay where it started.
      widenCalls: g.history.limits.filter((l) => l.legacyLearned).length,
      legacyMargin: { ...g.s.margin },
      rebootPreserved,
      firstClampAfterDrift,
      // Nothing changed the settings while a limit lasted, and nothing a limit caused changed them
      // later: its classification, diagnosis or lift check, at any time in the run.
      episodeSettingsUnchanged: g.history.limits.every((l) =>
        !g.history.calibrations.some((d) =>
          (d.at >= l.entry && d.at <= (l.lift ?? Infinity) || d.inputs.onset === l.onset) &&
          JSON.stringify(d.from) !== JSON.stringify(d.to)
        )
      ),
      applied: g.calibration.applied,
      fit: g.calibration.fit,
      episodes: g.history.limits.slice(0, 3).map((r) => {
        const { diagnosisEvidence, ...episode } = r;
        return {
          ...episode,
          caps: r.caps.slice(0, 6),
          capCount: r.caps.length,
          evidenceDigest: diagnosisEvidence ? inputsDigest(diagnosisEvidence) : null,
        };
      }),
      classifications: g.history.limits.map((r) => r.class ?? "unknown"),
      // Each stale fallback with the time its readings went stale, in study seconds.
      fallbacks: g.history.calibrations.filter((d) => d.trigger === "stale-fallback").map((d) => ({
        at: (d.at - start) / 1000,
        since: (d.inputs.since as number - start) / 1000,
      })),
      decisions: g.history.calibrations.map((r) => ({
        at: (r.at - start) / 1000,
        trigger: r.trigger,
        mode: r.mode,
        changed: JSON.stringify(r.from) !== JSON.stringify(r.to),
      })),
      ceilingDigest: inputsDigest(ceilings),
      invalidSlots: g.history.slots.filter((s) => s.flags & FLAGS.clockInvalid).length,
      pairsDuringClockJump:
        pairReadings(p, settledReadings(g.history), g.history.slots).filter((r) =>
          r.at > start + (7 * DAY_S + 3600) * 1000 && r.at <= start + (7 * DAY_S + 7200) * 1000
        ).length,
      readingGaps: g.history.readings.slice(1).filter((r, i) =>
        r.at - g.history.readings[i].at > 2_700_000
      ).length,
      quotaPeriodUsed: quotaPeriods.includes(10),
      quotaPeriodRestored: quotaPeriods.includes(10) &&
        quotaPeriods.lastIndexOf(null) > quotaPeriods.indexOf(10),
    };
  } finally {
    console.log = logger;
    await g.closeHistory();
    if (dir) await Deno.remove(dir, { recursive: true });
  }
}

// How far S9 may sit from the same seed's regular-spacing run: the fit within its noise, the cores
// its margin allows at the baseline within 0.5%, and CPU within S1's 0.3%.
const S9_FIT = { a: 0.005, b: 0.01, allowed: 0.005, cpu: 0.003 };
// Off's legacy margin where every install starts it: nothing widened it.
const legacyKept = (r: { legacyMargin: { mul: number; add: number } }) =>
  r.legacyMargin.mul === MARGIN.mul && r.legacyMargin.add === MARGIN.add;
const allowedCores = (m: { mul: number; add: number }) => (p.baseline - m.add) / m.mul;
// Liveness: a study passes on outcomes, so a feature it relies on could stop working without failing
// it. Every credit limit that lifted and was checked (#13 §7) must have made a prediction.
type Result = Awaited<ReturnType<typeof study>>;
const liftChecksPredicted = (r: Result) =>
  r.episodes.filter((e) => e.class === "credit" && e.liftCheck).every((e) =>
    e.liftCheck!.predicted !== null
  ) && r.episodes.some((e) => e.class === "credit" && e.liftCheck);
export function assessStudy(
  sc: Study,
  r: Awaited<ReturnType<typeof study>>,
  comparison: Awaited<ReturnType<typeof study>> | null,
) {
  const notes: string[] = [];
  const exception = (condition: boolean, message: string) => {
    if (!condition) notes.push(message);
  };
  if (sc.id === "S1") {
    exception(r.creditLimits === 0, "A credit limit occurred.");
    exception(r.clampShare >= 0.99, "The clamp was unavailable on more than 1% of passes.");
    exception(
      comparison !== null && Math.abs(r.cpuCoreHours / comparison.cpuCoreHours - 1) <= 0.003,
      "CPU differs from static by more than 0.3%.",
    );
  }
  if (sc.id === "S2") {
    exception(r.gapBilledCoreSeconds > 0, "The meter model did not charge the hidden billing gap.");
    exception(r.creditLimits <= 1, "More than one credit limit occurred.");
    exception(
      r.gap >= 0.03 && r.gap <= 0.05,
      "No confirmed credit limit identified the 0.03-core gap. The learned gap remains zero when there is no billing evidence.",
    );
    if (r.creditLimits) {
      exception(liftChecksPredicted(r), "The lift check predicted no recovery time.");
    }
  }
  if (sc.id === "S3") {
    exception(r.creditLimits <= 2, "More than two credit limits occurred.");
    exception(r.gap >= 0.1, "The learned gap is below 0.10 cores.");
    if (r.creditLimits) {
      exception(liftChecksPredicted(r), "The lift check predicted no recovery time.");
    }
  }
  if (sc.id === "S4") {
    exception(r.creditLimits <= 1, "More than one credit limit occurred.");
    // Each response must come after the change on day 28: a clamp that starts holding then, and an
    // alarm on that change, which verification later keeps.
    const alarm = r.decisions.find((d) => d.trigger === "cusum-alarm" && d.at >= 28 * DAY_S);
    exception(
      r.firstClampAfterDrift !== null && r.firstClampAfterDrift <= 29 * DAY_S ||
        !!alarm && alarm.at <= 29 * DAY_S,
      "Neither CUSUM nor the clamp acted within 24 hours of drift.",
    );
    exception(
      !!alarm && r.decisions.some((d) => d.trigger === "cusum-keep" && d.at > alarm.at),
      "Verification never kept the drift change.",
    );
  }
  if (sc.id === "S5") {
    exception(
      r.classifications.includes("sustained-use"),
      "The sustained-use episode was not classified.",
    );
    exception(
      r.gap === 0 && r.episodeSettingsUnchanged,
      "The episode changed calibration settings.",
    );
    exception(
      comparison !== null && !comparison.widened && !comparison.widenCalls &&
        legacyKept(comparison) && comparison.episodeSettingsUnchanged &&
        comparison.classifications.includes("sustained-use"),
      "Off mode widened or failed to classify the sustained-use episode.",
    );
    // §5: the estimate the entry reset hid comes back, in both modes.
    exception(
      [r, comparison].every((x) =>
        x?.episodes.some((e) => e.class === "sustained-use" && e.restored)
      ),
      "The sustained-use estimate was not restored.",
    );
  }
  if (sc.id === "S6") {
    exception(
      r.episodes.some((e) => e.firstTest === "lifted") && r.gap === 0 &&
        r.classifications.every((c) => c === "unknown") && r.episodeSettingsUnchanged &&
        !r.widened,
      "The neighbour episode did not pass its first lift test, or something was learned from it.",
    );
    // Apply never calls widen(), so only off can show that the episode taught it nothing.
    exception(
      comparison !== null && comparison.episodes.some((e) => e.firstTest === "lifted") &&
        comparison.classifications.every((c) => c === "unknown") &&
        comparison.episodeSettingsUnchanged && !comparison.widenCalls && legacyKept(comparison),
      "In off, the neighbour episode failed its first lift test or widened the margin.",
    );
  }
  if (sc.id === "S7") {
    // Readings went stale when the last one before the outage settled, and the fallback comes at
    // the first evaluation 24 hours after that: a slot closes every 10 minutes.
    const [fallback, ...others] = r.fallbacks;
    exception(
      r.creditLimits === 0 && !!fallback && !others.length &&
        fallback.since >= 14 * DAY_S - 3 * 3600 && fallback.since <= 14 * DAY_S &&
        fallback.at - fallback.since >= DAY_S && fallback.at - fallback.since <= DAY_S + 630,
      "The outage caused a limit or missed the 24-hour fallback.",
    );
  }
  if (sc.id === "S8") {
    exception(
      r.rebootPreserved && r.creditLimits === 0 && r.historyReadable,
      "The reboot did not keep history and calibration with an empty estimate.",
    );
  }
  if (sc.id === "S9") {
    exception(
      r.creditLimits === 0 && r.fit !== null && r.readingGaps > 0 && r.clampShare >= 0.99,
      "The irregular-reading run lost its fit or clamp, or hit a credit limit.",
    );
    // The same seed with regular spacing: the bridged gaps must not move the fit, the margin or
    // CPU by more than their noise.
    const fit = r.fit, other = comparison?.fit;
    exception(
      !!fit && !!other && Math.abs(fit.a - other.a) <= S9_FIT.a &&
        Math.abs(fit.b - other.b) <= S9_FIT.b &&
        Math.abs(allowedCores(r.applied) / allowedCores(comparison!.applied) - 1) <=
          S9_FIT.allowed &&
        Math.abs(r.cpuCoreHours / comparison!.cpuCoreHours - 1) <= S9_FIT.cpu,
      "The irregular spacing moved the fit, the margin or CPU beyond their noise.",
    );
  }
  if (sc.id === "S10") {
    exception(
      r.invalidSlots > 0 && r.pairsDuringClockJump === 0 && r.creditLimits === 0,
      "The clock jump was not excluded or caused a limit.",
    );
    exception(r.clampShare >= 0.99, "The clamp did not bridge the clock jump.");
    // Over the whole run 1% of passes is about 13 hours, which a one-hour step would hide.
    exception(
      r.clockStepClampShare === 1,
      "The clamp stopped during the clock steps or the two hours after them.",
    );
  }
  if (sc.id === "S11") {
    exception(
      r.corruptionRecovered && r.creditLimits === 0 && r.historyReadable &&
        r.ticksAfterCorruption > 0 && r.slowestTickMs < 1000,
      "History corruption did not rebuild safely, or slowed the passes after it.",
    );
  }
  if (sc.id === "S12") {
    exception(
      comparison !== null && r.ceilingDigest === comparison.ceilingDigest &&
        r.wouldBeLogs > 0,
      "Shadow and off ceilings differ or shadow would-be decisions are missing.",
    );
    for (const x of [r, comparison]) {
      if (x?.creditLimits) {
        exception(liftChecksPredicted(x), `The lift check in ${x.id} predicted no recovery time.`);
      }
    }
  }
  if (sc.id === "S13") {
    exception(r.creditLimits === 0, "The noisier meter caused a credit limit.");
    // R scales with the measured noise: the fit sees about 1.5 times the comparison's noise, and the
    // margin's addition rises by at least half of what scaling R that much predicts.
    const sigma = (f: NonNullable<typeof r.fit>) => f.sigma[0] + f.sigma[1] * 3;
    const ratio = r.fit && comparison?.fit ? sigma(r.fit) / sigma(comparison.fit) : 0;
    exception(
      ratio >= 1.35 && ratio <= 1.65 &&
        r.applied.add - comparison!.applied.add >=
          0.5 * (ratio - 1) * CALIBRATION.premium_ref,
      "The premium did not scale with the measured noise.",
    );
  }
  if (sc.id === "S14") {
    // The comparison only means something if drift detection saw the change in both runs.
    exception(
      [r, comparison].every((x) => x?.decisions.some((d) => d.trigger === "cusum-alarm")),
      "Drift detection did not alarm on the slope change.",
    );
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

export async function runStudies(only?: string) {
  const results: Record<string, unknown>[] = [];
  const log = console.log;
  for (const sc of STUDIES.filter((s) => !only || s.id === only.toUpperCase())) {
    console.log = () => {};
    try {
      const r = await study(sc);
      let comparison = null;
      const against: Partial<Study> | undefined = {
        S1: { static: true },
        S5: { mode: "off" as const },
        S6: { mode: "off" as const },
        S9: { irregular: false },
        S12: { mode: "off" as const },
        S13: { noise: 1 },
        S14: { clamp: false },
      }[sc.id];
      if (against) comparison = await study({ ...sc, id: `${sc.id}-comparison`, ...against });
      const result = { ...r, comparison, assessment: assessStudy(sc, r, comparison) };
      results.push(result);
      log(JSON.stringify(result));
    } finally {
      console.log = log;
    }
  }
  return results;
}

export const RESULTS = "docs/calibration-results.json";
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
