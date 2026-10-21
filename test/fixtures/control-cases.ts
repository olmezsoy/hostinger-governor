import { assert, assertEquals, assertRejects } from "@std/assert";
import { controlLoop, requestTick, TickError } from "../../src/control.ts";
import { controlPass } from "../../src/governor.ts";
import { fixture, p } from "../governor-fixture.ts";

const dir = Deno.env.get("GOVERNOR_TICK_TEST_DIR")!;
const path = `${dir}/tick.sock`;
const gate = () => Promise.withResolvers<void>();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function server(
  pass: (n: number) => Promise<void>,
  options: Partial<Pick<Parameters<typeof controlLoop>[0], "tickMs" | "listen">> = {},
) {
  const controller = new AbortController();
  const ready = gate();
  const errors: unknown[] = [];
  const requests: Promise<void>[] = [];
  let passes = 0;
  const done = controlLoop({
    path,
    tickMs: 60_000,
    ...options,
    signal: controller.signal,
    onSocketError: (error) => errors.push(error),
    pass: async () => {
      const n = ++passes;
      try {
        await pass(n);
      } finally {
        if (n === 1) ready.resolve();
      }
    },
  });
  void done.catch(ready.reject);
  return {
    ready: ready.promise,
    done,
    errors,
    controller,
    get passes() {
      return passes;
    },
    tick(timeoutMs?: number) {
      const request = requestTick(path, timeoutMs);
      requests.push(request);
      void request.catch(() => {});
      return request;
    },
    async stop() {
      controller.abort();
      await done;
      await Promise.allSettled(requests);
    },
  };
}

Deno.test("requested passes serialize and acknowledge only after both state writes", async () => {
  const entered = gate();
  const release = gate();
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const oldMask = Deno.umask(0);
  const s = server(async (n) => {
    maxActive = Math.max(maxActive, ++active);
    await Deno.writeTextFile(`${dir}/persist.json`, JSON.stringify({ pass: n }));
    if (n === 2) {
      entered.resolve();
      await release.promise;
    }
    await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify({ pass: n }));
    active--;
  });
  try {
    await s.ready;
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(Deno.umask(), 0);
    Deno.umask(oldMask);
    const requests = Array.from({ length: 3 }, () =>
      s.tick().then(() => {
        completed++;
      }));
    await entered.promise;
    await pause(10);
    assertEquals(completed, 0);
    assertEquals(await Deno.readTextFile(`${dir}/persist.json`), '{"pass":2}');
    assertEquals(await Deno.readTextFile(`${dir}/state.json`), '{"pass":1}');
    release.resolve();
    await Promise.all(requests);
    assertEquals(s.passes, 4);
    assertEquals(completed, 3);
    assertEquals(maxActive, 1);
    assertEquals(await Deno.readTextFile(`${dir}/state.json`), '{"pass":4}');
  } finally {
    Deno.umask(oldMask);
    release.resolve();
    await s.stop();
  }
});

Deno.test("a requested pass cannot postpone a due timed pass", async () => {
  const entered = gate();
  const release = gate();
  const s = server(async (n) => {
    if (n === 2) {
      entered.resolve();
      await release.promise;
    }
  }, { tickMs: 200 });
  try {
    await s.ready;
    const first = s.tick();
    await entered.promise;
    const second = s.tick();
    await pause(250);
    release.resolve();
    await Promise.all([first, second]);
    assertEquals(s.passes, 4); // Startup, manual, due timer, queued manual.
  } finally {
    release.resolve();
    await s.stop();
  }
});

Deno.test("failed passes and timed-out clients do not stop later control", async () => {
  const release = gate();
  const s = server(async (n) => {
    if (n === 2) throw new Error("state write or control failed");
    if (n === 3) await release.promise;
  });
  try {
    await s.ready;
    await assertRejects(() => s.tick(), TickError, "tick failed");
    await assertRejects(() => s.tick(20), TickError, "timed out");
    release.resolve();
    await s.tick();
    assertEquals(s.passes, 4);
  } finally {
    release.resolve();
    await s.stop();
  }
  await assertRejects(() => requestTick(path), TickError, "cannot reach governor");
});

Deno.test("shutdown finishes the active pass before acknowledging it and removes the socket", async () => {
  const entered = gate();
  const release = gate();
  const s = server(async (n) => {
    if (n > 1) {
      entered.resolve();
      await release.promise;
    }
  });
  try {
    await s.ready;
    const request = s.tick();
    await entered.promise;
    s.controller.abort();
    release.resolve();
    await request;
    await s.done;
    assertEquals(s.passes, 2);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  } finally {
    release.resolve();
    await s.stop();
  }
});

Deno.test("startup replaces a stale socket without interrupting control", async () => {
  const stale = Deno.listen({ transport: "unix", path });
  // Deno can unlink on close. Move the entry first to preserve an actual abandoned socket.
  await Deno.rename(path, `${path}.stale`);
  stale.close();
  await Deno.rename(`${path}.stale`, path);
  assert((await Deno.lstat(path)).isSocket);
  const s = server(() => Promise.resolve());
  try {
    await s.ready;
    await s.tick();
    assertEquals(s.errors, []);
    assertEquals(s.passes, 2);
  } finally {
    await s.stop();
  }
});

