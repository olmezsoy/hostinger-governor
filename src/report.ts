// Read-only collection for the channel-neutral resource report.
import type { PublicState } from "./governor.ts";
import { buildReport, type Point, renderReport, type ReportFormat, spending } from "./resource.ts";
import { vcpusSeen } from "./sample.ts";
export { sparkline } from "./resource.ts";

const GIB = 1024 ** 3;

export function parseSadf(csv: string): Record<string, number>[] {
  let header: string[] = [];
  const rows: Record<string, number>[] = [];
  for (const line of csv.split("\n")) {
    if (line.startsWith("# hostname;")) header = line.slice(2).split(";");
    else {
      const cells = line.split(";");
      if (!header.length || cells.length !== header.length) continue;
      const row: Record<string, number> = {
        at: Date.parse(cells[2].replace(" UTC", "Z").replace(" ", "T")),
      };
      header.forEach((h, i) => i > 2 && (row[h] = Number(cells[i])));
      if (Object.values(row).every(Number.isFinite)) rows.push(row);
    }
  }
  return rows;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// Resolve sysstat archive files covering [from, to] in local system time, supporting both
// `saYYYYMMDD` (used when sysstat HISTORY > 28, e.g. Ubuntu 26.04) and legacy `saDD`.
export async function sysstatFiles(
  from: number,
  to: number,
  exists: (path: string) => Promise<boolean> = async (path) => {
    try {
      return (await Deno.stat(path)).isFile;
    } catch {
      return false;
    }
  },
  dir = "/var/log/sysstat",
): Promise<string[]> {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const d = new Date(start); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
    const yyyy = String(d.getFullYear());
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const longPath = `${dir}/sa${yyyy}${mm}${dd}`;
    const shortPath = `${dir}/sa${dd}`;
    const chosen = await exists(longPath) ? longPath : await exists(shortPath) ? shortPath : null;
    if (chosen && !seen.has(chosen)) {
      seen.add(chosen);
      files.push(chosen);
    }
  }
  return files;
}

