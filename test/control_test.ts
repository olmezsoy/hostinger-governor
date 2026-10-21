import { assert, assertEquals } from "@std/assert";
import { testDirectory } from "./temp.ts";
import { cliArguments } from "./cli.ts";

Deno.test("control socket completion, scheduling, failures and lifecycle", async () => {
  const dir = await testDirectory("tick-");
  try {
    const absolute = await Deno.realPath(dir);
    // Scope network access to this one Unix socket. The main test suite stays offline.
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--allow-env=GOVERNOR_CONFIG,GOVERNOR_TICK_TEST_DIR",
        "--allow-sys=umask",
        `--allow-net=unix:${absolute}/tick.sock`,
        `--allow-read=${dir}`,
        `--allow-write=${dir}`,
        "test/fixtures/control-cases.ts",
      ],
      env: { GOVERNOR_TICK_TEST_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      out.code,
      0,
      new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tick CLI requires root and rejects arguments", async () => {
  for (
    const [args, code, message] of [
      [["tick"], 1, "governor tick requires root"],
      [["tick", "extra"], 2, "usage:"],
    ] as const
  ) {
    const out = await new Deno.Command(Deno.execPath(), {
      args: cliArguments("tick-consumer", [...args]),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, code);
    assert(new TextDecoder().decode(out.stderr).includes(message));
  }
});
