import { assert, assertEquals } from "@std/assert";
import { Governor } from "../src/governor.ts";
import { plan } from "../src/plans.ts";
import { creditLines } from "../src/report.ts";

Deno.test("text status distinguishes warmup and uses reserve-aware, margin-adjusted runway", () => {
  const g = new Governor({}, plan(8));
  const s = g.publicState(1000);
  const warmup = creditLines(s, () => "00:00").join("\n");
  assert(warmup.includes("Estimate rebuilding"));
  assert(warmup.includes("Waiting for the first CPU sample"));
  assert(!warmup.includes("Earning"));
  s.credits.balance = 23421;
  s.credits.rebuilding = null;
  s.cpu.observedSeconds = 30;
  const lines = creditLines(s, () => "00:00");
  assert(lines[0].includes("91 min at all 8 vCPUs until reserve"));
  assertEquals(lines.length, 2);
});

Deno.test("status runway stops at the spending floor", () => {
  const g = new Governor({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
  }, plan(8));
  const s = g.publicState(1000);
  s.credits.balance = 23421;
  const line = creditLines(s, () => "00:00")[0];
  const debit = s.plan.vcpus * s.credits.margin.mul + s.credits.margin.add - s.plan.baseline;
  const minutes = Math.floor((23421 - s.plan.capacity * 0.1) / debit / 60);
  assert(line.includes(`${minutes} min at all 8 vCPUs until reserve`));
});

Deno.test("creditLines warns, with the date, once Hostinger's readings have stopped", () => {
  const g = new Governor({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
  }, plan(8));
  const s = g.publicState(10_000);
  s.credits.balance = 20_000;
  s.credits.rebuilding = null;
  s.cpu.observedSeconds = 30;
  s.credits.anchor = { checkedAt: 5_000, exact: false, applied: true, difference: 1.25 };
  // Healthy state has no Warning lines, and shows what the last check found.
  const healthy = creditLines(s, () => "00:00Z");
  assert(!healthy.some((line) => line.startsWith("Warning:")));
  assert(
    healthy.join("\n").includes(
        "Hostinger readings checked 00:00Z, CPU difference 1.3 points in the last 3 hours",
      ),
  );
  s.credits.staleSince = Date.parse("2026-11-16T09:05:00Z");
  // Status passes a time of day for the last check; a warning carries the date whatever it
  // passes, since "since 09:05Z" hid whether that was today or last week.
  const text = creditLines(s, (ms) => new Date(ms).toISOString().slice(11, 16) + "Z").join("\n");
  assert(
    text.includes(
      "Warning: No Hostinger reading since 2026-11-16 09:05Z; the estimate runs on guest CPU alone.",
    ),
  );
  // Without a feed at all there is nothing to warn about.
  s.credits.staleSince = null;
  s.credits.anchor = null;
  const bare = creditLines(s, () => "00:00Z").join("\n");
  assert(bare.includes("Hostinger readings not yet checked"));
  assert(!bare.includes("Warning:"));
});
