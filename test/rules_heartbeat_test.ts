import { assertEquals } from "@std/assert";

async function ping(job: string, health: string, url = "https://heartbeat.invalid/check") {
  const result = await new Deno.Command("bash", {
    args: [
      "-c",
      'curl() { printf "%s\\n" "${@: -1}"; }; export -f curl; bash tools/rules-heartbeat.sh',
    ],
    env: { HEARTBEAT_URL: url, WATCH_JOB_STATUS: job, WATCH_HEALTH: health },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("heartbeat is optional and never pings without its secret", async () => {
  assertEquals(await ping("success", "ok", ""), "");
});

Deno.test("heartbeat sends success only for a successful run with a readable article", async () => {
  assertEquals(await ping("success", "ok"), "https://heartbeat.invalid/check");
});

Deno.test("heartbeat sends failure for job failure, unreadable articles and missing health", async () => {
  for (
    const [job, health] of [["failure", "ok"], ["cancelled", "ok"], ["success", "fail"], [
      "success",
      "",
    ]]
  ) {
    assertEquals(await ping(job, health), "https://heartbeat.invalid/check/fail");
  }
});
