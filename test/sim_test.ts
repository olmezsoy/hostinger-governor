import { assert, assertEquals } from "@std/assert";
import { DETECTION_SCENARIOS, run } from "./sim.ts";

for (const debitPaused of [false, true]) {
  const overhead = { name: "overhead", seed: 1, billMul: 1.12, billAdd: 0.15, debitPaused };
  Deno.test(`a week of hidden billing overhead costs no limit where readings show it, debitPaused=${debitPaused}`, async () => {
    const result = await run(overhead);
    assertEquals(result.throttles, 0);
    assertEquals(result.false_limits, 0);
  });
  Deno.test(`without readings the same week's limits teach the overhead and recover, debitPaused=${debitPaused}`, async () => {
    const result = await run({ ...overhead, noReadings: true });
    assert(result.throttles > 0 && result.throttles <= 6, `${result.throttles} limits`);
    assertEquals(result.false_limits, 0);
    // Billing runs 0.07 cores a core and 0.11 cores above the own count's margin.
    assert(result.pad > 0.3, `pad ${result.pad}`);
    assert(result.paused_h < 0.5, `earning paused for ${result.paused_h}h`);
    assert(result.burn_tests <= 25, `${result.burn_tests} burn tests`);
  });
}

Deno.test("wrong-baseline week avoids hundreds of failed lift tests", async () => {
  const result = await run({ name: "old rules", seed: 1, baselineTrue: 0.3, limitShare: 0.2 });
  assert(result.throttles > 0);
  assert(result.paused_h < 3, `earning paused for ${result.paused_h}h`);
  assert(result.burn_tests < 200, `${result.burn_tests} burn tests`);
});

const detection = (name: string) => DETECTION_SCENARIOS.find((s) => s.name === name)!;

Deno.test("an idle box on a noisy host enters no false limit in two weeks", async () => {
  // A live KVM 8 box saw 12 false limits in 11 days at about this steal; each capped the slice at 0.2 cores.
  const result = await run({ ...detection("idle box, steal 0.015 cores"), seed: 1 });
  assertEquals(result.false_limits, 0);
  assert(result.probes <= 14, `${result.probes} probes`);
});

Deno.test("work outside an idle slice pressing on the cap is detected", async () => {
  for (const cores of [3, 7]) {
    const result = await run({
      ...detection(`limit on at start, ${cores} cores outside an idle slice`),
      seed: 1,
    });
    assertEquals(result.false_limits, 0);
    assertEquals(result.episodes.length, 1);
    // The load starts 6 minutes in; the limit is on from the start.
    const lag = result.episodes[0].lag_s;
    assert(lag >= 0 && lag <= 360 + 600, `${cores} cores: lag ${lag} s`);
  }
});

Deno.test("steady work near the cap on a noisy host is not a limit", async () => {
  for (let seed = 1; seed <= 5; seed++) {
    const result = await run({
      ...detection("2.9 cores outside steady, 15-25% steal episodes, no limit"),
      seed,
    });
    assertEquals(result.throttles, 0, `seed ${seed}`);
    assertEquals(result.false_limits, 0, `seed ${seed}`);
  }
});

Deno.test("a single thread under a per-vCPU cap is still detected when steal exceeds 60% below the evident floor", async () => {
  const base = detection("limit on at start, per-vCPU, one busy thread");
  const result = await run({
    ...base,
    seed: 1,
    idle: { ...base.idle!, gov: 0.001, outsideBase: 0.001, level: 0 },
    svcBurst: [0, 6, 0.8],
  });
  assertEquals(result.false_limits, 0);
  assertEquals(result.episodes.length, 1);
  assert(
    result.episodes[0].lag_s >= 0 && result.episodes[0].lag_s <= 300,
    `lag ${result.episodes[0].lag_s}`,
  );
  assert(result.paused_h < 0.5, `paused ${result.paused_h} h`);
});

Deno.test("back-to-back limits from outside load are each detected, with no false one between", async () => {
  const result = await run({
    ...detection("8 cores outside an idle slice, 60 min on, 30 off"),
    seed: 1,
  });
  assert(result.throttles >= 30, `${result.throttles} limits`);
  assertEquals(result.episodes.filter((e) => e.lag_s < 0).length, 0);
  assertEquals(result.false_limits, 0);
});