for (
  const failure of ["ordinary file", "listen", "accept", "sync accept", "occupied socket"] as const
) {
  Deno.test(`${failure} failure leaves timed control running`, async () => {
    let occupied: Deno.UnixListener | undefined;
    if (failure === "ordinary file") await Deno.writeTextFile(path, "keep");
    if (failure === "occupied socket") occupied = Deno.listen({ transport: "unix", path });
    const s = server(() => Promise.resolve(), {
      tickMs: 5,
      listen: (path) => {
        if (failure === "listen") throw new Error("injected listen failure");
        const listener = Deno.listen({ transport: "unix", path });
        if (failure === "accept") {
          listener.accept = () => Promise.reject(new Error("injected accept failure"));
        }
        if (failure === "sync accept") {
          listener.accept = () => {
            throw new Error("injected synchronous accept failure");
          };
        }
        return listener;
      },
    });
    try {
      await s.ready;
      // Wait for multiple timed passes after the socket error, with a bounded test deadline.
      for (let i = 0; i < 100 && s.passes < 3; i++) await pause(5);
      assert(s.passes >= 3);
      assertEquals(s.errors.length, 1);
      if (failure === "ordinary file") {
        assertEquals(await Deno.readTextFile(path), "keep");
      }
      if (occupied) assert((await Deno.lstat(path)).isSocket);
    } finally {
      await s.stop();
      occupied?.close();
      if (failure === "ordinary file" || occupied) {
        await Deno.remove(path).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    }
  });
}

Deno.test("real control passes apply queued requests, publish state and report cap failure once", async () => {
  await Deno.mkdir(`${dir}/requests`, { recursive: true });
  const f = fixture({}, { run: dir, lib: dir });
  // Keep real files and ownership validation; emulate root ownership for this unprivileged test.
  f.g.io.requestInfo = async (path) => ({ ...await Deno.lstat(path), uid: 0 });
  f.g.io.requestBody = Deno.readTextFile;
  let saves = 0;
  const save = f.g.save.bind(f.g);
  f.g.save = async (at) => {
    saves++;
    await save(at);
  };
  const s = server(() => controlPass(f.g));
  const readState = async () => JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  const readPersist = async () => JSON.parse(await Deno.readTextFile(`${dir}/persist.json`));
  const queue = (action: string) =>
    Deno.writeTextFile(`${dir}/requests/control.json`, JSON.stringify({ action }), { mode: 0o644 });
  try {
    await s.ready;
    f.elapse(30);
    await queue("limit-on");
    await s.tick();
    assert((await readState()).limit);
    assertEquals((await readState()).accepting, false);
    assertEquals((await readState()).ceiling, f.cap);
    assert((await readPersist()).limit);
    await assertRejects(() => Deno.stat(`${dir}/requests/control.json`), Deno.errors.NotFound);
    const ceiling = f.cap;
    const samples = f.g.s.samples.length;
    f.elapse(0.02, 0.25, 0, 0, 0.02, 16);
    await s.tick();
    assertEquals(f.cap, ceiling);
    assertEquals(f.g.s.samples.length, samples);
    await queue("limit-off");
    await s.tick();
    assertEquals((await readState()).limit, null);
    assertEquals((await readState()).accepting, true);
    assertEquals((await readState()).ceiling, f.cap);
    assertEquals((await readPersist()).balance, p.recovered);
    f.capFails();
    await queue("limit-on");
    const before = saves;
    await assertRejects(() => s.tick(), TickError, "tick failed");
    assertEquals(saves - before, 1);
    assertEquals((await readState()).accepting, false);
    assertEquals((await readPersist()).capFailed, true);
  } finally {
    await s.stop();
    await f.g.closeHooks();
  }
});

Deno.test("real state write failure reaches the caller and a later pass can recover", async () => {
  const f = fixture({}, { run: dir, lib: dir });
  const s = server(() => controlPass(f.g));
  try {
    await s.ready;
    const before = await Deno.readTextFile(`${dir}/state.json`);
    await Deno.mkdir(`${dir}/state.json.tmp`);
    await assertRejects(() => s.tick(), TickError, "tick failed");
    assertEquals(await Deno.readTextFile(`${dir}/state.json`), before);
    await Deno.remove(`${dir}/state.json.tmp`);
    await s.tick();
  } finally {
    await s.stop();
    await f.g.closeHooks();
  }
});

Deno.test("timed cap failures publish once per pass without duplicate failure logging", async () => {
  const f = fixture({}, { run: dir, lib: dir });
  await f.g.tick();
  f.g.s.balance = p.capacity;
  f.capFails();
  let saves = 0;
  const save = f.g.save.bind(f.g);
  f.g.save = async (at) => {
    saves++;
    await save(at);
  };
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args) => {
    logs.push(args.map(String).join(" "));
  };
  const s = server(() => controlPass(f.g), { tickMs: 5 });
  try {
    await s.ready;
    for (let i = 0; i < 100 && s.passes < 3; i++) await pause(5);
  } finally {
    await s.stop();
    console.log = log;
    await f.g.closeHooks();
  }
  assert(s.passes >= 3);
  assertEquals(saves, s.passes);
  assertEquals(logs.some((line) => line.includes("tick failed")), false);
  const state = JSON.parse(await Deno.readTextFile(`${dir}/state.json`));
  assertEquals(state.accepting, false);
});
