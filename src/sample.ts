// What the governor reads from the machine: CPU counters, each login's share of the box, and the
// processes behind a hot moment.
export type Counters = { busy: number; steal: number; total: number };

// The first line of /proc/stat. Busy excludes idle, iowait and steal; guest time is already inside
// user and nice.
export function cpuCounters(stat: string): Counters {
  const f = stat.split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = f;
  const busy = user + nice + system + irq + softirq;
  return { busy, steal, total: busy + idle + iowait + steal };
}
export const readCounters = async () => cpuCounters(await Deno.readTextFile("/proc/stat"));
export const vcpusSeen = async () =>
  (await Deno.readTextFile("/proc/stat")).match(/^cpu\d+ /gm)?.length ?? 1;

export type Clock = { at: number; uptime: number; bootId: string };
export async function readClock(): Promise<Clock> {
  const [uptime, bootId] = await Promise.all([
    Deno.readTextFile("/proc/uptime"),
    Deno.readTextFile("/proc/sys/kernel/random/boot_id"),
  ]);
  const ms = Number(uptime.split(/\s+/)[0]) * 1000;
  if (!Number.isFinite(ms) || ms < 0 || !bootId.trim()) throw new Error("invalid kernel clock");
  return { at: Date.now(), uptime: ms, bootId: bootId.trim() };
}

// Steal as a share of demand over `ms`, measured directly.
export async function stealShare(ms: number): Promise<number> {
  return (await demandSample(ms)).steal;
}

export async function demandSample(ms: number) {
  const a = await readCounters();
  const start = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const b = await readCounters();
  const demand = b.busy - a.busy + b.steal - a.steal;
  const total = b.total - a.total;
  return {
    steal: demand > 0 ? (b.steal - a.steal) / demand : 0,
    busy: total > 0 ? (b.busy - a.busy) / total : 0,
    seconds: (performance.now() - start) / 1000,
  };
}

export type UsageSnapshot = { at: number; usage: Record<string, number>; total?: number };

// CPU microseconds per login, from the slice's per-user cgroups.
export async function userUsage(slice: string, at: number): Promise<UsageSnapshot> {
  const root = await Deno.readTextFile(`/sys/fs/cgroup/${slice}/cpu.stat`);
  const total = Number(root.match(/^usage_usec (\d+)/m)?.[1]);
  if (!Number.isFinite(total)) throw new Error("invalid slice CPU counter");
  const names = new Map(
    (await Deno.readTextFile("/etc/passwd")).split("\n").map((l) => l.split(":"))
      .map((f) => [f[2], f[0]]),
  );
  const usage: Record<string, number> = {};
  for await (const e of Deno.readDir(`/sys/fs/cgroup/${slice}`)) {
    const uid = e.name.match(/^user-(\d+)\.slice$/)?.[1];
    if (!uid) continue;
    const stat = await Deno.readTextFile(`/sys/fs/cgroup/${slice}/${e.name}/cpu.stat`)
      .catch(() => "");
    const usec = Number(stat.match(/^usage_usec (\d+)/m)?.[1]);
    if (usec) usage[names.get(uid) ?? uid] = usec;
  }
  return { at, usage, total };
}

// Each login's share of the whole box between two snapshots.
export function shares(
  prev: UsageSnapshot,
  next: UsageSnapshot,
  vcpus: number,
): Record<string, number> {
  const box = (next.at - prev.at) * 1000 * vcpus;
  return Object.fromEntries(
    Object.entries(next.usage).flatMap(([who, usec]) => {
      const share = (usec - (prev.usage[who] ?? usec)) / box;
      return share >= 0.005 ? [[who, Math.round(share * 1000) / 1000]] : [];
    }),
  );
}

// The processes behind a hot or stolen moment, appended to one file a day, kept a week.
export async function topSnapshot(dir: string, at: number) {
  const out = await new Deno.Command("top", {
    args: ["-b", "-c", "-n", "2", "-d", "1", "-o", "%CPU", "-w", "220"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const rows = (text.split(/^top - /m).at(-1) ?? "").split("\n").slice(6, 21).join("\n");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/${new Date(at).toISOString().slice(0, 10)}.log`,
    `## ${new Date(at).toISOString()}\n${rows}\n\n`,
    { append: true },
  );
  for await (const e of Deno.readDir(dir)) {
    const day = Date.parse(e.name.slice(0, 10));
    if (day && at - day > 7 * 86_400_000) await Deno.remove(`${dir}/${e.name}`);
  }
}
