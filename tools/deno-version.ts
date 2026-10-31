// Stops repository tasks under a Deno other than the one in .tool-versions, which CI and release
// builds install. Formatting, type checks and permission flags differ between Deno releases, so
// failures under another version are not CI's, and changing files to pass them breaks CI.
//
//   deno task deno:version
export const VERSION_FILE = ".tool-versions";

// Why this Deno cannot run the repository's tasks, or nothing when it can. The file is read the way
// setup-deno reads it in CI; it is undefined when missing.
export function versionProblem(running: string, toolVersions: string | undefined) {
  if (toolVersions === undefined) {
    return `There is no ${VERSION_FILE} naming the Deno version CI installs.`;
  }
  const pinned = toolVersions.match(/^deno\s+v?([^\s]+)$/m)?.[1];
  if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    return `${VERSION_FILE} must pin an exact Deno version, such as "deno 2.9.7".`;
  }
  if (running !== pinned) {
    return `This is Deno ${running}, but CI checks with Deno ${pinned} (${VERSION_FILE}). ` +
      `Run the task with Deno ${pinned} instead of changing files to pass under ${running}.`;
  }
}

if (import.meta.main) {
  let toolVersions: string | undefined;
  try {
    toolVersions = await Deno.readTextFile(VERSION_FILE);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const problem = versionProblem(Deno.version.deno, toolVersions);
  if (problem) {
    console.error(problem);
    Deno.exit(1);
  }
}
