// Channel-neutral report data and presentation. No bot credentials, delivery or governor control.
import { LAW } from "./credits.ts";
import type { PublicState } from "./governor.ts";

export type Point = { at: number; v: number };
export type Vitals = {
  vcpus: number;
  cpu: Point[];
  steal: Point[];
  memory: { total: number; free: number; history: Point[] };
  swap: { total: number; used: number; history: Point[] };
  load: { current: number[]; history: Point[] };
  disk: { total: number; free: number };
};
type Section = {
  title: string;
  note?: string;
  table?: { headers: string[]; rows: string[][] };
  chart?: string;
};
export type ResourceReport = {
  schema: 1;
  collectedAt: number;
  window: { from: number; to: number; hours: number };
  timezone: string;
  governor: PublicState | null;
  credits: {
    estimated: true;
    balance: number;
    capacity: number;
    reserve: number;
    surplus: number;
    rate: number | null;
    fullCpuRunwaySeconds: number;
    reserveEtaSeconds: number | null;
    fullBankEtaSeconds: number | null;
  } | null;
  resources: Vitals;
  sections: Section[];
};
export type ReportFormat = "text" | "html" | "json";

export function reportOptions(args: string[]): { hours: number; format: ReportFormat } {
  let hours = 12;
  let format: ReportFormat = "text";
  let seenHours = false;
  let seenFormat = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && !seenFormat) {
      const value = args[++i];
      if (value !== "text" && value !== "html" && value !== "json") {
        throw new Error("report --format must be text, html or json");
      }
      format = value;
      seenFormat = true;
    } else if (!seenHours && /^\d{1,2}$/.test(args[i]) && +args[i] >= 1 && +args[i] <= 72) {
      hours = +args[i];
      seenHours = true;
    } else throw new Error("use governor report [1..72] [--format text|html|json]");
  }
  return { hours, format };
}

export function sparkline(
  points: Point[],
  from: number,
  to: number,
  max = 100,
  intervalMs = 0,
): string {
  const bars = "▁▂▃▄▅▆▇█";
  const columns = Math.max(1, Math.min(24, Math.floor((to - from) / intervalMs)));
  const width = (to - from) / columns;
  return Array.from({ length: columns }, (_, i) => {
    const values = points.filter((p) => p.at >= from + i * width && p.at < from + (i + 1) * width);
    if (!values.length) return "·";
    const mean = values.reduce((sum, p) => sum + p.v, 0) / values.length;
    return bars[Math.max(0, Math.min(7, Math.round(mean / max * 7)))];
  }).join("");
}

const number = (n: number, digits = 1) =>
  n.toLocaleString("en-US", { maximumFractionDigits: digits });
