import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { execOptions, scopeArgs, waitForAccepting } from "../src/exec.ts";

Deno.test("exec accepts bounded waits without consuming command arguments", () => {
  assertEquals(execOptions(["--wait", "120", "--", "job", "--wait", "5"]), {
    waitSeconds: 120,
    command: ["job", "--wait", "5"],
  });
  assertEquals(execOptions(["--", "job"]), { waitSeconds: 0, command: ["job"] });
  assertEquals(execOptions(["job", "arg"]), { waitSeconds: 0, command: ["job", "arg"] });
  for (
    const args of [
      [],
      ["--"],
      ["--wait"],
      ["--wait", "-1", "--", "job"],
      ["--wait", "NaN", "--", "job"],
      ["--wait", "86401", "--", "job"],
      ["--wait", "1", "job"],
      ["--wait", "1", "--"],
    ]
  ) {
    assertThrows(() => execOptions(args));
  }
});

Deno.test("root batch scopes compete at low weight directly under user.slice", () => {
  assertEquals(scopeArgs(["job"], true), [
    "--slice=user.slice",
    "--scope",
    "--quiet",
    "--property=CPUWeight=1",
    "--",
    "job",
  ]);
  assertEquals(scopeArgs(["job"], false), [
    "--user",
    "--scope",
    "--quiet",
    "--property=CPUWeight=1",
    "--",
    "job",
  ]);
});

Deno.test("exec wait rechecks accepting and never starts after its deadline", async () => {
  let now = 0;
  let reads = 0;
  let accepting = false;
  const io = {
    now: () => now,
    state: () => {
      reads++;
      return Promise.resolve({ accepting });
    },
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
  assertEquals(await waitForAccepting(0, io), false);
  assertEquals(reads, 1);
  assertEquals(await waitForAccepting(2.5, io), false);
  assertEquals(now, 2500);
  accepting = true;
  assertEquals(await waitForAccepting(0, io), true);
  accepting = false;
  io.sleep = (ms) => {
    now += ms;
    accepting = true;
    return Promise.resolve();
  };
  assertEquals(await waitForAccepting(5, io), true);
  io.state = () => Promise.reject(new Error("invalid state"));
  await assertRejects(() => waitForAccepting(1, io));
});

Deno.test("exec wait treats missing state as unavailable and ignores wall-clock jumps", async () => {
  let now = 0;
  let available = false;
  const io = {
    now: () => now,
    state: () => Promise.resolve(available ? { accepting: true } : null),
    sleep: (ms: number) => {
      now += ms;
      available = true;
      return Promise.resolve();
    },
  };
  assertEquals(await waitForAccepting(1, io), true);
});

Deno.test("a slow accepting read cannot start work past a wait deadline", async () => {
  let now = 0;
  assertEquals(
    await waitForAccepting(1, {
      now: () => now,
      state: () => {
        now += 2000;
        return Promise.resolve({ accepting: true });
      },
      sleep: () => Promise.resolve(),
    }),
    false,
  );
});
