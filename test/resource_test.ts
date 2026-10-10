import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { Governor } from "../src/governor.ts";
import { plan } from "../src/plans.ts";
import { collectReport, parseSadf, type ReportIO } from "../src/report.ts";
import {
  buildReport,
  renderReport,
  reportOptions,
  sparkline,
  type Vitals,
} from "../src/resource.ts";

const now = Date.UTC(2026, 9, 10, 4, 30);
function fixture() {
  const state = new Governor({ timezone: "Europe/Istanbul" }, plan(8)).publicState(now);
  Object.assign(state.credits, { balance: 23421, rate: 3.1, rebuilding: null });
  Object.assign(state, { ceiling: 800, accepting: true, uptime: 404_500_000 });
  Object.assign(state.cpu, {
    observedSeconds: 1800,
    busy5: 0.02,
    busy30: 0.22,
    users30: { ci: 0.1, ci2: 0.05 },
  });
  const resources: Vitals = {
    vcpus: 8,
    cpu: [{ at: now - 100_000, v: 52 }],
    steal: [{ at: now - 100_000, v: 0 }],
    memory: { total: 31, free: 22.9, history: [{ at: now - 100_000, v: 0.8 }] },
    swap: { total: 8, used: 89, history: [{ at: now - 100_000, v: 100 }] },
    load: { current: [0.3, 0.2, 0.1], history: [{ at: now - 100_000, v: 40.4 }] },
    disk: { total: 387, free: 88 },
  };
  return { state, resources, report: () => buildReport(state, resources, 12, now) };
}

Deno.test("resource reports use the same bank, units and layout across all formats", () => {
  const f = fixture();
  const r = f.report();
  for (const format of ["html", "text"] as const) {
    const output = renderReport(r, format);
    for (
      const text of [
        "Server vitals",
        "23,421 / 34,560",
        "67.8%",
        "4.8 / 8",
        "3.1 credits/s",
        "8 / 8 vCPUs",
        "6,912",
        "16,509",
        "22.9 / 31",
        "Lowest free 0.8",
        "89% used",
        "Peak 100%",
        "40.4",
        "88 / 387",
        "ci2",
        "Europe/Istanbul",
        "conservative estimates",
      ]
    ) assert(output.includes(text), text);
  }
  const json = JSON.parse(renderReport(r, "json"));
  assertEquals(json.schema, 1);
  assertEquals(json.credits.balance, 23421);
  assertEquals(json.credits.estimated, true);
  assertEquals(json.window.hours, 12);
  assertEquals(json.sections.length, r.sections.length);
  assertEquals(json.sections[0].table, r.sections[0].table);
  const html = renderReport(r, "html");
  assert(html.startsWith("<h3>Server vitals</h3>"));
  assert(html.includes("<table>"));
  assert(!html.includes("<script"));
  assert(!html.includes("striped compact"));
});

Deno.test("burst runway includes margin and only spends surplus above the reserve", () => {
  const f = fixture();
  assertAlmostEquals(f.report().credits!.fullCpuRunwaySeconds, 16509 / 3.68);
  assert(renderReport(f.report(), "html").includes("~1h 15m until reserve"));
  f.state.credits.balance = 0;
  const r = f.report();
  assertEquals(r.credits!.fullCpuRunwaySeconds, 0);
  assertEquals(r.credits!.surplus, 0);
  assert(renderReport(r).includes("No surplus above reserve"));
  assert(renderReport(r).includes("Build reserve"));
});

Deno.test("sample warmup is not a measured earning rate or a refill promise", () => {
  const f = fixture();
  f.state.credits.balance = 0;
  f.state.cpu.observedSeconds = 0;
  f.state.credits.rebuilding = { reason: "state-upgrade", since: now };
  const r = f.report();
  const text = renderReport(r);
  for (
    const s of [
      "Estimate rebuilding",
      "older, untrusted estimate",
      "not an empty bank",
      "Accepting work",
      "Waiting for the first CPU sample",
    ]
  ) assert(text.includes(s));
  assert(!text.includes("credits/s"));
  assert(!text.includes("at current rate"));
  assertEquals(r.credits!.rate, null);
  assertEquals(r.credits!.reserveEtaSeconds, null);
  assertEquals(r.credits!.fullBankEtaSeconds, null);
});

Deno.test("flat and spending banks do not promise a refill", () => {
  const f = fixture();
  for (const rate of [-3, 0]) {
    f.state.credits.rate = rate;
    const r = f.report();
    const text = renderReport(r);
    assert(!text.includes("Fill bank"));
    assert(!text.includes("Build reserve"));
    assert(text.includes(rate < 0 ? "Spending" : "Flat"));
    assertEquals(r.credits!.fullBankEtaSeconds, null);
  }
});

