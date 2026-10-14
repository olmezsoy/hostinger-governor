import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fallbackCpuPercent } from "../src/fallback.ts";
import { fallback, validateConfig } from "../src/governor.ts";

Deno.test("fallback uses percent of one vCPU and does not raise the recovery floor", () => {
  assertEquals(fallbackCpuPercent({}, 8), 20);
  assertEquals(fallbackCpuPercent({ fallback_cpu_percent: 150 }, 8), 150);
  assertEquals(fallbackCpuPercent({ fallback_cpu_percent: 800 }, 8), 800);
  assertThrows(() => fallbackCpuPercent({ fallback_cpu_percent: 801 }, 8));
  assertThrows(() => validateConfig({ vcpus: 1, fallback_cpu_percent: 150 }));
  assertThrows(() => validateConfig({ fallback_cpu_percent: 12801 }));
  for (const value of [0, 19, 20.5, -1, NaN, Infinity]) {
    assertThrows(() => fallbackCpuPercent({ fallback_cpu_percent: value }, 8));
  }
  for (const value of [null, "150", true, {}, []]) {
    assertThrows(() => validateConfig(JSON.parse(JSON.stringify({ fallback_cpu_percent: value }))));
  }
});

Deno.test("fallback applies the configured quota without using public state or the API", async () => {
  let applied = 0;
  await fallback({
    config: () => Promise.resolve({ fallback_cpu_percent: 150 }),
    vcpus: () => Promise.resolve(8),
    cap: (value) => {
      applied = value;
      return Promise.resolve(true);
    },
  });
  assertEquals(applied, 150);
});

Deno.test("fallback stays conservative if config is absent, invalid, or too large for the VM", async () => {
  for (
    const config of [
      () => Promise.reject(new Error("missing or invalid JSON")),
      () => Promise.resolve({ fallback_cpu_percent: 801 }),
      () => Promise.resolve({ fallback_cpu_percent: 0 }),
    ]
  ) {
    let applied = 0;
    await fallback({
      config,
      vcpus: () => Promise.resolve(8),
      cap: (value) => {
        applied = value;
        return Promise.resolve(true);
      },
    });
    assertEquals(applied, 20);
  }
});

Deno.test("failed fallback application is reported to systemd", async () => {
  await assertRejects(
    () =>
      fallback({
        config: () => Promise.resolve({}),
        vcpus: () => Promise.resolve(8),
        cap: () => Promise.resolve(false),
      }),
    Error,
    "could not apply fallback CPU quota",
  );
});

Deno.test("hook deadlines are finite and bounded", () => {
  validateConfig({ hook_timeout_seconds: 5 });
  for (const value of [0, -1, NaN, Infinity, 301]) {
    assertThrows(() => validateConfig({ hook_timeout_seconds: value }));
  }
  for (const value of [null, "60"]) {
    assertThrows(() => validateConfig(JSON.parse(JSON.stringify({ hook_timeout_seconds: value }))));
  }
});