async function sysstat(flag: string, from: number, to: number): Promise<Record<string, number>[]> {
  const byTime = new Map<number, Record<string, number>>();
  for (const file of await sysstatFiles(from, to)) {
    try {
      const out = await new Deno.Command("sadf", {
        args: ["-d", file, "--", flag],
        cwd: "/",
        stderr: "null",
        signal: AbortSignal.timeout(2000),
      }).output();
      if (out.success) {
        for (const row of parseSadf(new TextDecoder().decode(out.stdout))) {
          if (row.at >= from && row.at <= to) byTime.set(row.at, row);
        }
      }
    } catch {
      // Missing or unreadable history stays missing, not zero usage.
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

async function meminfo(): Promise<Record<string, number>> {
  const text = await Deno.readTextFile("/proc/meminfo");
  return Object.fromEntries(
    [...text.matchAll(/^(\w+):\s+(\d+)/gm)].map((m) => [m[1], Number(m[2]) * 1024 / GIB]),
  );
}

async function disk(): Promise<{ total: number; free: number }> {
  const out = await new Deno.Command("df", {
    args: ["-B1", "--output=size,avail", "/"],
    signal: AbortSignal.timeout(2000),
    stderr: "null",
  }).output();
  if (!out.success) throw new Error("disk counters unavailable");
  const [size, avail] = new TextDecoder().decode(out.stdout).trim().split("\n").pop()!.trim().split(
    /\s+/,
  ).map(Number);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(avail)) {
    throw new Error("invalid disk counters");
  }
  return { total: size / GIB, free: avail / GIB };
}

export type ReportIO = {
  history: typeof sysstat;
  memory: typeof meminfo;
  disk: typeof disk;
  load: () => Promise<number[]>;
  vcpus: typeof vcpusSeen;
};

export async function collectReport(
  state: PublicState | null,
  hours = 12,
  now = Date.now(),
  io: Partial<ReportIO> = {},
) {
  const reads: ReportIO = {
    history: sysstat,
    memory: meminfo,
    disk,
    load: async () =>
      (await Deno.readTextFile("/proc/loadavg")).split(/\s+/).slice(0, 3).map(Number),
    vcpus: vcpusSeen,
    ...io,
  };
  const from = now - hours * 3_600_000;
  const [cpu, ram, swap, loads, memory, storage, load, vcpus] = await Promise.all([
    reads.history("-u", from, now),
    reads.history("-r", from, now),
    reads.history("-S", from, now),
    reads.history("-q", from, now),
    reads.memory(),
    reads.disk(),
    reads.load(),
    state ? state.plan.vcpus : reads.vcpus(),
  ]);
  const series = (
    rows: Record<string, number>[],
    value: (row: Record<string, number>) => number,
  ): Point[] =>
    rows.map((row) => ({ at: row.at, v: value(row) })).filter((p) =>
      p.at >= from && p.at <= now && Number.isFinite(p.at) && Number.isFinite(p.v)
    );
  return buildReport(
    state,
    {
      vcpus,
      cpu: series(cpu, (r) => Math.max(0, 100 - r["%idle"] - r["%iowait"] - r["%steal"])),
      steal: series(cpu, (r) => r["%steal"]),
      memory: {
        total: memory.MemTotal,
        free: memory.MemAvailable,
        history: series(ram, (r) => r.kbavail * 1024 / GIB),
      },
      swap: {
        total: memory.SwapTotal,
        used: memory.SwapTotal ? 100 * (1 - memory.SwapFree / memory.SwapTotal) : 0,
        history: series(swap, (r) => r["%swpused"]),
      },
      load: { current: load, history: series(loads, (r) => r["ldavg-1"]) },
      disk: storage,
    },
    hours,
    now,
  );
}

function calibrationWarnings(s: PublicState, clock: (ms: number) => string): string[] {
  const cal = s.credits.calibration;
  if (!cal) return [];
  const warnings: string[] = [];
  if (cal.failing) {
    warnings.push(`Calibration failing since ${clock(cal.failing.since)}; holding fallback margin`);
  }
  if (cal.rulesMismatch) {
    warnings.push("Rules mismatch latched until calibration reset; holding fallback margin");
  }
  if (cal.hold) {
    warnings.push(
      `Fallback hold active (${cal.hold.reason} readings since ${clock(cal.hold.since)})`,
    );
  }
  if (cal.ownHold) {
    warnings.push(
      `Own-count hold active (${Math.round(cal.ownHold.gap * 1000) / 1000}-core gap)`,
    );
  }
  if (cal.readingsInvalid) {
    const why = cal.invalidReasons?.length ? ` (${cal.invalidReasons.join(", ")})` : "";
    warnings.push(`Hostinger readings invalid${why}; excluded from calibration`);
  } else if (cal.apiStaleSince !== null) {
    warnings.push(`Hostinger readings stale since ${clock(cal.apiStaleSince)}`);
  }
  if (cal.cusum.pending) {
    const p = cal.cusum.pending;
    warnings.push(
      p.verified
        ? `Drift change verified since ${clock(p.at)}, waiting for refit`
        : `Drift change pending verification since ${clock(p.at)} (${p.readings} readings)`,
    );
  }
  if (cal.cooldownUntil !== null) {
    warnings.push(`Sustained-use cooldown until ${clock(cal.cooldownUntil)}`);
  }
  return warnings;
}

export function creditLines(s: PublicState, clock: (ms: number) => string): string[] {
  const c = s.credits;
  const cal = c.calibration;
  const { surplus, debit } = spending(s);
  const warnings = calibrationWarnings(s, clock);
  const historyNote = c.anchor
    ? `Hostinger history checked ${clock(c.anchor.checkedAt)}, ${
      cal?.mode === "apply" ? "tighten only" : "diagnostic only"
    }${
      cal?.readingsInvalid
        ? `, readings invalid${
          cal.invalidReasons?.length ? ` (${cal.invalidReasons.join(", ")})` : ""
        }`
        : c.anchor.difference === null
        ? ""
        : `, CPU difference ${c.anchor.difference.toFixed(1)} points`
    }`
    : "Hostinger history not yet checked";
  return [
    `Estimated CPU credits ${c.percent}% · ${c.balance.toLocaleString("en-US")} of ${
      s.plan.capacity.toLocaleString("en-US")
    } core-seconds · ${
      surplus > 0 && debit > 0
        ? `${Math.floor(surplus / debit / 60)} min at all ${s.plan.vcpus} vCPUs until reserve`
        : "no surplus above reserve"
    }`,
    ...(c.rebuilding
      ? [
        `Estimate rebuilding after ${c.rebuilding.reason}; this does not mean Hostinger is limiting CPU.`,
      ]
      : []),
    ...(s.cpu.observedSeconds === 0
      ? ["Waiting for the first CPU sample; rate is not yet measured."]
      : [
        `${c.rate >= 0 ? "Earning" : "Spending"} ${
          Math.abs(c.rate).toFixed(1)
        } vCPU's worth now (baseline ${s.plan.baseline} of ${s.plan.vcpus}) · ${historyNote} · margin ×${c.margin.mul} +${c.margin.add} vCPU`,
      ]),
    ...warnings.map((w) => `Warning: ${w}.`),
  ];
}

export async function report(
  s: PublicState | null,
  hours = 12,
  now = Date.now(),
  format: ReportFormat = "text",
): Promise<string> {
  return renderReport(await collectReport(s, hours, now), format);
}