const duration = (seconds: number) => {
  const minutes = Math.ceil(Math.max(0, seconds) / 60);
  return minutes < 60 ? `~${minutes} min` : `~${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const peak = (points: Point[], fallback = 0) => Math.max(fallback, ...points.map((p) => p.v));
const badge = (value: number, warning: number, danger: number) =>
  value >= danger ? "🔴" : value >= warning ? "🟡" : "🟢";

// What the estimate can spend above the reserve, and how fast every vCPU spends it. State from
// before v0.3 has no law: it always spent down to the legacy floor.
export function spending(state: PublicState) {
  const p = state.plan, c = state.credits;
  const reserve = (c.law?.floor ?? LAW.floor) * p.capacity;
  return {
    reserve,
    surplus: Math.max(0, c.balance - reserve),
    debit: p.vcpus * c.margin.mul + c.margin.add - p.baseline,
  };
}
export function buildReport(
  state: PublicState | null,
  resources: Vitals,
  hours = 12,
  now = Date.now(),
): ResourceReport {
  const from = now - hours * 3_600_000;
  const sections: Section[] = [];
  const report: ResourceReport = {
    schema: 1,
    collectedAt: now,
    window: { from, to: now, hours },
    timezone: state?.timezone ?? "UTC",
    governor: state,
    credits: null,
    resources,
    sections,
  };
  if (state) {
    const p = state.plan;
    const c = state.credits;
    const measuring = state.cpu.observedSeconds === 0;
    const { reserve, surplus, debit } = spending(state);
    const rate = measuring ? null : c.rate;
    const runway = debit > 0 ? surplus / debit : 0;
    report.credits = {
      estimated: true,
      balance: c.balance,
      capacity: p.capacity,
      reserve,
      surplus,
      rate,
      fullCpuRunwaySeconds: runway,
      reserveEtaSeconds: rate !== null && rate > 0 ? Math.max(0, reserve - c.balance) / rate : null,
      fullBankEtaSeconds: rate !== null && rate > 0
        ? Math.max(0, p.capacity - c.balance) / rate
        : null,
    };
    const percent = c.balance / p.capacity * 100;
    const filled = Math.max(0, Math.min(20, Math.round(percent / 5)));
    const rows = [
      ["Balance", `${number(c.balance, 0)} / ${number(p.capacity, 0)} core-seconds`],
      ["Work admission", state.accepting ? "🟢 Accepting work" : "🔴 New work paused"],
      ["Host CPU limit", state.limit ? "🔴 Detected" : "Not detected"],
      [
        rate === null ? "Bank trend" : rate >= 0 ? "Earning" : "Spending",
        rate === null
          ? "Waiting for the first CPU sample"
          : `${number(Math.abs(rate))} credits/s · ${number(Math.abs(rate) * 3600, 0)}/h`,
      ],
      [
        "Managed ceiling",
        `${number(state.ceiling / 100)} / ${p.vcpus} vCPUs · ${
          number(state.ceiling / p.vcpus)
        }% of box`,
      ],
      [
        "Baseline",
        `${number(p.baseline)} / ${p.vcpus} vCPUs · ${number(p.baseline / p.vcpus * 100)}%`,
      ],
      [
        "Spending reserve",
        `${number(reserve, 0)} credits · ${number(reserve / p.capacity * 100)}% of bank`,
      ],
      ["Burst headroom", `${number(surplus, 0)} credits above reserve`],
      [
        `Runway at all ${p.vcpus} vCPUs`,
        surplus > 0 && debit > 0 ? `${duration(runway)} until reserve` : "No surplus above reserve",
      ],
      [
        "Billing margin",
        `Observed use × ${number(c.margin.mul, 2)} + ${number(c.margin.add, 2)} vCPU`,
      ],
    ];
    if (rate !== null && rate > 0) {
      if (c.balance < reserve) {
        rows.push([
          "Build reserve",
          `${duration(report.credits.reserveEtaSeconds!)} at current rate`,
        ]);
      }
      rows.push(["Fill bank", `${duration(report.credits.fullBankEtaSeconds!)} at current rate`]);
    } else if (rate !== null && rate < 0) {
      rows.push([
        "Reach reserve",
        surplus ? `${duration(surplus / -rate)} at current rate` : "Already at or below reserve",
      ]);
    } else if (rate === 0) rows.push(["Bank trend", "Flat; no refill or spending ETA"]);
    sections.push({
      title: "Estimated CPU credit bank",
      chart: `${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${percent.toFixed(1)}%`,
      table: { headers: ["Credit metric", "Current estimate"], rows },
    });
    if (c.rebuilding) {
      const reasons = {
        "first-start": "first startup",
        "state-upgrade": "discarding an older, untrusted estimate",
        "plan-change": "a plan or baseline change",
        "reboot": "a VPS reboot",
        "counter-reset": "a CPU counter reset",
      };
      sections.push({
        title: "Estimate rebuilding",
        note: `After ${
          reasons[c.rebuilding.reason]
        }. This is a conservative local estimate, not an empty bank reported by Hostinger. Rebuilding alone does not pause new work.`,
      });
    }
    const recovery = [
      ["Outside the quota", `${number(state.coverage.outsideCores, 2)} vCPU`],
      [
        "Recovery blocked",
        state.coverage.recoveryBlocked
          ? "🔴 Outside workload alone exceeds the host limit"
          : "No outside-load block detected",
      ],
    ];
    const limit = state.limit;
    if (limit) {
      recovery.push(
        [
          "Limited for",
          duration(((state.uptime ?? 0) - (limit.startedAt ?? limit.heldFrom)) / 1000),
        ],
        ["Host limit", `${number(p.limit)} vCPUs`],
        ["Earliest idle recovery", `${duration(p.recovered / p.baseline)} from limit start`],
      );
      if (limit.testAt) {
        recovery.push(["Next lift test", duration((limit.testAt - (state.uptime ?? 0)) / 1000)]);
      }
      if (limit.recovery?.seconds) {
        recovery.push([
          "Estimated earning pauses",
          duration(limit.recovery.seconds - limit.recovery.earningSeconds),
        ]);
      }
    }
    sections.push({
      title: limit ? "Limit recovery" : "Quota coverage",
      note: limit ? "A lift test must confirm recovery; timing alone cannot." : undefined,
      table: { headers: ["Recovery metric", "State"], rows: recovery },
    });
    sections.push({
      title: "CPU",
      note: measuring
        ? "Waiting for the first CPU sample"
        : `${number(state.cpu.busy5 * 100)}% busy · ${
          number(state.cpu.steal5 * 100, 2)
        }% steal over 5m · ${number(state.cpu.busy30 * 100)}% busy over 30m`,
    });
    const users = Object.entries(state.cpu.users30).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (users.length) {
      sections.push({
        title: "CPU by user",
        table: {
          headers: ["User", "CPU share over 30m"],
          rows: users.map(([name, v]) => [name.slice(0, 64), `${number(v * 100, 2)}%`]),
        },
      });
    }
  } else {sections.push({
      title: "Governor unavailable",
      note:
        "No fresh governor state. Credits and recovery estimates are unavailable. No stale bank is displayed.",
    });}
  const host = (state?.readings ?? []).filter((r) => r.at >= from && r.at <= now);
  const rows = [["Guest CPU", resources.cpu], ["Steal", resources.steal], [
    "Hostinger API",
    host,
  ]] as const;
  sections.push({
    title: `CPU · last ${hours}h`,
    table: {
      headers: ["Reading", "Average", "Peak"],
      rows: rows.map((
        [label, points],
      ) => [
        label,
        points.length
          ? `${number(points.reduce((sum, p) => sum + p.v, 0) / points.length)}%`
          : "Not available",
        points.length ? `${number(peak(points))}%` : "Not available",
      ]),
    },
  });
  for (const [label, points] of rows) {
    if (label === "Hostinger API" && !points.length) continue;
    sections.push({
      title: `${label} history`,
      note: label === "Hostinger API"
        ? state?.credits.calibration?.mode === "apply"
          ? "Tighten only; it never raises the bank."
          : "Diagnostic only; it does not reset the bank."
        : undefined,
      chart: sparkline(
        [...points],
        from,
        now,
        100,
        label === "Hostinger API" ? 1_800_000 : 600_000,
      ),
    });
  }
  if (!host.length) {
    sections.push({
      title: "Hostinger API",
      note: "History is unavailable. The bank estimate uses guest CPU measurements.",
    });
  }
  if (state?.credits.anchor) {
    const a = state.credits.anchor;
    sections.push({
      title: "API comparison",
      note: `Last checked ${new Date(a.checkedAt).toISOString()}. ${
        a.difference === null
          ? "Guest/API samples are not comparable"
          : `Guest/API difference ${number(a.difference)} percentage points`
      }. API history never resets the bank.`,
    });
  }
  const { memory, swap, load, disk } = resources;
  const lowest = Math.min(memory.free, ...memory.history.map((p) => p.v));
  const diskUsed = disk.total ? 100 * (1 - disk.free / disk.total) : 0;
  sections.push({
    title: "Memory, load and storage",
    table: {
      headers: ["Resource", "Live", `Last ${hours}h`],
      rows: [
        [
          `${badge(memory.total ? 100 * (1 - lowest / memory.total) : 0, 80, 90)} Memory`,
          `${number(memory.free)} / ${number(memory.total)} GiB free`,
          `Lowest free ${number(lowest)} GiB`,
        ],
        [
          `${badge(swap.used, 50, 90)} Swap`,
          `${number(swap.used)}% used / ${number(swap.total)} GiB`,
          `Peak ${number(peak(swap.history, swap.used))}% used`,
        ],
        [
          `${badge(load.current[0], resources.vcpus, resources.vcpus * 2)} Load`,
          load.current.map((v) => number(v, 2)).join(" / "),
          `Peak ${number(peak(load.history, load.current[0]), 2)} · ${resources.vcpus} vCPUs`,
        ],
        [
          `${badge(diskUsed, 70, 85)} Disk /`,
          `${number(disk.free)} / ${number(disk.total)} GiB free`,
          `${number(diskUsed)}% used now`,
        ],
      ],
    },
  }, {
    title: "Memory usage history",
    chart: sparkline(
      memory.history.map((p) => ({
        at: p.at,
        v: memory.total ? 100 * (1 - p.v / memory.total) : 0,
      })),
      from,
      now,
      100,
      600_000,
    ),
  }, {
    title: "Load history",
    note: `Chart ceiling ${resources.vcpus * 2}`,
    chart: sparkline(load.history, from, now, resources.vcpus * 2, 600_000),
  }, {
    title: "Reading the report",
    note: (state
      ? `Governor snapshot ${Math.max(0, Math.round((now - state.updatedAt) / 1000))}s ago. `
      : "") +
      "Credit figures are conservative estimates, not the hPanel balance. One credit = one vCPU-second. Runway includes the billing margin and stops at the reserve. ETAs assume the current rate continues. Missing chart samples are ·; CPU/memory scale 0–100%. Live CPU averages build after daemon startup.",
  });
  return report;
}

const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(
    '"',
    "&quot;",
  ).replaceAll("'", "&#39;");

export function renderReport(report: ResourceReport, format: ReportFormat = "text"): string {
  if (format === "json") return JSON.stringify(report);
  const clock = new Date(report.collectedAt).toLocaleTimeString("en-GB", {
    timeZone: report.timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const subtitle = `Last ${report.window.hours}h · ${clock} ${report.timezone}`;
  if (format === "html") {
    return "<h3>Server vitals</h3><p>" + escape(subtitle) + "</p>" +
      report.sections.map((section) => {
        const table = section.table;
        return `<p><b>${escape(section.title)}</b></p>` +
          (section.note ? `<p>${escape(section.note)}</p>` : "") +
          (section.chart ? `<pre>${escape(section.chart)}</pre>` : "") + (table
            ? "<table><tr>" + table.headers.map((v) =>
              `<th>${escape(v)}</th>`
            ).join("") + "</tr>" +
              table.rows.map((row) =>
                "<tr>" + row.map((v) => `<td>${escape(v)}</td>`).join("") + "</tr>"
              ).join("") + "</table>"
            : "");
      }).join("");
  }
  return [
    "Server vitals",
    subtitle,
    ...report.sections.map((section) => {
      const table = section.table;
      let body = "";
      if (table) {
        const rows = [table.headers, ...table.rows];
        const widths = table.headers.map((_, i) =>
          Math.max(...rows.map((row) => [...row[i]].length))
        );
        body = rows.map((row) =>
          row.map((v, i) => v + " ".repeat(widths[i] - [...v].length)).join("  ").trimEnd()
        ).join("\n");
      }
      return [section.title, section.note, section.chart, body].filter(Boolean).join("\n");
    }),
  ].join("\n\n");
}
