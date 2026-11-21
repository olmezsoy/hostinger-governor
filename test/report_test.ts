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

Deno.test("creditLines surfaces abnormal calibration states and invalid reasons", () => {
  const g = new Governor({
    hostinger: { vm_id: 1, token_file: "/etc/governor/hostinger-token" },
    calibration: { mode: "apply" },
  }, plan(8));
  const s = g.publicState(10_000);
  s.credits.balance = 20_000;
  s.credits.rebuilding = null;
  s.cpu.observedSeconds = 30;
  s.credits.anchor = { checkedAt: 5_000, exact: false, applied: false, difference: null };
  // Healthy state has no Warning lines.
  assert(!creditLines(s, () => "00:00").some((line) => line.startsWith("Warning:")));
  Object.assign(s.credits.calibration!, {
    failing: { since: 1_000, behind: 500 },
    rulesMismatch: true,
    hold: { since: 2_000, reason: "stale" as const },
    ownHold: { gap: 0.25, settings: { mul: 1.05, add: 0.35, floor: 0.05 } },
    readingsInvalid: true,
    invalidReasons: ["spacing" as const, "residuals" as const],
    cooldownUntil: 99_000,
  });
  const text = creditLines(s, () => "00:00").join("\n");
  assert(text.includes("readings invalid (spacing, residuals)"));
  assert(text.includes("Warning: Calibration failing since 00:00"));
  assert(text.includes("Warning: Rules mismatch latched"));
  assert(text.includes("Warning: Fallback hold active (stale readings since 00:00)"));
  assert(text.includes("Warning: Own-count hold active (0.25-core gap)"));
  assert(text.includes("Warning: Hostinger readings invalid (spacing, residuals)"));
  assert(text.includes("Warning: Sustained-use cooldown until 00:00"));
});
