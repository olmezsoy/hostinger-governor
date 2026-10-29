// governor calibrate --explain: replay the recorded calibration decision, read-only.
import {
  calculateEstimates,
  calibrationSummary,
  diagnoseGap,
  effectiveSettings,
  fallbackMargin,
  FIT_SEED,
  fitMeter,
  historyAnchors,
  openEstimates,
  pairReadings,
  replayCheckpoint,
} from "./calibration.ts";
import { LAW } from "./credits.ts";
import { type Config, detectPlan, PATHS, type Private } from "./governor.ts";
import type { Plan } from "./plans.ts";
import {
  boundHistory,
  DAY,
  decodeHistoryFiles,
  planKey,
  readHistoryFiles,
  sameSettings,
  type Settings,
  withOpenSlot,
} from "./history.ts";

// The daemon's files are private to it. Say what a failed read means in plain words, not as the
// operating system's error.
async function readState<T>(path: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${path} does not exist yet: the daemon has not saved its state`);
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new Error(
        `cannot read ${path}: calibrate --explain needs root or the governor user, ` +
          "as in sudo governor calibrate --explain",
      );
    }
    if (error instanceof SyntaxError) throw new Error(`${path} does not parse`);
    throw error;
  }
}

const READ_ATTEMPTS = 5, READ_PAUSE_MS = 200;
// persist.json and history as one save left them. The daemon writes history, then persist.json, every
// pass. Reading persist.json on both sides of history catches a save that lands between the reads,
// and the serial every evaluation and reset counts catches one whose history write came just before
// them. Either way the files are read again.
async function readDaemonFiles(cfg: Config, p: Plan, lib: string, read: Read) {
  const persist = `${lib}/persist.json`, historyPath = `${lib}/history.json`;
  for (let attempt = 1;; attempt++) {
    const text = await readState(persist, () => read(persist));
    const saved = await readState(persist, () => Promise.resolve(JSON.parse(text) as Private));
    if (saved.planKey !== planKey(p)) throw new Error("persisted plan differs from config");
    // The daemon's own reader: the daily snapshot plus every line appended since.
    const files = await readState(historyPath, () => readHistoryFiles(historyPath, read));
    const again = await readState(persist, () => read(persist));
    if (text !== again) {
      if (attempt < READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, READ_PAUSE_MS));
        continue;
      }
      throw new Error("the daemon saved during every read of its files; run it again");
    }
    const { history } = await readState(
      historyPath,
      () => Promise.resolve(decodeHistoryFiles(files, planKey(p), cfg.hostinger?.vm_id ?? null)),
    );
    const checkpoint = history.checkpoint;
    if (!checkpoint) {
      throw new Error(
        "no recorded calibration evaluation; wait for the next completed slot or fetch",
      );
    }
    const replayed = replayCheckpoint(p, checkpoint);
    if (!replayed) throw new Error("calibration evidence differs from its recorded evaluation");
    const serial = saved.calibration?.serial, recorded = replayed.state.serial;
    if (serial !== undefined && recorded !== undefined && serial !== recorded) {
      if (attempt < READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, READ_PAUSE_MS));
        continue;
      }
      throw new Error(
        `persist.json holds evaluation ${serial} and history evaluation ${recorded}; run it ` +
          "again, and if they still differ, check the daemon's log for failed writes",
      );
    }
    return { saved, history, checkpoint, replayed };
  }
}
type Read = (path: string) => Promise<string>;

// Uses the recorded evaluation time, never wall time.
export async function explainCalibration(
  cfg: Config,
  lib = PATHS.lib,
  read: Read = Deno.readTextFile,
) {
  const p = await detectPlan(cfg);
  const { saved, history, checkpoint, replayed } = await readDaemonFiles(cfg, p, lib, read);
  // The daemon prunes what it holds at every write; the log only appends between compactions.
  boundHistory(history, saved.at ?? checkpoint.at);
  const c = checkpoint.config;
  const calibration = replayed.state;
  // The current open bank is a local tick input, recorded in persistence. Recompute the tail from
  // it, without migrating the saved mode through the constructor.
  const h = {
    ...checkpoint.history,
    slots: withOpenSlot(history.slots, saved.openSlot),
  };
  calibration.estimates = checkpoint.action === "reset"
    ? openEstimates(saved.balance)
    : calculateEstimates(p, h, calibration, c, saved.at, saved.balance);
  const diagnosed = history.limits.findLast((r) => r.diagnosisEvidence);
  const inputs = diagnosed?.diagnosisEvidence;
  // The settings in force: off and shadow actuate the legacy margin and floor. While calibration
  // fails, apply holds the fallback and acts below the open estimate, as the daemon does.
  const failed = c.mode === "apply" ? saved.evaluationFailed : undefined;
  const inForce = c.mode !== "apply"
    ? { ...saved.margin, floor: LAW.floor }
    : failed
    ? fallbackMargin(effectiveSettings(calibration))
    : effectiveSettings(calibration);
  if (failed) {
    const e = calibration.estimates;
    calibration.estimates = {
      ...e,
      acted: Math.min(e.acted, Math.max(0, saved.balance - failed.behind)),
    };
  }
  return {
    ...calibrationSummary(c, calibration, history, inForce),
    failing: failed ? { since: failed.since, behind: failed.behind } : null,
    evidence: {
      at: checkpoint.at,
      digest: checkpoint.digest,
      verified: true,
      fit: calibration.fit,
      candidateFit: fitMeter(
        pairReadings(
          p,
          checkpoint.history.readings,
          checkpoint.history.slots,
          checkpoint.history.meterPairs,
        ).filter((r) => r.at >= checkpoint.at - c.fit.days * DAY),
        c.fit,
        FIT_SEED,
        checkpoint.at,
      ),
      anchors: historyAnchors(p, checkpoint.history, calibration.gapUpperBound),
      estimates: calibration.estimates,
      decisions: replayed.changes,
      limits: replayed.limits.map((l) => ({ ...l, diagnosisEvidence: undefined })),
      // The last diagnosis, rerun from the inputs it recorded.
      diagnosis: diagnosed && inputs
        ? {
          onset: diagnosed.onset,
          recorded: diagnosed.diagnosis ?? null,
          recomputed: diagnoseGap(
            p,
            {
              ...h,
              readings: inputs.readings,
              slots: inputs.slots,
              limits: inputs.limits ?? h.limits,
            },
            diagnosed,
            inputs.config,
            inputs.upper,
            inputs.fit,
            {
              anchor: inputs.anchor,
              useReadings: inputs.readingsUsable ?? true,
              invalid: inputs.invalid ?? [],
              fullOwnStep: inputs.fullOwnStep ?? false,
            },
          ),
        }
        : null,
      inputs: { config: c, before: checkpoint.before, open: checkpoint.open },
    },
  };
}

const cores = (n: number) => String(Math.round(n * 10_000) / 10_000);
const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
const time = (ms: number) => new Date(ms).toISOString();
const settings = (s: Settings) => `x${s.mul} +${cores(s.add)} cores, floor ${percent(s.floor)}`;
const sigmas = (z: number | null) => z === null ? "" : ` (${cores(z)} sigma)`;
type Explained = Awaited<ReturnType<typeof explainCalibration>>;
// Every diagnosis the JSON can hold, including one that found no gap.
const diagnosis = (d: NonNullable<NonNullable<Explained["lastLimit"]>["diagnosis"]>) =>
  d.beyond
    ? `, diagnosed beyond a whole core from ${d.source}`
    : d.gap === null
    ? ", diagnosis unavailable"
    : d.explained
    ? `, explained by ${d.source} with the gap at ${cores(d.gap)} cores`
    : `, diagnosed ${cores(d.gap)} cores from ${d.source}`;
// What the diagnosis replayed and what it found besides the gap: its anchor, the allowance for
// estimated time, the bank left at the end, and the figures the mismatch tests and holds use.
const diagnosisDetails = (d: NonNullable<NonNullable<Explained["lastLimit"]>["diagnosis"]>) =>
  `Last diagnosis replayed from ${
    d.anchor
      ? `${time(d.anchor.at)} at ${Math.round(d.anchor.balance)} core-seconds${
        d.anchor.exact ? "" : ", a bound"
      }`
      : "no anchor"
  } to ${time(d.onset)}: allowance ${Math.round(d.eta)} core-seconds, ${
    d.left === null ? "nothing" : `${Math.round(d.left)} core-seconds`
  } left${d.lower !== undefined ? `, lower estimate ${cores(d.lower)} cores` : ""}${
    d.held !== undefined ? `, hold gap ${cores(d.held)} cores` : ""
  }${d.bridged !== undefined ? `, ${Math.round(d.bridged)} seconds bridged` : ""}`;
// Strings in the text come from the daemon's files, which root reads here. Control characters other
// than tab are dropped, so a planted value can't send the terminal an escape sequence or start a
// line of its own. The JSON escapes them already.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;
const printable = (line: string) => line.replace(CONTROL, "");
// The text form of governor calibrate --explain. It shows what the JSON's status fields show.
export function explainText(r: Explained) {
  const e = r.estimates, pending = r.cusum.pending, long = r.longIntervals;
  // Every temporary hold in force, each of which can raise the settings above the learned ones.
  const holds = [
    ...(r.hold ? [`the ${r.hold.reason} readings fallback since ${time(r.hold.since)}`] : []),
    ...(r.ownHold ? [`the own-count hold for a ${cores(r.ownHold.gap)}-core gap`] : []),
    ...(pending
      ? [`a ${pending.verified ? "verified" : "pending"} drift change since ${time(pending.at)}`]
      : []),
  ];
  // The settings each hold gives, which the JSON carries with it.
  const holdSettings = [
    ...(r.ownHold ? [`own-count ${settings(r.ownHold.settings)}`] : []),
    ...(pending ? [`drift change ${settings(pending.hold)}`] : []),
  ];
  const cusum = r.cusum;
  if (r.failing) {
    holds.unshift(`the fallback while calibration fails, since ${time(r.failing.since)}`);
  }
  return [
    `Calibration ${r.mode}: ${settings(r.applied)}; start ${settings(r.start)}`,
    // Off and shadow actuate the legacy margin, so what they learned shows here, as in the JSON.
    ...(holds.length
      ? [`Learned ${settings(r.learned)}; holding ${holds.join(", ")}`]
      : !sameSettings(r.learned, r.applied)
      ? [`Learned ${settings(r.learned)}${r.mode === "apply" ? "" : ", not applied"}`]
      : []),
    ...(r.failing
      ? [
        `Calibration failing since ${time(r.failing.since)}: acting ${
          Math.round(r.failing.behind)
        } core-seconds below the open estimate`,
      ]
      : []),
    ...(holdSettings.length ? [`Hold settings ${holdSettings.join("; ")}`] : []),
    `Billing gap ${cores(r.gap)} cores; upper bound ${cores(r.gapUpperBound)}${
      r.rulesMismatch ? "; rules mismatch latched until reset" : ""
    }`,
    ...r.mismatches.map((m) =>
      `Rules mismatch ${time(m.at)}, limit at ${time(m.onset)}: ${
        m.kind === "lift" ? "recovery took" : "gap"
      } ${m.value === null ? "unknown" : cores(m.value)}${
        m.kind === "lift" ? "x the prediction" : " cores"
      }${m.latched ? ", latched" : ""}`
    ),
    ...(pending
      ? [
        `Drift change since ${time(pending.at)}: ${pending.readings} verification readings${
          pending.readings ? ` at mean ${cores(pending.z / pending.readings)} sigma` : ""
        }; before it ${settings(pending.from)}, gap ${cores(pending.gapFrom)} cores; fit a=${
          cores(pending.fit.a)
        }, b=${cores(pending.fit.b)}, aHi=${pending.fit.aHi} against the old a=${
          cores(pending.oldFit.a)
        }, b=${cores(pending.oldFit.b)}; residual ${
          cores(pending.residual)
        } cores summed over ${pending.n} pairs since`,
      ]
      : []),
    `Drift CUSUM ${cores(cusum.s)} up, ${cores(cusum.down)} down${
      cusum.since !== undefined ? ` since ${time(cusum.since)}` : ""
    }; run residual ${cores(cusum.residual)} cores over ${cores(cusum.own)} own cores${
      cusum.alarm ? "; alarm" : ""
    }`,
    `Readings ${r.readingsInvalid ? "invalid" : r.apiStaleSince !== null ? "stale" : "usable"}${
      r.apiStaleSince !== null ? ` since ${time(r.apiStaleSince)}` : ""
    }; newest reading ${r.newestFinal ? "final" : "may still change"}`,
    ...(r.invalidSpans.length
      ? [
        `Readings invalid and bridged: ${
          r.invalidSpans.map((x) =>
            `${time(x.from)} to ${x.to === null ? "now" : time(x.to)}${
              x.applied || x.gap !== undefined
                ? ` (${x.applied ? `learned ${settings(x.applied)}` : ""}${
                  x.applied && x.gap !== undefined ? ", " : ""
                }${x.gap !== undefined ? `gap ${cores(x.gap)} cores` : ""} when it began)`
                : ""
            }`
          ).join("; ")
        }`,
      ]
      : []),
    ...(r.cooldownUntil !== null ? [`Sustained-use cooldown until ${time(r.cooldownUntil)}`] : []),
    `Meter ${
      r.fit
        ? `a=${cores(r.fit.a)}, b=${cores(r.fit.b)}, aHi=${r.fit.aHi}, sigma ${
          cores(r.fit.sigma[0])
        } + ${cores(r.fit.sigma[1])} per own core${
          r.fit.sigmaFloor !== undefined ? `, at least ${cores(r.fit.sigmaFloor)}` : ""
        }, ${r.fit.pairs} pairs on ${r.fit.days} days`
        : "not qualified"
    }`,
    ...(long
      ? [
        `Long reading intervals ${long.count}${
          long.whole === null || long.lastHalfHour === null
            ? ", not judged before a fit"
            : `: mean residual ${cores(long.whole)} cores${
              sigmas(long.zWhole)
            } over the whole interval, ${cores(long.lastHalfHour)} cores${
              sigmas(long.zLastHalfHour)
            } over its last half hour`
        }`,
      ]
      : []),
    `Last limit ${
      r.lastLimit
        ? `${r.lastLimit.class ?? "unclassified"} at ${time(r.lastLimit.onset)}, ${
          r.lastLimit.lift === null ? "not lifted" : `lifted ${time(r.lastLimit.lift)}`
        }${r.lastLimit.diagnosis ? diagnosis(r.lastLimit.diagnosis) : ""}`
        : "none"
    }`,
    ...(r.lastLimit?.diagnosis ? [diagnosisDetails(r.lastLimit.diagnosis)] : []),
    `Recorded evaluation ${time(r.evidence.at)}, digest ${r.evidence.digest}: replay verified`,
    `Estimates open ${Math.round(e.open)}, clamp ${
      e.clamp === null ? "none" : Math.round(e.clamp)
    }, track ${e.track === null ? "none" : Math.round(e.track)}, acted ${
      Math.round(e.acted)
    } core-seconds`,
  ].map(printable).join("\n");
}
