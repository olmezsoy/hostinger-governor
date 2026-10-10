// governor: keeps a Hostinger VPS's CPU credits from running out while spending them on work.
//
//   governor run                    the daemon (systemd runs it as the governor user)
//   governor status [--json]        the state every consumer reads; exit 3 if the daemon is not running
//   governor report [hours]         vitals for people (default 12 hours)
//   governor limit on|off           tell it what hPanel or Hostinger support says (governor-ctl group)
//   governor seed <core-seconds>    set the credit balance, for example when moving from another tool
//   governor fallback               run by systemd as root when the daemon stops
//   governor version
import { fallback, type PublicState, REQUESTS, runDaemon, STATE_FILE } from "./governor.ts";
import { creditLines, report } from "./report.ts";

export const VERSION = "0.1.1";
const STALE_MS = 5 * 60_000;

async function state(): Promise<PublicState | null> {
  try {
    const s = JSON.parse(await Deno.readTextFile(STATE_FILE)) as PublicState;
    return Date.now() - s.updatedAt <= STALE_MS ? s : null;
  } catch {
    return null;
  }
}

async function ask(body: Record<string, unknown>) {
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await Deno.writeTextFile(`${REQUESTS}/.${name}`, JSON.stringify(body));
  await Deno.rename(`${REQUESTS}/.${name}`, `${REQUESTS}/${name}`);
  console.log("sent; the governor applies it within one tick");
}

const usage = () => {
  console.error(
    "usage: governor run | status [--json] | report [hours] | limit on|off | seed <core-seconds> | version",
  );
  Deno.exit(2);
};

const [cmd, ...args] = Deno.args;
switch (cmd) {
  case "run":
    await runDaemon();
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
    const s = await state();
    if (!s) {
      console.error("governor is not running (no fresh state)");
      Deno.exit(3);
    }
    console.log(await report(s, Math.min(72, Math.max(1, Number(args[0] ?? 12) || 12))));
    break;
  }
  case "limit":
    if (args[0] !== "on" && args[0] !== "off") usage();
    await ask({ action: `limit-${args[0]}` });
    break;
  case "seed":
    if (!(Number(args[0]) >= 0)) usage();
    await ask({ action: "seed", balance: Number(args[0]) });
    break;
  case "fallback":
    await fallback();
    break;
  case "version":
    console.log(VERSION);
    break;
  default:
    usage();
}
