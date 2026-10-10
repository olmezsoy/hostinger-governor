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
