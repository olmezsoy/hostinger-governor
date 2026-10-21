// Each "tick\n" request runs one pass. The private Unix socket admits root and the daemon user.
// Timed and requested passes share this loop so accounting and state writes never overlap.
export class TickError extends Error {}

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
  const timer = setTimeout(() => close(conn), 1000);
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

export async function requestTick(path: string, timeoutMs = 120_000): Promise<void> {
  let conn: Deno.UnixConn;
  try {
    conn = await Deno.connect({ transport: "unix", path });
  } catch {
    throw new TickError("cannot reach governor; is the daemon running with tick support?");
  }
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    close(conn);
  }, timeoutMs);
  try {
    await writeAll(conn, TICK);
    const buffer = new Uint8Array(256);
    let reply = "";
    while (reply.length < 256) {
      const n = await conn.read(buffer);
      if (n === null) break;
      reply += new TextDecoder().decode(buffer.subarray(0, n));
    }
    if (reply !== "ok\n") {
      throw new TickError("governor tick failed; see journalctl -u governor.service");
    }
  } catch (error) {
    if (expired) throw new TickError("governor tick timed out; the pass may still finish");
    if (error instanceof TickError) throw error;
    throw new TickError("governor disconnected before confirming the tick");
  } finally {
    clearTimeout(timer);
    close(conn);
  }
}

export async function controlLoop(options: {
  path: string;
  tickMs: number;
  signal: AbortSignal;
  // Resolves only after both persisted and public state have been written. Logs failures itself.
  pass: () => Promise<void>;
}): Promise<void> {
  const { path, tickMs, signal, pass } = options;
  if (signal.aborted) return;
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
    listener = Deno.listen({ transport: "unix", path });
  } finally {
    Deno.umask(oldMask);
  }
  const stop = () => close(listener);
  signal.addEventListener("abort", stop, { once: true });
  let pending: Promise<Deno.UnixConn | null> | undefined;
  const accept = () =>
    listener.accept().catch((error) => {
      if (signal.aborted) return null;
      throw error;
    });
  try {
    let nextTimed = performance.now();
    while (!signal.aborted) {
      if (performance.now() >= nextTimed) {
        await pass().catch(() => {});
        // Preserve the existing interval measured from completion of each timed pass.
        nextTimed = performance.now() + tickMs;
        continue;
      }
      pending ??= accept();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const conn = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), Math.max(0, nextTimed - performance.now()));
        }),
      ]).finally(() => clearTimeout(timer));
      if (conn === undefined) continue;
      pending = undefined;
      if (conn === null) break;
      try {
        if (signal.aborted) break;
        if (!await isTick(conn)) continue;
        if (signal.aborted) break;
        let reply = "ok\n";
        try {
          await pass();
        } catch {
          reply = "failed\n";
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
    (await pending?.catch(() => null))?.close();
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}
