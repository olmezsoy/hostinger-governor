// Notifications run on a bounded FIFO, independently of CPU control. A hook and
// its ordinary subprocesses share a private Unix process group and one deadline.
export const HOOK_TIMEOUT_SECONDS = 60;
export const HOOK_QUEUE_LIMIT = 16;
const MAX_PAYLOAD = 1024 * 1024;
export function validateHookTimeout(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) {
    throw new Error("hook_timeout_seconds must be from 1 to 300");
  }
  return seconds;
}

type HookFailure = "timeout" | "cancelled" | "exit" | "input" | "cleanup";
export class HookError extends Error {
  constructor(readonly kind: HookFailure, code = 0) {
    super(
      {
        timeout: "timed out",
        cancelled: "cancelled during shutdown",
        exit: `exited ${code}`,
        input: "could not receive state",
        cleanup: "could not terminate process group",
      }[kind],
    );
  }
}

export function terminateHook(
  child: Pick<Deno.ChildProcess, "pid" | "kill">,
  signal: typeof Deno.kill = Deno.kill,
): boolean {
  let failed = false;
  try {
    signal(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) failed = true;
  }
  try {
    child.kill("SIGKILL");
  } catch (error) {
    // Deno's ChildProcess.kill uses TypeError for an already-reaped child. The
    // signal is fixed and valid here; PermissionDenied and other errors matter.
    if (!(error instanceof Deno.errors.NotFound) && !(error instanceof TypeError)) failed = true;
  }
  return !failed;
}

export type RunningHook = { done: Promise<void>; cancel: () => void };

export function startHook(
  command: string[],
  event: string,
  payload: string,
  timeoutMs: number,
): RunningHook {
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    detached: true,
    env: { GOVERNOR_EVENT: event },
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  let timedOut = false;
  let cancelled = false;
  let finished = false;
  let cleanupFailed = false;
  const killGroup = () => {
    // detached creates a new session before exec, so this group belongs only to
    // this hook. Do not signal the governor's own process group.
    if (!terminateHook(child)) {
      if (!cleanupFailed) console.error("hook cleanup failed: could not terminate process group");
      cleanupFailed = true;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  const input = (async () => {
    try {
      await writer.write(new TextEncoder().encode(payload));
      await writer.close();
      return true;
    } catch {
      return false;
    }
  })();
  const status = child.status.then((status) => {
    // A hook must wait for its children. Kill background children that would
    // otherwise keep stdin open after the hook's parent has exited.
    killGroup();
    return status;
  });
  const done = (async () => {
    try {
      const [written, out] = await Promise.all([input, status]);
      if (cleanupFailed) throw new HookError("cleanup");
      if (timedOut) throw new HookError("timeout");
      if (cancelled) throw new HookError("cancelled");
      if (!out.success) throw new HookError("exit", out.code);
      if (!written) throw new HookError("input");
    } finally {
      finished = true;
      clearTimeout(timer);
      await writer.abort().catch(() => {});
      writer.releaseLock();
    }
  })();
  return {
    done,
    cancel: () => {
      if (finished) return;
      cancelled = true;
      killGroup();
    },
  };
}

async function listHookFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile || entry.isSymlink) result.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return result.sort();
}

type HookIO = {
  listFiles: typeof listHookFiles;
  start: typeof startHook;
  log: (message: string) => void;
};

export class HookRunner {
  private pending: { event: string; payload: string }[] = [];
  private draining: Promise<void> | null = null;
  private active: RunningHook | null = null;
  private closed = false;
  private readonly io: HookIO;

  constructor(
    private readonly directory: string,
    private readonly timeoutSeconds = HOOK_TIMEOUT_SECONDS,
    io: Partial<HookIO> = {},
  ) {
    validateHookTimeout(timeoutSeconds);
    this.io = { listFiles: listHookFiles, start: startHook, log: console.log, ...io };
  }

  enqueue(event: string, state: unknown): boolean {
    if (this.closed) return false;
    if (this.pending.length >= HOOK_QUEUE_LIMIT) {
      this.io.log(`hook queue full; dropped ${event} notification`);
      return false;
    }
    // Capture state at the event, not when a delayed hook eventually starts.
    const payload = JSON.stringify(state);
    if (payload === undefined || new TextEncoder().encode(payload).length > MAX_PAYLOAD) {
      this.io.log(`hook payload too large; dropped ${event} notification`);
      return false;
    }
    this.pending.push({ event, payload });
    this.startDrain();
    return true;
  }

  private startDrain() {
    if (this.draining || this.closed) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.pending.length && !this.closed) this.startDrain();
    });
  }

  private async drain() {
    while (this.pending.length && !this.closed) {
      const notification = this.pending.shift()!;
      let entries: string[];
      try {
        entries = await this.io.listFiles(this.directory);
      } catch {
        this.io.log(`hooks (${notification.event}): cannot read hook directory`);
        continue;
      }
      for (const name of entries) {
        if (this.closed) return;
        try {
          this.active = this.io.start(
            [`${this.directory}/${name}`],
            notification.event,
            notification.payload,
            this.timeoutSeconds * 1000,
          );
          await this.active.done;
        } catch (error) {
          // No hook output is logged. Only our own fixed process outcomes are
          // useful here; stdout/stderr may contain unrelated credentials.
          this.io.log(
            `hook ${name} (${notification.event}) failed: ${
              error instanceof HookError ? error.message : "could not run"
            }`,
          );
        } finally {
          this.active = null;
        }
      }
    }
  }

  // Used in tests and orderly shutdown; the control loop never waits for idle.
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending = [];
    this.active?.cancel();
    await this.idle();
  }
}
