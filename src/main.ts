// governor: keeps a Hostinger VPS's CPU credits from running out while spending them on work.
//
//   governor run                    the daemon (systemd runs it as the governor user)
//   governor status [--json]        the state every consumer reads; exit 3 if the daemon is not running
//   governor report [hours] [--format text|html|json]  read-only vitals (default 12 hours)
//   governor limit on|off           tell it what hPanel or Hostinger support says (root only)
//   governor seed <core-seconds>    set the credit balance, for example when moving from another tool
//   governor fallback               run by systemd as root when the daemon stops
//   governor version
import {
  fallback,
  loadConfig,
  type PublicState,
  REQUESTS,
  runDaemon,
  STATE_FILE,
} from "./governor.ts";
import { creditLines, report } from "./report.ts";
import { reportOptions } from "./resource.ts";
import { configureDocker, enrollService } from "./workloads.ts";
import { readClock } from "./sample.ts";
import { execOptions, scopeArgs, waitForAccepting } from "./exec.ts";

export const VERSION = "0.2.2";
const STALE_MS = 5 * 60_000;

async function state(): Promise<PublicState | null> {
  try {
    const s = JSON.parse(await Deno.readTextFile(STATE_FILE)) as PublicState;
    const clock = await readClock();
    const age = s.uptime === null ? Infinity : clock.uptime - s.uptime;
    return s.bootId === clock.bootId && age >= 0 && age <= STALE_MS ? s : null;
  } catch {
    return null;
  }
}

async function ask(body: Record<string, unknown>) {
  if (Deno.uid() !== 0) {
    throw new Error("governor limit and seed require root; consumers can read status");
  }
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await Deno.writeTextFile(`${REQUESTS}/.${name}`, JSON.stringify(body), {
    mode: 0o644,
    createNew: true,
  });
  await Deno.chmod(`${REQUESTS}/.${name}`, 0o644);
  await Deno.rename(`${REQUESTS}/.${name}`, `${REQUESTS}/${name}`);
  console.log("sent; the governor applies it within one tick");
}

const usage = (): never => {
  console.error(
    "usage: governor run | status [--json] | report [hours] [--format text|html|json] | limit on|off | seed <core-seconds> | exec [--wait <seconds>] -- <command> | enroll-service <unit> | configure-docker | version",
  );
  Deno.exit(2);
};

const [cmd, ...args] = Deno.args;
switch (cmd) {
  case "run":
    await runDaemon();
    break;
  case "validate-config":
    await loadConfig();
    console.log("config valid");
    break;
  case "enroll-service":
    if (args.length !== 1) usage();
    await enrollService(args[0]);
    break;
  case "configure-docker":
    if (args.length) usage();
    await configureDocker();
    break;
  case "status": {
    const s = await state();
    if (!s) {
      console.error("governor is not running (no fresh state)");
      Deno.exit(3);
    }
    if (args.includes("--json")) console.log(JSON.stringify(s));
    else {
      const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z";
      console.log(
        [
          `${s.plan.name} · ceiling ${s.ceiling}% · ${
            s.limit ? "LIMITED by Hostinger" : "not limited"
          }`,
          ...creditLines(s, clock),
        ].join("\n"),
      );
    }
    break;
  }
  case "report": {
    const options = (() => {
      try {
        return reportOptions(args);
      } catch {
        return usage();
      }
    })();
    const s = await state();
    console.log(await report(s, options.hours, Date.now(), options.format));
    break;
  }
  case "limit":
    if (args[0] !== "on" && args[0] !== "off") usage();
    await ask({ action: `limit-${args[0]}` });
    break;
  case "seed":
    if (args[0] === undefined || !Number.isFinite(Number(args[0])) || Number(args[0]) < 0) usage();
    await ask({ action: "seed", balance: Number(args[0]) });
    break;
  case "exec": {
    const options = (() => {
      try {
        return execOptions(args);
      } catch {
        return usage();
      }
    })();
    if (
      !await waitForAccepting(options.waitSeconds, {
        state,
        now: () => performance.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })
    ) {
      console.error("governor is not accepting work");
      Deno.exit(3);
    }
    const out = await new Deno.Command("systemd-run", {
      args: scopeArgs(options.command, Deno.uid() === 0),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    Deno.exit(out.code);
    break;
  }
  case "fallback":
    await fallback();
    break;
  case "version":
    console.log(VERSION);
    break;
  default:
    usage();
}
