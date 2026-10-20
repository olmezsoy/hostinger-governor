// Compiles the governor with the Deno that runs the task, not whichever `deno` is first on PATH.
// Release builds embed --jitless because standalone binaries cannot accept runtime V8 flags.
//
//   deno task compile:jitless [compile flags]    jitless build, dist/governor without flags
//   deno task compile:jit-fixture -o <file>      JIT-enabled build for the smoke test
const [mode, ...flags] = Deno.args;
let modeFlags: string[];
if (mode === "jitless") {
  modeFlags = ["--v8-flags=--jitless", ...(flags.length ? flags : ["-o", "dist/governor"])];
} else if (mode === "jit-fixture" && flags.length) {
  modeFlags = flags;
} else {
  console.error("usage: compile.ts jitless [compile flags] | jit-fixture -o <file>");
  Deno.exit(2);
}
const { code } = await new Deno.Command(Deno.execPath(), {
  args: ["compile", "--allow-all", ...modeFlags, "src/main.ts"],
}).spawn().status;
Deno.exit(code);
