export const cliArguments = (
  mode: "connection" | "unsupported" | "tick-consumer",
  args: string[],
) => [
  "run",
  "--allow-env=GOVERNOR_CONFIG",
  `--allow-read=src,test/fixtures${mode === "connection" ? ",test/.tmp" : ""}`,
  ...(mode === "connection" ? ["--allow-run=/bin/bash"] : []),
  "--",
  "test/fixtures/cli-harness.ts",
  mode,
  ...args,
];
