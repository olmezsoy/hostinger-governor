import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { testDirectory } from "./temp.ts";
import { HOOK_QUEUE_LIMIT, HookError, HookRunner, startHook, terminateHook } from "../src/hooks.ts";

Deno.test("hook cleanup distinguishes missing processes from denied signals and tries the parent", () => {
  let parents = 0;
  const child = {
    pid: 123,
    kill: () => {
      parents++;
    },
  };
  assertEquals(
    terminateHook(child, () => {
      throw new Deno.errors.NotFound();
    }),
    true,
  );
  assertEquals(
    terminateHook(child, () => {
      throw new Deno.errors.PermissionDenied();
    }),
    false,
  );
  assertEquals(parents, 2);
  assertEquals(
    terminateHook({
      ...child,
      kill: () => {
        throw new Error("secret");
      },
    }, () => {}),
    false,
  );
});

Deno.test("hook runner accepts the same timeout range as configuration", () => {
  for (const seconds of [0, 0.5, 301, NaN, Infinity]) {
    assertThrows(() => new HookRunner("/hooks", seconds));
  }
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

Deno.test("hook queue returns immediately, preserves event order and captures the original state", async () => {
  const gate = deferred();
  const seen: { event: string; payload: string; timeout: number }[] = [];
  const runner = new HookRunner("/hooks", 2, {
    listFiles: () => Promise.resolve(["10-notify"]),
    start: (_command, event, payload, timeout) => {
      seen.push({ event, payload, timeout });
      return { done: seen.length === 1 ? gate.promise : Promise.resolve(), cancel: gate.resolve };
    },
  });
  try {
    const state = { schemaVersion: 1, credits: { balance: 0 } };
    assertEquals(runner.enqueue("limit-start", state), true);
    state.credits.balance = 100;
    assertEquals(runner.enqueue("limit-end", state), true);
    await Promise.resolve();
    assertEquals(seen.length, 1);
    gate.resolve();
    await runner.idle();
    assertEquals(seen, [
      {
        event: "limit-start",
        payload: '{"schemaVersion":1,"credits":{"balance":0}}',
        timeout: 2000,
      },
      {
        event: "limit-end",
        payload: '{"schemaVersion":1,"credits":{"balance":100}}',
        timeout: 2000,
      },
    ]);
  } finally {
    gate.resolve();
    await runner.close();
  }
});

Deno.test("one failed hook does not prevent the next hook or event", async () => {
  const seen: string[] = [];
  const logs: string[] = [];
  const runner = new HookRunner("/hooks", 1, {
    listFiles: () => Promise.resolve(["10-bad", "20-good"]),
    start: (command, event) => {
      seen.push(`${event}:${command[0]}`);
      return {
        done: command[0].endsWith("bad")
          ? Promise.reject(new HookError("timeout"))
          : Promise.resolve(),
        cancel: () => {},
      };
    },
    log: (message) => logs.push(message),
  });
  runner.enqueue("limit-start", {});
  runner.enqueue("limit-end", {});
  await runner.idle();
  await runner.close();
  assertEquals(seen, [
    "limit-start:/hooks/10-bad",
    "limit-start:/hooks/20-good",
    "limit-end:/hooks/10-bad",
    "limit-end:/hooks/20-good",
  ]);
  assertEquals(logs.length, 2);
});

Deno.test("hook backlog is bounded and shutdown cancels active and queued work", async () => {
  const gate = deferred();
  let starts = 0;
  const logs: string[] = [];
  const runner = new HookRunner("/hooks", 1, {
    listFiles: () => Promise.resolve(["10-slow"]),
    start: () => {
      starts++;
      return {
        done: gate.promise,
        cancel: () => gate.reject(new Error("cancelled during shutdown")),
      };
    },
    log: (message) => logs.push(message),
  });
  runner.enqueue("limit-start", {});
  await Promise.resolve();
  for (let i = 0; i < HOOK_QUEUE_LIMIT; i++) assert(runner.enqueue("limit-end", {}));
  assertEquals(runner.enqueue("limit-end", {}), false);
  await runner.close();
  assertEquals(starts, 1);
  assertEquals(runner.enqueue("limit-start", {}), false);
  assert(logs.some((message) => message.includes("queue full")));
});

Deno.test("hook payloads and error output cannot grow daemon memory or leak exception text", async () => {
  const logs: string[] = [];
  const runner = new HookRunner("/hooks", 1, {
    listFiles: () => Promise.resolve(["10-notify"]),
    start: () => {
      throw new Error("secret-token");
    },
    log: (message) => logs.push(message),
  });
  assertEquals(runner.enqueue("limit-start", "x".repeat(1_048_577)), false);
  runner.enqueue("limit-end", {});
  await runner.idle();
  await runner.close();
  assert(logs.every((message) => !message.includes("secret-token")));
});

Deno.test("real hooks receive the event and state and nonzero exits are rejected", async () => {
  await startHook(
    [
      "/bin/bash",
      "-c",
      "IFS= read -r line || :; [[ $GOVERNOR_EVENT == limit-start && $line == '{\"schemaVersion\":1}' ]]",
    ],
    "limit-start",
    '{"schemaVersion":1}',
    1000,
  ).done;
  await assertRejects(
    () => startHook(["/bin/bash", "-c", "exit 7"], "limit-end", "{}", 1000).done,
    Error,
    "exited 7",
  );
});

Deno.test("deadline includes blocked stdin and kills a hook that ignores SIGTERM", async () => {
  const started = performance.now();
  const hook = startHook(
    ["/bin/bash", "-c", "trap '' TERM; while :; do :; done"],
    "limit-start",
    "x".repeat(500_000),
    80,
  );
  await assertRejects(() => hook.done, Error, "timed out");
  assert(performance.now() - started < 2000);
});

Deno.test("shutdown immediately cancels a running hook rather than waiting for its deadline", async () => {
  const hook = startHook(
    ["/bin/bash", "-c", "trap '' TERM; while :; do :; done"],
    "limit-start",
    "x".repeat(500_000),
    10_000,
  );
  hook.cancel();
  await assertRejects(() => hook.done, Error, "cancelled during shutdown");
});

Deno.test("timed-out hooks cannot leave ordinary child processes running", async () => {
  const directory = await testDirectory("hook-test-");
  const path = `${Deno.cwd()}/${directory}/pid`;
  const hook = startHook(
    [
      "/bin/bash",
      "-c",
      '(trap "" TERM; while :; do sleep 1; done) & printf "%s" "$!" > "$1"; wait',
      "hook-test",
      path,
    ],
    "limit-start",
    "{}",
    200,
  );
  try {
    await assertRejects(() => hook.done, Error, "timed out");
    const pid = Number(await Deno.readTextFile(path));
    assert(Number.isSafeInteger(pid) && pid > 1);
    const result = await new Deno.Command("/bin/bash", {
      args: ["-c", 'ps -o stat= -p "$1"', "check-own-child", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    const state = new TextDecoder().decode(result.stdout).trim();
    assert(!state || state.startsWith("Z"), "hook child must be terminated");
  } finally {
    hook.cancel();
    await hook.done.catch(() => {});
    await Deno.remove(directory, { recursive: true });
  }
});
