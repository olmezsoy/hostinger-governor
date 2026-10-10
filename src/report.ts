// Read-only collection for the channel-neutral resource report.
import type { PublicState } from "./governor.ts";
import { buildReport, type Point, renderReport, type ReportFormat } from "./resource.ts";
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

async function sysstat(flag: string, from: number, to: number): Promise<Record<string, number>[]> {
  const rows: Record<string, number>[] = [];
  for (let day = from - from % 86_400_000; day <= to; day += 86_400_000) {
    try {
      const out = await new Deno.Command("sadf", {
        args: ["-d", `/var/log/sysstat/sa${new Date(day).toISOString().slice(8, 10)}`, "--", flag],
        cwd: "/",
        stderr: "null",
        signal: AbortSignal.timeout(2000),
      }).output();
      if (out.success) {
        rows.push(
          ...parseSadf(new TextDecoder().decode(out.stdout)).filter((r) =>
            r.at >= from && r.at <= to
          ),
        );
      }
    } catch {
      // Missing or unreadable history stays missing, not zero usage.
    }
  }
  return rows.sort((a, b) => a.at - b.at);
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

export function creditLines(s: PublicState, clock: (ms: number) => string): string[] {
  const c = s.credits;
  const surplus = Math.max(0, c.balance - s.plan.recovered);
  const debit = s.plan.vcpus * c.margin.mul + c.margin.add - s.plan.baseline;
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
        } vCPU's worth now (baseline ${s.plan.baseline} of ${s.plan.vcpus}) · ${
          c.anchor
            ? `Hostinger history checked ${clock(c.anchor.checkedAt)}, diagnostic only${
              c.anchor.difference === null
                ? ""
                : `, CPU difference ${c.anchor.difference.toFixed(1)} points`
            }`
            : "Hostinger history not yet checked"
        } · margin ×${c.margin.mul} +${c.margin.add} vCPU`,
      ]),
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
