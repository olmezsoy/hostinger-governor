// `governor report`: the machine's vitals for people, now and over the last hours. It reads only the
// public state, sysstat's 10-minute history and /proc, so any user can run it.
import type { PublicState } from "./governor.ts";

const BARS = "▁▂▃▄▅▆▇█";
const COLUMNS = 24;
const SYSSTAT_MS = 10 * 60_000;
const HOSTINGER_MS = 30 * 60_000;
const GIB = 1024 ** 3;

export type Point = { at: number; v: number };

// One bar per equal slice of [from, to], never narrower than the sampling interval, scaled to max; a
// slice without samples is a dot.
export function sparkline(
  points: Point[],
  from: number,
  to: number,
  max = 100,
  intervalMs = 0,
): string {
  const columns = Math.max(1, Math.min(COLUMNS, Math.floor((to - from) / intervalMs)));
  const width = (to - from) / columns;
  return Array.from({ length: columns }, (_, i) => {
    const slice = points.filter((p) => p.at >= from + i * width && p.at < from + (i + 1) * width);
    if (!slice.length) return "·";
    const mean = slice.reduce((s, p) => s + p.v, 0) / slice.length;
    return BARS[Math.min(7, Math.max(0, Math.round((mean / max) * 7)))];
  }).join("");
}

// sadf -d output: a "# hostname;interval;timestamp;..." header, then one row per sample.
export function parseSadf(csv: string): Record<string, number>[] {
  let header: string[] = [];
  const rows: Record<string, number>[] = [];
  for (const line of csv.split("\n")) {
    if (line.startsWith("# ")) header = line.slice(2).split(";");
    else {
      const cells = line.split(";");
      if (!header.length || cells.length !== header.length) continue;
      const row: Record<string, number> = {
        at: Date.parse(cells[2].replace(" UTC", "Z").replace(" ", "T")),
      };
      header.forEach((h, i) => i > 2 && (row[h] = Number(cells[i])));
      rows.push(row);
    }
  }
  return rows;
}

async function sysstat(flag: string, from: number): Promise<Record<string, number>[]> {
  const rows: Record<string, number>[] = [];
  for (let day = from - (from % 86_400_000); day <= Date.now(); day += 86_400_000) {
    const file = `/var/log/sysstat/sa${new Date(day).toISOString().slice(8, 10)}`;
    const out = await new Deno.Command("sadf", { args: ["-d", file, "--", flag], stderr: "null" })
      .output().catch(() => null);
    if (out?.success) {
      rows.push(...parseSadf(new TextDecoder().decode(out.stdout)).filter((r) => r.at >= from));
    }
  }
  return rows;
}

async function meminfo(): Promise<Record<string, number>> {
  const text = await Deno.readTextFile("/proc/meminfo");
  return Object.fromEntries(
    [...text.matchAll(/^(\w+):\s+(\d+)/gm)].map((m) => [m[1], (Number(m[2]) * 1024) / GIB]),
  );
}

async function disk(): Promise<{ total: number; free: number }> {
  const out = await new Deno.Command("df", { args: ["-B1", "--output=size,avail", "/"] }).output();
  const [size, avail] = new TextDecoder().decode(out.stdout).trim().split("\n").pop()!.trim()
    .split(/\s+/).map(Number);
  return { total: size / GIB, free: avail / GIB };
}

const mark = (v: number, warn: number, bad: number) => v >= bad ? "🔴" : v >= warn ? "🟡" : "🔵";
const pct = (v: number) => `${Math.round(v)}%`;
const stats = (ps: Point[]) =>
  ps.length
    ? `avg ${pct(ps.reduce((s, p) => s + p.v, 0) / ps.length)} · peak ${
      pct(Math.max(...ps.map((p) => p.v)))
    }`
    : "no samples";

export function creditLines(s: PublicState, clock: (ms: number) => string): string[] {
  const c = s.credits;
  const a = c.anchor;
  return [
    `Hostinger CPU credits ${c.percent}% · ${c.balance.toLocaleString("en-US")} of ${
      s.plan.capacity.toLocaleString("en-US")
    } core-seconds · ${c.minutesAtFull} min at all ${s.plan.vcpus} vCPUs`,
    `${c.rate >= 0 ? "Earning" : "Spending"} ${
      Math.abs(c.rate).toFixed(1)
    } vCPU's worth now (baseline ${s.plan.baseline} of ${s.plan.vcpus}) · ${
      a
        ? `checked against Hostinger's readings ${clock(a.checkedAt)}, ${
          a.exact ? "exact" : "lower bound so far"
        }`
        : "not yet checked against Hostinger's readings"
    } · margin ×${c.margin.mul} +${c.margin.add} vCPU`,
  ];
}

