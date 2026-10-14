// Hostinger's public VPS API: the plan's vCPU count and the CPU readings its own accounting uses.
import type { Reading } from "./credits.ts";

const API = "https://developers.hostinger.com/api/vps/v1/virtual-machines";

export type TokenSource = { token_file?: string; token_command?: string[] };
export type HostingerSource = TokenSource & { request_command?: string[] };
export type HostingerRequest =
  | { version: 1; operation: "vm"; vm_id: number }
  | { version: 1; operation: "metrics"; vm_id: number; from: number; to: number };

// The Python reference broker must match these protocol bounds. Both test suites
// check test/fixtures/hostinger-protocol.json to prevent cross-language drift.
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const MAX_INTERVAL_MS = 48 * 3_600_000;
export const MAX_VM_ID = Number.MAX_SAFE_INTEGER;
export const REQUEST_TIMEOUT_MS = 25_000;
export const BROKER_COOLDOWN_SECONDS = 60;
export const CHECK_WINDOW_MS = 12 * 3_600_000;
export const BROKER_CAPABILITY = "request_command v1 supported";
export const TEMPORARY_ERRORS = ["busy", "rate_limited"] as const;

export class HostingerBrokerUnavailable extends Error {
  constructor(readonly code: "busy" | "rate_limited") {
    super(
      code === "busy"
        ? "Hostinger broker is busy; retry shortly"
        : `Hostinger broker is cooling down after a failed request; retry in ${BROKER_COOLDOWN_SECONDS} seconds`,
    );
  }
}

export function validateSource(src: HostingerSource): void {
  for (const key of ["token_command", "request_command"] as const) {
    const command = src[key];
    if (
      command !== undefined &&
      (!Array.isArray(command) || !command.length || command.length > 32 ||
        command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0])
    ) throw new Error(`hostinger.${key} must be a nonempty command array`);
  }
  if (src.token_file !== undefined && (typeof src.token_file !== "string" || !src.token_file)) {
    throw new Error("hostinger.token_file must be a nonempty path");
  }
  if (src.request_command) {
    if (!src.request_command[0].startsWith("/")) {
      throw new Error("hostinger.request_command must use an absolute executable path");
    }
    if (src.token_file !== undefined || src.token_command !== undefined) {
      throw new Error("hostinger.request_command cannot be combined with a token source");
    }
  }
}

async function commandRequest(command: string[], request: HostingerRequest): Promise<unknown> {
  // The broker receives an operation, never a URL, header, or credential. Errors and stderr may
  // contain sensitive upstream text, so neither is included in the daemon's logs.
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    // The caller's directory may be private to another user, e.g. when an admin runs
    // check-hostinger as the governor user; the broker needs no working directory.
    cwd: "/",
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.getReader();
  const writer = child.stdin.getWriter();
  let expired = false;
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
    void reader.cancel().catch(() => {});
    void writer.abort().catch(() => {});
  };
  const timer = setTimeout(() => {
    expired = true;
    stop();
  }, REQUEST_TIMEOUT_MS);
  try {
    const input = (async () => {
      await writer.write(new TextEncoder().encode(JSON.stringify(request) + "\n"));
      await writer.close();
    })();
    const output = (async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE) throw new Error("response too large");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    })();
    const [, response, status] = await Promise.all([input, output, child.status]);
    if (
      !expired && status.success && response?.version === 1 && response.vm_id === request.vm_id &&
      response.data === undefined && TEMPORARY_ERRORS.includes(response.error)
    ) throw new HostingerBrokerUnavailable(response.error);
    if (
      expired || !status.success || !response || response.version !== 1 ||
      response.vm_id !== request.vm_id || !response.data || typeof response.data !== "object" ||
      Array.isArray(response.data)
    ) throw new Error("invalid broker response");
    return response.data;
  } catch (error) {
    stop();
    if (error instanceof HostingerBrokerUnavailable) throw error;
    throw new Error(
      expired ? "Hostinger request command timed out" : "Hostinger request command failed",
    );
  } finally {
    clearTimeout(timer);
    // Await termination so a failed request cannot leave a child or a pending status promise.
    await child.status;
    reader.releaseLock();
    writer.releaseLock();
  }
}

function validId(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid Hostinger VM ID");
}

// The token comes from a file only the governor can read, or from a command that prints it (a key
// manager, a secret store).
export async function token(src: TokenSource): Promise<string> {
  if (src.token_command?.length) {
    const out = await new Deno.Command(src.token_command[0], {
      args: src.token_command.slice(1),
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) throw new Error("token command failed");
    return new TextDecoder().decode(out.stdout).trim();
  }
  if (src.token_file) return (await Deno.readTextFile(src.token_file)).trim();
  throw new Error("no Hostinger token configured");
}

async function get<T>(src: TokenSource, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${await token(src)}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Hostinger API ${path.split("?")[0]}: HTTP ${res.status}`);
  return await res.json() as T;
}

export async function vm(
  src: HostingerSource,
  id: number,
): Promise<{ plan?: string; cpus?: number }> {
  validateSource(src);
  validId(id);
  const body = src.request_command
    ? await commandRequest(src.request_command, { version: 1, operation: "vm", vm_id: id })
    : await get<unknown>(src, `/${id}`);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid Hostinger VM response");
  }
  const value = body as { plan?: string; cpus?: number };
  if (value.cpus !== undefined && (!Number.isSafeInteger(value.cpus) || value.cpus <= 0)) {
    throw new Error("invalid Hostinger CPU count");
  }
  if (value.plan !== undefined && typeof value.plan !== "string") {
    throw new Error("invalid Hostinger plan");
  }
  return { cpus: value.cpus, plan: value.plan };
}

// CPU readings, in percent of the plan, about every 30 minutes.
export function parseReadings(
  body: { cpu_usage?: { unit?: string; usage?: Record<string, number> } },
  from: number,
  now: number,
): Reading[] {
  const metric = body.cpu_usage;
  if (!metric) return [];
  if (
    typeof metric.unit !== "string" ||
    !["%", "percent", "percentage"].includes(metric.unit.trim().toLowerCase())
  ) {
    throw new Error("unrecognized CPU metric unit");
  }
  const readings = Object.entries(metric.usage ?? {}).map(([t, v]) => ({
    at: Number(t) * 1000,
    v,
  }));
  if (
    readings.some((r) =>
      !Number.isFinite(r.at) || typeof r.v !== "number" || !Number.isFinite(r.v) || r.v < 0 ||
      r.v > 100 || r.at > now
    )
  ) {
    throw new Error("invalid CPU metric reading");
  }
  // Omit the newest bucket even if it looks old: completeness is not documented by this API.
  return readings.filter((r) => r.at >= from).sort((a, b) => a.at - b.at).slice(0, -1);
}

export async function cpuReadings(
  src: HostingerSource,
  id: number,
  from: number,
  now = Date.now(),
): Promise<Reading[]> {
  validateSource(src);
  validId(id);
  if (
    !Number.isSafeInteger(from) || !Number.isSafeInteger(now) || from < 0 || now <= from ||
    now - from > MAX_INTERVAL_MS
  ) throw new Error("invalid Hostinger metrics interval");
  const body = (src.request_command
    ? await commandRequest(src.request_command, {
      version: 1,
      operation: "metrics",
      vm_id: id,
      from,
      to: now,
    })
    : await get(
      src,
      `/${id}/metrics?date_from=${new Date(from).toISOString()}&date_to=${
        new Date(now).toISOString()
      }`,
    )) as { cpu_usage?: { unit?: string; usage?: Record<string, number> } };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid Hostinger metrics response");
  }
  return parseReadings(body, from, now);
}
