// State files are replaced atomically, with a set file mode. persist.json is rewritten every pass
// and not synced: one a power cut left empty is set aside, and the estimate starts over from the
// readings.
export async function writeText(path: string, text: string, mode: number) {
  const tmp = `${path}.tmp`;
  // A leftover temporary file the daemon cannot open, such as one a root run left, would fail every
  // write. The directory is the daemon's, so it can unlink it whoever owns it.
  await Deno.remove(tmp).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  // createNew: a file or symlink planted after the removal fails the write instead of being followed.
  const file = await Deno.open(tmp, { write: true, createNew: true, mode });
  try {
    const bytes = new TextEncoder().encode(text);
    for (let n = 0; n < bytes.length;) n += await file.write(bytes.subarray(n));
  } finally {
    file.close();
  }
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
}

export function parentDirectory(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash) || "/";
}

export function writeJson(path: string, value: unknown, mode: number) {
  return writeText(path, JSON.stringify(value), mode);
}