export async function report(s: PublicState, hours = 12, now = Date.now()): Promise<string> {
  const from = now - hours * 3_600_000;
  const tz = s.timezone;
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const line = (ps: Point[], max = 100, intervalMs = SYSSTAT_MS) =>
    sparkline(ps, from, now, max, intervalMs);
  const [cpuRows, memRows, swapRows, loadRows, mem, d] = await Promise.all([
    sysstat("-u", from),
    sysstat("-r", from),
    sysstat("-S", from),
    sysstat("-q", from),
    meminfo(),
    disk(),
  ]);
  const cpu = cpuRows.map((r) => ({ at: r.at, v: 100 - r["%idle"] - r["%iowait"] - r["%steal"] }));
  const steal = cpuRows.map((r) => ({ at: r.at, v: r["%steal"] }));
  const total = mem.MemTotal ?? 0;
  const memUsed = memRows.map((r) => ({
    at: r.at,
    v: 100 * (1 - (r.kbavail * 1024) / GIB / total),
  }));
  const lowest = Math.min(mem.MemAvailable ?? 0, ...memRows.map((r) => (r.kbavail * 1024) / GIB));
  const swapUsed = mem.SwapTotal ? 100 * (1 - (mem.SwapFree ?? 0) / mem.SwapTotal) : 0;
  const swaps = swapRows.map((r) => ({ at: r.at, v: r["%swpused"] }));
  const loads = loadRows.map((r) => ({ at: r.at, v: r["ldavg-1"] }));
  const load1 = Number((await Deno.readTextFile("/proc/loadavg")).split(" ")[0]);
  const host = s.readings.filter((r) => r.at >= from);
  const stale = now - s.updatedAt > 5 * 60_000;

  return [
    `Server vitals · last ${hours}h · ${clock(now)} ${tz}${
      stale ? ` · ⚠️ governor state from ${clock(s.updatedAt)}` : ""
    }`,
    [
      `CPU ${
        s.limit
          ? `🔴 Hostinger CPU limit since ${clock(s.limit.since)}`
          : mark(s.cpu.busy30 * 100, 60, 85)
      } ${pct(s.cpu.busy30 * 100)} over 30 min · ceiling ${
        Math.round(s.ceiling / s.plan.vcpus)
      }% of the box${s.accepting ? "" : ", start nothing that can wait"}`,
      ...creditLines(s, clock),
      line(cpu),
      `${pct(cpu.at(-1)?.v ?? 0)} now · ${stats(cpu)}`,
      `By user over 30 min: ${
        Object.entries(s.cpu.users30).sort((a, b) => b[1] - a[1]).map(([who, v]) =>
          `${who} ${pct(v * 100)}`
        ).join(" · ") || "measuring"
      }`,
      `Hostinger's reading`,
      host.length ? `${line(host, 100, HOSTINGER_MS)}\n${stats(host)}` : "not available",
      `Steal ${pct(steal.at(-1)?.v ?? 0)} now · peak ${pct(Math.max(0, ...steal.map((p) => p.v)))}`,
    ].join("\n"),
    [
      `Memory ${lowest < 3 ? "🔴" : lowest < 6 ? "🟡" : "🔵"} ${
        (mem.MemAvailable ?? 0).toFixed(1)
      } of ${total.toFixed(0)} GiB free · lowest ${lowest.toFixed(1)}`,
      line(memUsed),
      `used ${stats(memUsed)}`,
      `Swap ${mark(swapUsed, 50, 90)} ${pct(swapUsed)} used · peak ${
        pct(Math.max(swapUsed, ...swaps.map((p) => p.v)))
      }`,
      `Load ${load1.toFixed(1)} on ${s.plan.vcpus} vCPUs · peak ${
        Math.max(load1, ...loads.map((p) => p.v)).toFixed(1)
      }`,
      line(loads, s.plan.vcpus * 2),
      `Disk ${mark(100 * (1 - d.free / d.total), 70, 85)} ${d.free.toFixed(0)} of ${
        d.total.toFixed(0)
      } GiB free`,
    ].join("\n"),
  ].join("\n\n");
}
