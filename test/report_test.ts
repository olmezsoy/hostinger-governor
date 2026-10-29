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
  assert(lines[0].includes("74 min at all 8 vCPUs until reserve"));
  assertEquals(lines.length, 2);
});

Deno.test("status runway uses the configured spending floor", () => {
  const g = new Governor({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" },
  }, plan(8));
  const s = g.publicState(1000);
  s.credits.balance = 23421;
  const line = creditLines(s, () => "00:00")[0];
  const debit = s.plan.vcpus * s.credits.margin.mul + s.credits.margin.add - s.plan.baseline;
  const minutes = Math.floor((23421 - s.plan.capacity * 0.05) / debit / 60);
  assert(line.includes(`${minutes} min at all 8 vCPUs until reserve`));
});
