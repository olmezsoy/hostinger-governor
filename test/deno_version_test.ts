import { assert, assertEquals } from "@std/assert";
import config from "../deno.json" with { type: "json" };
import { versionProblem } from "../tools/deno-version.ts";

Deno.test("only the Deno version in .tool-versions runs the tasks", () => {
  assertEquals(versionProblem("2.9.7", "deno 2.9.7\n"), undefined);
  assertEquals(versionProblem("2.9.7", "python 3.12.0\ndeno v2.9.7\n"), undefined);
  assertEquals(
    versionProblem("2.7.13", "deno 2.9.7\n"),
    "This is Deno 2.7.13, but CI checks with Deno 2.9.7 (.tool-versions). Run the task with " +
      "Deno 2.9.7 instead of changing files to pass under 2.7.13.",
  );
});

Deno.test(".tool-versions must exist and pin an exact Deno version", () => {
  assertEquals(
    versionProblem("2.9.7", undefined),
    "There is no .tool-versions naming the Deno version CI installs.",
  );
  // setup-deno would not read the first as 2.9.8 either, and installs whatever the others resolve to.
  for (const file of ["deno 2.9.8 # next\n", "deno 2.9.8-rc.1\n", "deno 2.x\n", "node 22.0.0\n"]) {
    assertEquals(
      versionProblem("2.9.8", file),
      '.tool-versions must pin an exact Deno version, such as "deno 2.9.7".',
      file,
    );
  }
});

Deno.test("every task but the rules watcher's checks the Deno version first", () => {
  // The watcher's workflow follows the latest Deno 2, and its record does not depend on the version.
  const exempt = new Set(["deno:version", "rules:check", "rules:accept"]);
  for (const [name, task] of Object.entries(config.tasks)) {
    const dependencies: string[] = typeof task === "object" && "dependencies" in task
      ? task.dependencies
      : [];
    assertEquals(dependencies.includes("deno:version"), !exempt.has(name), name);
  }
});

Deno.test("CI and release builds install the Deno in .tool-versions", async () => {
  for (const file of ["ci.yml", "release.yml"]) {
    const text = await Deno.readTextFile(`.github/workflows/${file}`);
    const setups = text.match(/uses: denoland\/setup-deno@/g)?.length ?? 0;
    assert(setups > 0, file);
    assertEquals(text.match(/^\s*deno-version-file: \.tool-versions$/gm)?.length, setups, file);
    assert(!/^\s*deno-version:/m.test(text), file);
  }
});