Deno.test("limit recovery uses uptime, warns about outside load and requires a lift test", () => {
  const f = fixture();
  f.state.accepting = false;
  f.state.limit = {
    since: now - 60_000,
    ceiling: 100,
    heldFrom: 404_000_000,
    startedAt: 403_000_000,
    testAt: 404_620_000,
    recovery: { seconds: 1500, earningSeconds: 1350, charged: 0 },
  };
  f.state.coverage.recoveryBlocked = true;
  const text = renderReport(f.report());
  for (
    const s of [
      "New work paused",
      "Detected",
      "25 min",
      "~2 min",
      "24 min",
      "Estimated earning pauses",
      "Outside workload alone",
      "lift test must confirm",
    ]
  ) assert(text.includes(s));
});

Deno.test("missing state still reports resources without showing an assumed bank", () => {
  const f = fixture();
  const r = buildReport(null, f.resources, 12, now);
  const html = renderReport(r, "html");
  assert(html.includes("Governor unavailable"));
  assert(html.includes("Memory"));
  assert(!html.includes("23,421"));
  assert(!html.includes("Estimated CPU credit bank"));
  assertEquals(r.credits, null);
  assertEquals(r.governor, null);
});

Deno.test("missing history stays missing, not zero CPU", () => {
  const f = fixture();
  f.resources.cpu = [];
  f.resources.steal = [];
  f.resources.memory.history = [];
  f.resources.swap.history = [];
  f.resources.load.history = [];
  const text = renderReport(f.report());
  assert(text.includes("Not available"));
  assert(text.includes("························"));
  assert(text.includes("History is unavailable"));
});

Deno.test("Hostinger history is diagnostic and the report does not mutate governor state", () => {
  const f = fixture();
  f.state.readings = [{ at: now - 100_000, v: 53 }];
  f.state.credits.anchor = {
    checkedAt: now - 100_000,
    exact: false,
    applied: false,
    difference: null,
  };
  const before = structuredClone({ state: f.state, resources: f.resources });
  const text = renderReport(f.report());
  assert(text.includes("Diagnostic only"));
  assert(text.includes("not comparable"));
  assert(text.includes("does not reset the bank"));
  assertEquals(f.state, before.state);
  assertEquals(f.resources, before.resources);
});

Deno.test("HTML escapes names while JSON retains data for an integration's own renderer", () => {
  const f = fixture();
  f.state.cpu.users30 = { "<script>alert('x')</script>": 0.1 };
  const r = f.report();
  const html = renderReport(r, "html");
  assert(html.includes("&lt;script&gt;"));
  assert(!html.includes("<script>"));
  assert(JSON.parse(renderReport(r, "json")).governor.cpu.users30["<script>alert('x')</script>"]);
});

Deno.test("report arguments reject unknown formats and invalid windows", () => {
  assertEquals(reportOptions([]), { hours: 12, format: "text" });
  assertEquals(reportOptions(["24", "--format", "html"]), { hours: 24, format: "html" });
  assertEquals(reportOptions(["--format", "json", "72"]), { hours: 72, format: "json" });
  for (
    const args of [["0"], ["73"], ["1.5"], ["-1"], ["12;id"], ["--format"], ["--format", "slack"], [
      "12",
      "24",
    ], ["--format", "text", "--format", "json"]]
  ) assertThrows(() => reportOptions(args));
});

Deno.test("sadf rejects malformed or nonfinite readings and charts preserve gaps", () => {
  const csv =
    "# hostname;interval;timestamp;CPU;%idle\nbox;600;2026-10-10 04:30:00 UTC;-1;98\nbox;600;2026-10-10 04:30:00 UTC;-1;NaN\nbox;600;invalid;-1;98\n";
  assertEquals(parseSadf(csv), [{ at: now, CPU: -1, "%idle": 98 }]);
  assertEquals(sparkline([{ at: 100, v: 0 }, { at: 1300, v: 1000 }], 0, 1800, 100, 600), "▁·█");
  assertEquals(sparkline([], 0, 1800, 100, 600), "···");
});

Deno.test("collector uses the requested window and normalizes counters without private data", async () => {
  const f = fixture();
  const calls: unknown[] = [];
  const io: ReportIO = {
    history: (flag, from, to) => {
      calls.push([flag, from, to]);
      return Promise.resolve(
        flag === "-u"
          ? [
            { at: now - 1000, "%idle": 47, "%iowait": 1, "%steal": 0 },
            { at: now + 1000, "%idle": 47, "%iowait": 1, "%steal": 0 },
          ]
          : [],
      );
    },
    memory: () =>
      Promise.resolve({ MemTotal: 31, MemAvailable: 22.9, SwapTotal: 8, SwapFree: 0.88 }),
    disk: () => Promise.resolve({ total: 387, free: 88 }),
    load: () => Promise.resolve([0.3, 0.2, 0.1]),
    vcpus: () => Promise.resolve(8),
  };
  const r = await collectReport(f.state, 24, now, io);
  assertEquals(calls.length, 4);
  assertEquals(calls[0], ["-u", now - 24 * 3_600_000, now]);
  assertEquals(r.resources.cpu, [{ at: now - 1000, v: 52 }]);
  assertEquals(r.resources.swap.used, 89);
  assertEquals((await collectReport(null, 12, now, io)).credits, null);
});
