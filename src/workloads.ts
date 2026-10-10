// Root configures service placement; the cap helper remains restricted to user.slice.
export function serviceDropIn(unit: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(unit) || unit === "governor.service") {
    throw new Error("use a service unit name other than governor.service");
  }
  return `/etc/systemd/system/${unit}.d/50-governor.conf`;
}

export function governedDockerConfig(current: Record<string, unknown>): Record<string, unknown> {
  if (!current || Array.isArray(current) || typeof current !== "object") {
    throw new Error("Docker config must be an object");
  }
  const opts = current["exec-opts"] ?? [];
  if (!Array.isArray(opts) || opts.some((o) => typeof o !== "string")) {
    throw new Error("Docker exec-opts must be an array of strings");
  }
  return {
    ...current,
    "cgroup-parent": "user.slice",
    "exec-opts": [
      ...opts.filter((o) => !o.startsWith("native.cgroupdriver=")),
      "native.cgroupdriver=systemd",
    ],
  };
}

function requireRoot() {
  if (Deno.uid() !== 0) throw new Error("workload configuration requires root");
}

export async function enrollService(unit: string) {
  requireRoot();
  const path = serviceDropIn(unit);
  const out = await new Deno.Command("systemctl", {
    args: ["show", unit, "--property=LoadState", "--value"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success || new TextDecoder().decode(out.stdout).trim() !== "loaded") {
    throw new Error(`service ${unit} is not loaded`);
  }
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const content = "[Service]\nSlice=user.slice\n";
  try {
    await Deno.writeTextFile(path, content, { mode: 0o644, createNew: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists) || await Deno.readTextFile(path) !== content) {
      throw e;
    }
  }
  const reload = await new Deno.Command("systemctl", { args: ["daemon-reload"] }).output();
  if (!reload.success) throw new Error("systemd reload failed");
  console.log(`Configured ${unit}; restart it to move its processes under the governor.`);
}

export async function configureDocker() {
  requireRoot();
  const path = "/etc/docker/daemon.json";
  let original = "{}";
  try {
    original = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const next = governedDockerConfig(JSON.parse(original));
  await Deno.mkdir("/etc/docker", { recursive: true });
  const temp = await Deno.makeTempFile({
    dir: "/etc/docker",
    prefix: ".governor-",
    suffix: ".json",
  });
  try {
    await Deno.writeTextFile(temp, JSON.stringify(next, null, 2) + "\n");
    const validation = await new Deno.Command("dockerd", {
      args: ["--validate", "--config-file", temp],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!validation.success) {
      throw new Error("Docker rejected the proposed configuration; existing config was kept");
    }
    try {
      await Deno.writeTextFile(`${path}.governor-backup`, original, {
        mode: 0o600,
        createNew: true,
      });
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
    await Deno.chmod(temp, 0o644);
    await Deno.rename(temp, path);
  } finally {
    await Deno.remove(temp).catch(() => {});
  }
  console.log(
    "Docker defaults to user.slice. Restart Docker and recreate existing containers to apply it. Original config: /etc/docker/daemon.json.governor-backup",
  );
}
