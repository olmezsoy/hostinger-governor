import { assert, assertEquals } from "@std/assert";

const script = await Deno.readTextFile("install.sh");
const helper = script.split("cat > /usr/local/libexec/governor-cap <<'EOF'\n")[1].split("\nEOF")[0];
async function helperResult(args: string[]) {
  // Stub machine access and the final systemctl command, so tests cannot change the host.
  const body = helper.replace("max=$(( $(grep -c '^cpu[0-9]' /proc/stat) * 100 ))", "max=800")
    .replace(
      'exec systemctl set-property --runtime "$slice" "CPUQuota=$p%"',
      'printf "%s\\n" "$slice" "CPUQuota=$p%"',
    );
  return await new Deno.Command("bash", {
    args: ["-c", body, "governor-cap", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

for (const args of [["200"], ["800", "user.slice"]]) {
  Deno.test(`cap helper permits only the managed slice: ${args.join(" ")}`, async () => {
    const out = await helperResult(args);
    assertEquals(out.code, 0);
    assert(new TextDecoder().decode(out.stdout).startsWith("user.slice\n"));
  });
}
for (
  const args of [
    ["200", "system.slice"],
    ["200", "other.slice"],
    ["20", "user.slice", "extra"],
    ["0"],
    ["19"],
    ["801"],
    ["020"],
    ["999999999999999999999999"],
    ["-1"],
  ]
) {
  Deno.test(`cap helper rejects unsafe arguments: ${args.join(" ")}`, async () => {
    assertEquals((await helperResult(args)).code, 2);
  });
}

for (
  const args of [
    ["--vm-id", "abc"],
    ["--vm-id", "0123"],
    ["--vm-id", "1.5"],
    ["--vm-id", "0"],
    ["--vm-id"],
    ["--timezone", 'UTC"oops'],
    ["--baseline-share", "1"],
    ["--resource-files"],
    ["--resource-files", "/definitely-not-a-governor-template-directory"],
  ]
) {
  Deno.test(`installer rejects bad config before any privileged change: ${args.join(" ")}`, async () => {
    const out = await new Deno.Command("bash", {
      args: ["install.sh", ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 2);
  });
}

Deno.test("installer updates package indexes and revokes legacy consumer write access", () => {
  assert(script.indexOf("apt-get update") < script.indexOf("apt-get install"));
  assert(script.includes("-o root -g governor -m 0770 /run/governor/requests"));
  assert(!script.includes("usermod -aG governor-ctl"));
  assert(script.includes("/etc/systemd/system/user.slice.d/10-governor.conf"));
  assert(script.includes("visudo -cf /etc/sudoers.d/governor"));
});
