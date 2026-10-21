import { assertEquals, assertRejects } from "@std/assert";
import { controlLoop, requestTick, TickError } from "../../src/control.ts";
const dir = Deno.env.get("GOVERNOR_TICK_TEST_DIR")!;

const gate = () => Promise.withResolvers<void>();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.test("requested passes serialize and acknowledge only after both state writes", async () => {
  const path = `${dir}/tick.sock`;
  const controller = new AbortController();
  const ready = gate();
  const entered = gate();
  const release = gate();
  let passes = 0;
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const oldMask = Deno.umask(0);
  const serving = controlLoop({
    path,
    tickMs: 60_000,
    signal: controller.signal,
    pass: async () => {
      maxActive = Math.max(maxActive, ++active);
      const n = ++passes;
      await Deno.writeTextFile(`${dir}/persist.json`, JSON.stringify({ pass: n }));
      if (n === 2) {
        entered.resolve();
        await release.promise;
      }
      await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify({ pass: n }));
      active--;
      if (n === 1) ready.resolve();
    },
  });
  const requests: Promise<void>[] = [];
  try {
    await ready.promise;
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(Deno.umask(), 0);
    Deno.umask(oldMask);
    await assertRejects(
      () => controlLoop({ path, tickMs: 60_000, signal: controller.signal, pass: () => pause(0) }),
      Error,
      "already in use",
    );
    for (let i = 0; i < 3; i++) {
      requests.push(
        requestTick(path).then(() => {
          completed++;
        }),
      );
    }
    await entered.promise;
    await pause(10);
    assertEquals(completed, 0);
    assertEquals(await Deno.readTextFile(`${dir}/persist.json`), '{"pass":2}');
    assertEquals(await Deno.readTextFile(`${dir}/state.json`), '{"pass":1}');
    release.resolve();
    await Promise.all(requests);
    assertEquals(passes, 4);
    assertEquals(completed, 3);
    assertEquals(maxActive, 1);
    assertEquals(await Deno.readTextFile(`${dir}/state.json`), '{"pass":4}');
  } finally {
    Deno.umask(oldMask);
    release.resolve();
    controller.abort();
    await Promise.allSettled(requests);
    await serving;
  }
});

Deno.test("a requested pass cannot postpone a due timed pass", async () => {
  const path = `${dir}/tick.sock`;
  const controller = new AbortController();
  const ready = gate();
  const entered = gate();
  const release = gate();
  let passes = 0;
  const serving = controlLoop({
    path,
    tickMs: 200,
    signal: controller.signal,
    pass: async () => {
      passes++;
      if (passes === 1) ready.resolve();
      if (passes === 2) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const requests: Promise<void>[] = [];
  try {
    await ready.promise;
    requests.push(requestTick(path));
    await entered.promise;
    requests.push(requestTick(path));
    // Make the timer due while the first manual pass is in flight.
    await pause(250);
    release.resolve();
    await Promise.all(requests);
    assertEquals(passes, 4); // Startup, manual, due timer, queued manual.
  } finally {
    release.resolve();
    controller.abort();
    await Promise.allSettled(requests);
    await serving;
  }
});

Deno.test("failed passes and timed-out clients do not stop later control", async () => {
  const path = `${dir}/tick.sock`;
  const controller = new AbortController();
  const ready = gate();
  const release = gate();
  let passes = 0;
  const serving = controlLoop({
    path,
    tickMs: 60_000,
    signal: controller.signal,
    pass: async () => {
      passes++;
      if (passes === 1) ready.resolve();
      if (passes === 2) throw new Error("state write or control failed");
      if (passes === 3) await release.promise;
    },
  });
  try {
    await ready.promise;
    await assertRejects(() => requestTick(path), TickError, "tick failed");
    await assertRejects(() => requestTick(path, 20), TickError, "timed out");
    release.resolve();
    await requestTick(path);
    assertEquals(passes, 4);
  } finally {
    release.resolve();
    controller.abort();
    await serving;
  }
  await assertRejects(() => requestTick(path), TickError, "cannot reach governor");
});

Deno.test("shutdown finishes the active pass before acknowledging it and removes the socket", async () => {
  const path = `${dir}/tick.sock`;
  const controller = new AbortController();
  const ready = gate();
  const entered = gate();
  const release = gate();
  let passes = 0;
  const serving = controlLoop({
    path,
    tickMs: 60_000,
    signal: controller.signal,
    pass: async () => {
      passes++;
      if (passes === 1) ready.resolve();
      else {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    await ready.promise;
    const request = requestTick(path);
    await entered.promise;
    controller.abort();
    release.resolve();
    await request;
    await serving;
    assertEquals(passes, 2);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  } finally {
    release.resolve();
    controller.abort();
    await serving;
  }
});

Deno.test("startup replaces a stale socket and refuses to remove an ordinary file", async () => {
  const path = `${dir}/tick.sock`;
  const stale = Deno.listen({ transport: "unix", path });
  stale.close();
  const controller = new AbortController();
  try {
    await controlLoop({
      path,
      tickMs: 60_000,
      signal: controller.signal,
      pass: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    await Deno.writeTextFile(path, "keep");
    await assertRejects(
      () =>
        controlLoop({
          path,
          tickMs: 60_000,
          signal: new AbortController().signal,
          pass: () => Promise.resolve(),
        }),
      Error,
      "refusing to remove non-socket",
    );
    assertEquals(await Deno.readTextFile(path), "keep");
  } finally {
    await Deno.remove(path);
  }
});
