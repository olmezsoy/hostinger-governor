// Run the real CLI with only its Linux kernel/state reads replaced. Child CLI
// permissions are explicit; unlike `deno eval`, this does not imply full access.
import { STATE_FILE } from "../../src/governor.ts";
const mode = Deno.args.shift();
if (mode === "tick-consumer") Deno.uid = () => 1000;
const original = Deno.readTextFile;
Deno.readTextFile = (...args) => {
  if (mode === "connection" && String(args[0]) === "/proc/stat") {
    return Promise.resolve(Array.from({ length: 8 }, (_, i) => `cpu${i} 0 0 0`).join("\n"));
  }
  if (mode === "unsupported" && String(args[0]) === STATE_FILE) {
    return Promise.resolve('{"schemaVersion":99}');
  }
  return original(...args);
};
await import("../../src/main.ts");
