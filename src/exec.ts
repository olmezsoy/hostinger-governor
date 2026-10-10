// Batch work may wait for acceptance, but only up to a monotonic deadline.
export function execOptions(args: string[]): { command: string[]; waitSeconds: number } {
  let rest = args;
  let waitSeconds = 0;
  if (rest[0] === "--wait") {
    const raw = rest[1] ?? "";
    waitSeconds = Number(raw);
    if (
      !/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(waitSeconds) || waitSeconds > 86_400 ||
      rest[2] !== "--"
    ) throw new Error("exec --wait requires 0..86400 seconds and -- <command>");
    rest = rest.slice(2);
  }
  const command = rest[0] === "--" ? rest.slice(1) : rest;
  if (!command.length) throw new Error("exec requires a command");
  return { command, waitSeconds };
}

export const scopeArgs = (command: string[], root: boolean): string[] => [
  ...(root ? ["--slice=user.slice"] : ["--user"]),
  "--scope",
  "--quiet",
  "--property=CPUWeight=1",
  "--",
  ...command,
];

type WaitIO = {
  state: () => Promise<{ accepting: boolean } | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export async function waitForAccepting(waitSeconds: number, io: WaitIO): Promise<boolean> {
  const deadline = io.now() + waitSeconds * 1000;
  while (true) {
    const accepting = (await io.state())?.accepting;
    const now = io.now();
    if (accepting && (waitSeconds === 0 || now <= deadline)) return true;
    const remaining = deadline - now;
    if (remaining <= 0) return false;
    await io.sleep(Math.min(1000, remaining));
  }
}
