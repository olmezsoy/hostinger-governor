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
  // Days apart, as these really are: a fallback hold starts a day after the readings went stale.
  const at = (text: string) => Date.parse(text);
  Object.assign(s.credits.calibration!, {
    failing: { since: at("2026-11-19T14:20:00Z"), behind: 500 },
    rulesMismatch: true,
    hold: { since: at("2026-11-17T09:05:00Z"), reason: "stale" as const },
    ownHold: { gap: 0.25, settings: { mul: 1.05, add: 0.35, floor: 0.05 } },
    readingsInvalid: true,
    apiStaleSince: at("2026-11-16T09:05:00Z"),
    invalidReasons: ["spacing" as const, "residuals" as const],
    cooldownUntil: at("2026-11-21T03:00:00Z"),
  });
  // Status passes a time of day for the line about the last history check; warnings carry the
  // date whatever it passes, since "since 14:20Z" hid whether that was today or last week.
  const text = creditLines(s, (ms) => new Date(ms).toISOString().slice(11, 16) + "Z").join("\n");
  assert(text.includes("readings invalid (spacing, residuals)"));
  assert(
    text.includes(
      "Warning: Calibration failing since 2026-11-19 14:20Z; holding fallback margin",
    ),
  );
  assert(text.includes("Warning: Rules mismatch latched"));
  assert(
    text.includes("Warning: Fallback hold active (stale readings since 2026-11-17 09:05Z)"),
  );
  assert(text.includes("Warning: Own-count hold active (0.25-core gap)"));
  assert(
    text.includes(
      "Warning: Hostinger readings invalid (spacing, residuals) since 2026-11-16 09:05Z",
    ),
  );
  assert(text.includes("Warning: Sustained-use cooldown until 2026-11-21 03:00Z"));

  // In shadow mode, holds and rules mismatch are marked as not applied rather than active, and a
  // failing evaluation still shows: shadow is where an operator decides whether to apply.
  s.credits.calibration!.mode = "shadow";
  const shadowText = creditLines(s, () => "00:00Z").join("\n");
  assert(
    shadowText.includes(
      "Calibration failing since 2026-11-19 14:20Z; estimates not updating in shadow mode",
    ),
  );
  assert(
    shadowText.includes(
      "Fallback hold recorded (stale readings since 2026-11-17 09:05Z; not applied in shadow mode)",
    ),
  );
  assert(
    shadowText.includes("Own-count hold recorded (0.25-core gap; not applied in shadow mode)"),
  );
  assert(
    shadowText.includes(
      "Rules mismatch latched until calibration reset; not applied in shadow mode",
    ),
  );
});
