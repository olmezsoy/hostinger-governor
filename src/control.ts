// Each "tick\n" request runs one pass. The private Unix socket admits root and the daemon user.
// Timed and requested passes share this loop so accounting and state writes never overlap.
const TICK_ERRORS = {
  root: "governor tick requires root",
  unavailable: "cannot reach governor; is the daemon running with tick support?",
  failed: "governor tick failed; see journalctl -u governor.service",
  timeout: "governor tick timed out; the pass may still finish",
  disconnected: "governor disconnected before confirming the tick",
};

export class TickError extends Error {
  constructor(readonly code: keyof typeof TICK_ERRORS) {
    super(TICK_ERRORS[code]);
  }
}

const HANDSHAKE_TIMEOUT_MS = 1000;
const REPLY_TIMEOUT_MS = 120_000;
const MAX_REPLY_BYTES = 256;
const OK_REPLY = "ok\n";
const FAILED_REPLY = "failed\n";

const TICK = new TextEncoder().encode("tick\n");

async function writeAll(conn: Deno.UnixConn, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length;) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

function close(resource: { close(): void }) {
  try {
    resource.close();
  } catch (error) {
    if (!(error instanceof Deno.errors.BadResource)) throw error;
  }
}

async function isTick(conn: Deno.UnixConn): Promise<boolean> {
  const bytes = new Uint8Array(TICK.length);
  const timer = setTimeout(() => close(conn), HANDSHAKE_TIMEOUT_MS);
  try {
    for (let offset = 0; offset < bytes.length;) {
      const n = await conn.read(bytes.subarray(offset));
      if (n === null) return false;
      offset += n;
    }
    return bytes.every((byte, i) => byte === TICK[i]);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestTick(path: string, timeoutMs = REPLY_TIMEOUT_MS): Promise<void> {
  let conn: Deno.UnixConn;
  try {
    conn = await Deno.connect({ transport: "unix", path });
  } catch {
    throw new TickError("unavailable");
  }
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    close(conn);
  }, timeoutMs);
  try {
    await writeAll(conn, TICK);
    const buffer = new Uint8Array(MAX_REPLY_BYTES);
    let reply = "";
    while (reply.length < MAX_REPLY_BYTES) {
      const n = await conn.read(buffer);
      if (n === null) break;
      reply += new TextDecoder().decode(buffer.subarray(0, n));
    }
    if (reply !== OK_REPLY) {
      throw new TickError("failed");
    }
  } catch (error) {
    if (expired) throw new TickError("timeout");
    if (error instanceof TickError) throw error;
    throw new TickError("disconnected");
  } finally {
    clearTimeout(timer);
    close(conn);
  }
}

async function openSocket(
  path: string,
  listen: (path: string) => Deno.UnixListener,
): Promise<Deno.UnixListener> {
  // A crash can leave the socket behind in systemd's preserved runtime directory.
  try {
    const info = await Deno.lstat(path);
    if (!info.isSocket) throw new Error(`refusing to remove non-socket ${path}`);
    let existing: Deno.UnixConn | undefined;
    try {
      existing = await Deno.connect({ transport: "unix", path });
    } catch (error) {
      if (
        !(error instanceof Deno.errors.ConnectionRefused) &&
        !(error instanceof Deno.errors.NotFound)
      ) throw error;
    }
    if (existing) {
      close(existing);
      throw new Error("governor control socket is already in use");
    }
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  // Set permissions at creation, including when the service inherited a permissive umask.
  const oldMask = Deno.umask(0o177);
  let listener: Deno.UnixListener;
  try {
    listener = listen(path);
  } finally {
    Deno.umask(oldMask);
  }
  return listener;
}

type Accepted = { conn: Deno.UnixConn } | { error: unknown };

export async function controlLoop(options: {
  path: string;
  tickMs: number;
  signal: AbortSignal;
  // Resolves only after both persisted and public state have been written. Logs failures itself.
  pass: () => Promise<void>;
  onSocketError?: (error: unknown) => void;
  listen?: (path: string) => Deno.UnixListener;
}): Promise<void> {
  const { path, tickMs, signal, pass } = options;
  if (signal.aborted) return;
  const report = options.onSocketError ??
    ((error: unknown) =>
      console.error("on-demand ticks unavailable; timed control continues:", error));
  let listener: Deno.UnixListener | undefined;
  let ownsSocket = false;
  let pending: Promise<Accepted> | undefined;
  const stopped = Promise.withResolvers<null>();
  const stop = () => {
    if (listener) close(listener);
    stopped.resolve(null);
  };
  const removeSocket = async () => {
    if (!ownsSocket) return;
    ownsSocket = false;
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) report(error);
    });
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    try {
      listener = await openSocket(
        path,
        options.listen ?? ((path) => Deno.listen({ transport: "unix", path })),
      );
      ownsSocket = true;
    } catch (error) {
      report(error);
    }
    let nextTimed = performance.now();
    while (!signal.aborted) {
      if (performance.now() >= nextTimed) {
        await pass().catch(() => {});
        // Preserve the existing interval measured from completion of each timed pass.
        nextTimed = performance.now() + tickMs;
        continue;
      }
      if (listener) {
        const active = listener;
        pending ??= Promise.resolve().then(() => active.accept()).then(
          (conn): Accepted => ({ conn }),
          (error): Accepted => ({ error }),
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        ...(pending ? [pending] : []),
        stopped.promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), Math.max(0, nextTimed - performance.now()));
        }),
      ]).finally(() => clearTimeout(timer));
      if (result === undefined) continue;
      if (result === null) break;
      pending = undefined;
      if ("error" in result) {
        if (!signal.aborted) report(result.error);
        if (listener) close(listener);
        listener = undefined;
        await removeSocket();
        continue;
      }
      const { conn } = result;
      try {
        if (signal.aborted) break;
        if (!await isTick(conn)) continue;
        if (signal.aborted) break;
        let reply = OK_REPLY;
        try {
          await pass();
        } catch {
          reply = FAILED_REPLY;
        }
        await writeAll(conn, new TextEncoder().encode(reply));
      } catch {
        /* A disconnected caller cannot stop control or later requests. */
      } finally {
        close(conn);
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    const accepted = await pending;
    if (accepted && "conn" in accepted) close(accepted.conn);
    await removeSocket();
  }
}
