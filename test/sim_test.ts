import { assert, assertEquals } from "@std/assert";
import { run } from "./sim.ts";

for (const debitPaused of [false, true]) {
  Deno.test(`week of hidden billing overhead recovers with debitPaused=${debitPaused}`, async () => {
    const result = await run({
      name: "overhead",
      seed: 1,
      billMul: 1.12,
      billAdd: 0.15,
      debitPaused,
    });
    assert(result.throttles > 0);
    assertEquals(result.false_limits, 0);
    assert(result.paused_h < 0.3, `earning paused for ${result.paused_h}h`);
    assert(result.burn_tests <= 12, `${result.burn_tests} burn tests`);
  });
}

Deno.test("wrong-baseline week avoids hundreds of failed lift tests", async () => {
  const result = await run({ name: "old rules", seed: 1, baselineTrue: 0.3, limitShare: 0.2 });
  assert(result.throttles > 0);
  assert(result.paused_h < 3, `earning paused for ${result.paused_h}h`);
  assert(result.burn_tests < 200, `${result.burn_tests} burn tests`);
});
