// Hostinger's public VPS API: the plan's vCPU count and the CPU readings its own accounting uses.
import type { Reading } from "./credits.ts";

const API = "https://developers.hostinger.com/api/vps/v1/virtual-machines";

export type TokenSource = { token_file?: string; token_command?: string[] };

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

export const vm = (src: TokenSource, id: number) =>
  get<{ plan?: string; cpus?: number }>(src, `/${id}`);

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
  src: TokenSource,
  id: number,
  from: number,
  now = Date.now(),
): Promise<Reading[]> {
  const body = await get<{ cpu_usage?: { unit?: string; usage?: Record<string, number> } }>(
    src,
    `/${id}/metrics?date_from=${new Date(from).toISOString()}&date_to=${
      new Date(now).toISOString()
    }`,
  );
  return parseReadings(body, from, now);
}
