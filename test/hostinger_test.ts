import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BROKER_CAPABILITY,
  BROKER_COOLDOWN_SECONDS,
  CHECK_WINDOW_MS,
  cpuReadings,
  MAX_INTERVAL_MS,
  MAX_RESPONSE,
  MAX_VM_ID,
  parseReadings,
  REQUEST_TIMEOUT_MS,
  TEMPORARY_ERRORS,
  validateSource,
  vm,
} from "../src/hostinger.ts";
import { MAX_VCPUS } from "../src/plans.ts";
import { testDirectory } from "./temp.ts";

const cliArguments = (mode: "connection" | "unsupported", args: string[]) => [
  "run",
  "--allow-env=GOVERNOR_CONFIG",
  `--allow-read=src,test/fixtures${mode === "connection" ? ",test/.tmp" : ""}`,
  ...(mode === "connection" ? ["--allow-run=/bin/bash"] : []),
  "--",
  "test/fixtures/cli-harness.ts",
  mode,
  ...args,
];

Deno.test("TypeScript broker protocol bounds match the shared contract fixture", async () => {
  const contract = JSON.parse(await Deno.readTextFile("test/fixtures/hostinger-protocol.json"));
  assertEquals(MAX_RESPONSE, contract.max_response_bytes);
  assertEquals(MAX_INTERVAL_MS, contract.max_interval_ms);
  assertEquals(MAX_VM_ID, contract.max_vm_id);
  assertEquals(MAX_VCPUS, contract.max_vcpus);
  assertEquals(REQUEST_TIMEOUT_MS, contract.request_timeout_ms);
  assertEquals(BROKER_COOLDOWN_SECONDS, contract.cooldown_seconds);
  assertEquals(CHECK_WINDOW_MS, contract.check_window_ms);
  assertEquals(BROKER_CAPABILITY, contract.capability);
  assertEquals(TEMPORARY_ERRORS, contract.temporary_errors);
});

const metric = (
  unit = "%",
  usage: Record<string, number> = { "1000": 20, "2800": 25, "4600": 30 },
) => ({ cpu_usage: { unit, usage } });
Deno.test("CPU metrics validate units, sort timestamps and discard the newest bucket", () => {
  assertEquals(parseReadings(metric(), 0, 5_000_000), [{ at: 1_000_000, v: 20 }, {
    at: 2_800_000,
    v: 25,
  }]);
  assertEquals(parseReadings(metric("percent"), 0, 5_000_000).length, 2);
});

Deno.test("malformed CPU metrics cannot become credit evidence", () => {
  assertThrows(() => parseReadings(metric("cores"), 0, 5_000_000));
  assertThrows(() => parseReadings({ cpu_usage: { usage: { "1000": 20 } } }, 0, 5_000_000));
  assertThrows(() =>
    parseReadings(metric("%", { "1000": 120, "2800": 0, "4600": 0 }), 0, 5_000_000)
  );
  assertThrows(() => parseReadings(metric("%", { "bad": 0 }), 0, 5_000_000));
  assertThrows(() => parseReadings(metric(), 0, 100));
  assertEquals(parseReadings({}, 0, 5_000_000), []);
});

const broker = (script: string) => ({ request_command: ["/bin/bash", "-c", script] });
const reply = (data: unknown, vm_id = 123, version = 1) =>
  `printf '%s' '${JSON.stringify({ version, vm_id, data })}'`;

Deno.test("operation broker receives only a versioned VM request on stdin", async () => {
  const src = broker(
    `IFS= read -r request; [[ $request == '{"version":1,"operation":"vm","vm_id":123}' ]] || exit 1; ${
      reply({ cpus: 8 })
    }`,
  );
  assertEquals(await vm(src, 123), { cpus: 8, plan: undefined });
});

Deno.test("operation broker starts from the root directory, not the caller's", async () => {
  const src = broker(`IFS= read -r request; [[ $PWD == / ]] || exit 1; ${reply({ cpus: 8 })}`);
  assertEquals(await vm(src, 123), { cpus: 8, plan: undefined });
});

Deno.test("operation broker receives bounded metrics parameters and keeps bucket validation", async () => {
  const src = broker(
    `IFS= read -r request; [[ $request == '{"version":1,"operation":"metrics","vm_id":123,"from":0,"to":5000000}' ]] || exit 1; ${
      reply(metric())
    }`,
  );
  assertEquals(await cpuReadings(src, 123, 0, 5_000_000), [
    { at: 1_000_000, v: 20 },
    { at: 2_800_000, v: 25 },
  ]);
  await assertRejects(() => cpuReadings(broker(reply(metric("cores"))), 123, 0, 5_000_000));
});

Deno.test("broker errors never echo its stderr, malformed output, or upstream error text", async () => {
  for (
    const script of [
      "printf 'secret-token' >&2; exit 1",
      "printf 'secret-token'",
      reply({ cpus: 8 }, 124),
      reply({ cpus: 8 }, 123, 2),
      reply(null),
      reply([]),
      "printf 'secret-token'; exit 1",
    ]
  ) {
    const error = await assertRejects(() => vm(broker(script), 123), Error);
    assertEquals(error.message, "Hostinger request command failed");
  }
});

