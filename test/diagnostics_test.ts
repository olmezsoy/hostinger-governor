import { assertEquals } from "@std/assert";
import { DiagnosticsRunner } from "../src/diagnostics.ts";
import type { Reading } from "../src/credits.ts";
import { flush } from "./async.ts";

Deno.test("diagnostics back off from completion, double retries and resume the normal schedule", async () => {
  let uptime = 100_000;
  let requests = 0;
  const pending = Promise.withResolvers<Reading[]>();
  const errors: unknown[] = [];
  const runner = new DiagnosticsRunner({
    readings: () => {
      requests++;
      if (requests === 1) return pending.promise;
      if (requests === 2) return Promise.reject(new Error("API unavailable"));
      return Promise.resolve([]);
    },
    clock: () => Promise.resolve({ uptime }),
    publish: () => {},
    log: (e) => errors.push(e),
  });
  const refresh = async (seconds = 0) => {
    uptime += seconds * 1000;
    runner.refresh({ at: uptime, uptime });
    await flush();
  };
  try {
    await refresh();
    uptime += 25_000;
    pending.reject(new Error("delayed failure"));
    await flush();
    await refresh(59);
    assertEquals(requests, 1);
    await refresh(1);
    assertEquals(requests, 2);
    await refresh(119);
    assertEquals(requests, 2);
    await refresh(1);
    assertEquals(requests, 3);
    await refresh(1799);
    assertEquals(requests, 3);
    await refresh(1);
    assertEquals(requests, 4);
    assertEquals(errors.length, 2);
  } finally {
    pending.resolve([]);
    await runner.close();
  }
});
