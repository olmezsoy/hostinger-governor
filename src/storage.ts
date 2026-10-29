// State and history use the same atomic replacement and file-mode rules.
// A history snapshot syncs before the rename, and its directory after: a power cut that left it
// empty would cost 90 days, and one that lost the rename could pair the old snapshot with the new,
// empty log, losing the lines compaction folded into the snapshot.
// persist.json, rewritten every pass, doesn't: one left empty is set aside and recovered from
// history, and syncing it every pass would cost more than the rest of the write. History's log
// appends do sync, so after a power cut too persist.json is never ahead of history.
export async function writeText(path: string, text: string, mode: number, sync = false) {
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
    if (sync) await file.syncData();
  } finally {
    file.close();
  }
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
  if (sync) await syncDirectory(path);
}

export function parentDirectory(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash) || "/";
}

// A rename reaches the disk only once its directory is synced (fsync(2)).
async function syncDirectory(path: string) {
  const dir = await Deno.open(parentDirectory(path), { read: true });
  try {
    await dir.sync();
  } finally {
    dir.close();
  }
}

export function writeJson(path: string, value: unknown, mode: number) {
  return writeText(path, JSON.stringify(value), mode);
}

// Appends one log line and syncs it, so it is on disk before persist.json follows it. Lines append
// only when history changed, a few hundred times a day.
export async function appendText(path: string, text: string, mode: number) {
  const file = await Deno.open(path, { append: true, create: true, mode });
  try {
    const bytes = new TextEncoder().encode(text);
    for (let n = 0; n < bytes.length;) n += await file.write(bytes.subarray(n));
    await file.syncData();
  } finally {
    file.close();
  }
}