Deno.test("only fixed busy and cooldown codes may explain a broker refusal", async () => {
  for (const code of ["busy", "rate_limited"]) {
    const src = broker(
      `IFS= read -r request; printf '%s' '{"version":1,"vm_id":123,"error":"${code}"}'`,
    );
    const error = await assertRejects(() => vm(src, 123), Error);
    assertEquals(
      error.message.includes(code === "busy" ? "retry shortly" : "retry in 60 seconds"),
      true,
    );
  }
  const src = broker(
    `IFS= read -r request; printf '%s' '{"version":1,"vm_id":123,"error":"secret-token"}'`,
  );
  const error = await assertRejects(() => vm(src, 123), Error);
  assertEquals(error.message, "Hostinger request command failed");
});

Deno.test("broker output has a fixed memory limit", async () => {
  await assertRejects(
    () => vm(broker("IFS= read -r request; head -c 4194305 /dev/zero"), 123),
    Error,
    "Hostinger request command failed",
  );
});

Deno.test("broker input and VM replies are validated without executing an invalid request", async () => {
  const src = broker("exit 99");
  for (const id of [0, -1, 1.5, NaN, Infinity]) {
    await assertRejects(() => vm(src, id), Error, "invalid Hostinger VM ID");
  }
  for (const [from, to] of [[-1, 1], [2, 1], [0, NaN], [0, 48 * 3_600_000 + 1]]) {
    await assertRejects(
      () => cpuReadings(src, 123, from, to),
      Error,
      "invalid Hostinger metrics interval",
    );
  }
  for (const data of [{ cpus: -1 }, { cpus: "8" }, { cpus: 1.5 }, { plan: {} }]) {
    await assertRejects(() => vm(broker(reply(data)), 123));
  }
});

Deno.test("broker configuration refuses ambiguous credential sources and malformed commands", () => {
  validateSource(broker("exit 0"));
  validateSource({ token_file: "/etc/token", token_command: ["secret-store", "get"] });
  assertThrows(() => validateSource({ ...broker("exit 0"), token_file: "/etc/token" }));
  assertThrows(() => validateSource({ ...broker("exit 0"), token_command: ["secret-store"] }));
  assertThrows(() => validateSource({ request_command: ["relative-command"] }));
  assertThrows(() => validateSource({ request_command: [] }));
  assertThrows(() => validateSource({ request_command: ["/bin/bash", "bad\0argument"] }));
  assertThrows(() => validateSource({ token_command: [] }));
});

Deno.test("an unavailable broker cannot fall back to direct API access", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error("direct API access must not be attempted");
  };
  try {
    await assertRejects(() => vm(broker("exit 1"), 123));
    assertEquals(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("broker commands have a deadline and are reaped on timeout", async () => {
  await assertRejects(
    () => vm(broker("IFS= read -r request; while :; do :; done"), 123),
    Error,
    "Hostinger request command timed out",
  );
});

Deno.test("check-hostinger CLI exercises both broker operations without outputting credentials", async () => {
  const directory = await testDirectory("connection-check-");
  const config = `${directory}/config.json`;
  const seconds = Math.floor(Date.now() / 1000);
  const recent = metric("%", { [seconds - 5400]: 10, [seconds - 3600]: 20, [seconds - 1800]: 30 });
  const command = `IFS= read -r request; case $request in *'"operation":"vm"'*) ${
    reply({ cpus: 8 })
  };; *) ${reply(recent)};; esac`;
  try {
    await Deno.writeTextFile(
      config,
      JSON.stringify({ hostinger: { vm_id: 123, ...broker(command) } }),
    );
    const run = async (args: string[]) =>
      await new Deno.Command(Deno.execPath(), {
        // Exercise the real CLI, replacing only the Linux /proc/stat read so this
        // connection test can run on a developer's macOS machine too.
        args: cliArguments("connection", ["check-hostinger", ...args]),
        env: { GOVERNOR_CONFIG: `${Deno.cwd()}/${config}` },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const out = await run([]);
    assertEquals(out.code, 0);
    assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), {
      vm_id: 123,
      cpus: 8,
      cpu_samples: 2,
    });
    const help = await run(["--help"]);
    assertEquals(help.code, 0);
    assertEquals(
      new TextDecoder().decode(help.stdout).includes("request_command v1 supported"),
      true,
    );
    await Deno.writeTextFile(
      config,
      JSON.stringify({ hostinger: { vm_id: 123, ...broker("printf secret-token >&2; exit 1") } }),
    );
    const failed = await run([]);
    assertEquals(failed.code !== 0, true);
    assertEquals(new TextDecoder().decode(failed.stdout).includes("secret-token"), false);
    assertEquals(new TextDecoder().decode(failed.stderr).includes("secret-token"), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

for (
  const command of [["status", "--json"], ["report", "--format", "json"], ["exec", "--", "true"]]
) {
  Deno.test(`${command[0]} explains an unsupported schema without a stack trace`, async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: cliArguments("unsupported", command),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 3);
    const message = new TextDecoder().decode(result.stderr);
    assertEquals(message.includes("schema is unsupported"), true);
    assertEquals(message.includes("not running"), false);
    assertEquals(message.includes("at file:"), false);
  });
}
