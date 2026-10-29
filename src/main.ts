// governor: keeps a Hostinger VPS's CPU credits from running out while spending them on work.
//
//   governor run                    the daemon (systemd runs it as the governor user)
//   governor tick                   run one pass now and wait for its state writes (root only)
//   governor status [--json]        the state every consumer reads; exit 3 if the daemon is not running
//   governor report [hours] [--format text|html|json]  read-only vitals (default 12 hours)
//   governor calibrate --explain [--json]  replay the recorded calibration decision (read-only)
//   governor calibrate --reset      return calibration to its configured start (root only)
//   governor limit on|off           tell it what hPanel or Hostinger support says (root only)
//   governor seed <core-seconds>    set the credit balance, for example when moving from another tool
//   governor exec [--wait <s>] -- <command>  run a command in user.slice once it accepts work
//   governor enroll-service <unit> | configure-docker  put services or Docker under the ceiling
//   governor check-hostinger        read VM details and CPU metrics once (read-only)
//   governor validate-config        check /etc/governor/config.json
//   governor fallback [--print]     apply fallback as root, or print the configured quota
//   governor version
import {
  configuredFallbackPercent,
  fallback,
  loadConfig,
  type PublicState,
  REQUESTS,
  runDaemon,
  STATE_FILE,
  TICK_SOCKET,
} from "./governor.ts";
import { requestTick, TickError } from "./control.ts";
import { creditLines, report } from "./report.ts";
import { explainCalibration, explainText } from "./explain.ts";
import { reportOptions } from "./resource.ts";
import { configureDocker, enrollService } from "./workloads.ts";
import { readClock } from "./sample.ts";
import { execOptions, scopeArgs, waitForAccepting } from "./exec.ts";
import { BROKER_CAPABILITY, CHECK_WINDOW_MS, cpuReadings, vm } from "./hostinger.ts";

export const VERSION = "0.3.0";
const STALE_MS = 5 * 60_000;
class UnsupportedStateSchema extends Error {
  constructor() {
    super("governor public state schema is unsupported; upgrade this reader");
  }
}

async function state(): Promise<PublicState | null> {
  try {
    const s = JSON.parse(await Deno.readTextFile(STATE_FILE)) as PublicState;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1) throw new UnsupportedStateSchema();
    const clock = await readClock();
    const age = s.uptime === null ? Infinity : clock.uptime - s.uptime;
    return s.bootId === clock.bootId && age >= 0 && age <= STALE_MS ? s : null;
  } catch (error) {
    if (error instanceof UnsupportedStateSchema) throw error;
    return null;
  }
}

async function ask(body: Record<string, unknown>) {
  if (Deno.uid() !== 0) {
    throw new Error(
      "governor limit, seed and calibrate --reset require root; consumers can read status",
    );
  }
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await Deno.writeTextFile(`${REQUESTS}/.${name}`, JSON.stringify(body), {
    mode: 0o644,
    createNew: true,
  });
  await Deno.chmod(`${REQUESTS}/.${name}`, 0o644);
  await Deno.rename(`${REQUESTS}/.${name}`, `${REQUESTS}/${name}`);
  console.log("sent; applies within one tick; run sudo governor tick to apply and wait now");
}

const usage = (): never => {
  console.error(
    "usage: governor run | tick | status [--json] | report [hours] [--format text|html|json] | check-hostinger | calibrate --explain [--json] | calibrate --reset | limit on|off | seed <core-seconds> | exec [--wait <seconds>] -- <command> | enroll-service <unit> | configure-docker | version",
  );
  Deno.exit(2);
};

const [cmd, ...args] = Deno.args;
try {
  switch (cmd) {
    case "run":
      await runDaemon();
      break;
    case "tick":
      if (args.length) usage();
      if (Deno.uid() !== 0) throw new TickError("root");
      await requestTick(TICK_SOCKET);
      console.log("tick complete; state written");
      break;
    case "calibrate":
      if (args.length === 1 && args[0] === "--reset") await ask({ action: "calibration-reset" });
      else if (
        args.includes("--explain") && new Set(args).size === args.length &&
        args.every((a) => a === "--explain" || a === "--json")
      ) {
        const result = await explainCalibration(await loadConfig());
        console.log(args.includes("--json") ? JSON.stringify(result) : explainText(result));
      } else usage();
      break;
    case "validate-config":
      await loadConfig();
      console.log("config valid");
      break;
    case "check-hostinger": {
      if (args.length === 1 && args[0] === "--help") {
        console.log(
          `governor check-hostinger: read VM details and CPU metrics; ${BROKER_CAPABILITY}`,
        );
        break;
      }
      if (args.length) usage();
      const h = (await loadConfig()).hostinger;
      if (!h?.vm_id) throw new Error("hostinger.vm_id is not configured");
      const details = await vm(h, h.vm_id);
      if (h.request_command && details.ipv4 === undefined) {
        console.error(
          "Hostinger broker omitted IPv4 addresses; upgrade the installed broker before using this check to verify the host's identity",
        );
      }
      const now = Date.now();
      const readings = await cpuReadings(h, h.vm_id, now - CHECK_WINDOW_MS, now);
      console.log(
        JSON.stringify({
          vm_id: h.vm_id,
          cpus: details.cpus,
          ipv4: details.ipv4 ?? [],
          cpu_samples: readings.length,
        }),
      );
      break;
    }
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
      if (args[0] === undefined || !Number.isFinite(Number(args[0])) || Number(args[0]) < 0) {
        usage();
      }
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
      if (!args.length) await fallback();
      else if (args.length === 1 && args[0] === "--print") {
        console.log(await configuredFallbackPercent());
      } else usage();
      break;
    case "version":
      console.log(VERSION);
      break;
    default:
      usage();
  }
} catch (error) {
  if (error instanceof TickError) {
    console.error(error.message);
    Deno.exit(1);
  }
  if (!(error instanceof UnsupportedStateSchema)) throw error;
  console.error(error.message);
  Deno.exit(3);
}
