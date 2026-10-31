# Contributing

I built hostinger-governor for my own servers and share it as is. Issues and pull requests are
welcome, but I can't promise a reply or a merge. Small changes with tests and a clear reason have
the best chance.

By taking part, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Before you open an issue

- Search [existing issues](https://github.com/olmezsoy/hostinger-governor/issues?q=is%3Aissue),
  including closed ones.
- Report security problems privately. See the [security policy](SECURITY.md).
- Ask [Hostinger support](https://www.hostinger.com/support/) about your plan, bill or limits. The
  governor can't change them.
- Never paste a Hostinger API token, a credential file or an unedited `/etc/governor/config.json`.
  `governor status --json` and `governor report` include usernames, so remove any you don't want
  public.

The issue forms ask for what I need to reproduce a problem: `governor version`, your plan,
distribution and systemd version, and the relevant lines from `journalctl -u governor.service`.

## Set up a checkout

You need the Deno version in `.tool-versions`, which CI and release builds install, and Python 3 for
the installer tests. mise and asdf pick up `.tool-versions` on their own.

```sh
deno task check
python3 -m unittest discover -s test -p '*_test.py'
```

`deno task check` runs formatting, lint, type checks and the Deno tests. Every task except the rules
watcher's stops first under any other Deno, because formatting, type checks and permission flags
differ between versions. The test task needs unrestricted `--allow-run` because Deno requires it to
signal hook process groups. Tests keep writable data in ignored `test/.tmp` directories.

Run `deno task fmt` before you commit. It formats Markdown, YAML and the SVG diagram too, at a line
width of 100.

## Test on Linux without risk

`deno task smoke:linux <binary>` installs the governor system-wide. It writes sudoers rules and
systemd units and changes CPU quotas, so run it only on a machine you can throw away. CI runs it on
fresh GitHub-hosted runners.

Don't test against a production VPS, and never exhaust a production VPS's credits to see what
happens. Use the simulator instead.

## Change the control law

The credit estimate, the spend law and the limit heuristics live in `src/credits.ts` and
`src/governor.ts`; calibration lives in `src/calibration.ts`. The simulator drives the real
`Governor` class through simulated days against a model of Hostinger's rules:

```sh
deno task sim
deno task sim "hidden overhead" 5 --episodes
```

Include before and after numbers for the scenarios your change affects, such as `throttles`,
`paused_h` and `used_pct`. The top of `test/sim.ts` lists the model's assumptions. A good simulation
result is not proof of live Hostinger behavior.

The calibration studies S1 to S14 take about a minute each, so CI runs them apart from
`deno task check`. `deno task sim:check` fails when a study's outcome or limit count changes. If
your change means to change one, run `deno task sim:record` and update `docs/calibration-results.md`
to match.

CI runs three more gates apart from `deno task check`:

- `deno task sim:legacy` runs the legacy scenarios in `off` and fails when any recorded result
  changes, from credit limits and paused hours to the logged rules mismatches. If your change means
  to change one, run `deno task sim:legacy-record` and say why in the pull request.
- `deno task sim:jumps` runs meter jumps of 0.25 to 1 core over ten seeds, during an outage and with
  a broken feed, and fails when a run breaks the #13 criteria: the limits a jump may cost, the cores
  the final margin allows, the multiplier bound, and a broken feed tightening anything.
- `deno task bench:cpu` fails when the daemon uses more than 0.1% of one core averaged over a day,
  with 90 days of history. If you change calibration or history, include before and after numbers
  from it.

## Hostinger rule changes

The `Rules watch` workflow opens an issue labelled `hostinger-rules` when Hostinger's CPU credit
article changes. To accept a new version:

1. Update `src/plans.ts` if the rules changed.
2. Run `deno task rules:accept` and review `git diff rules/`.
3. Commit both.

The daemon never reads the article, by design. Rule changes reach servers as reviewed releases. See
[Rule changes](../README.md#rule-changes).

## Pull requests

- Keep each pull request to one change and explain the problem it solves.
- Add or update tests, and say how you tested. Mention anything you ran on a real or disposable
  Linux machine.
- Update the README and `docs/` when behavior changes. The diagram in `docs/how-it-works.svg`
  repeats numbers from the code, such as the 30-second pass, the spending floors (20% in `off` and
  `shadow`, 5% to start in `apply`) and the probe and lift test timings. Update it when they change.
  If you change `src/credits.ts` or `src/plans.ts`, run
  `deno run --allow-read=src tools/diagram-curves.ts` and copy the new chart points into the SVG.
- Leave `CHANGELOG.md` and the version number to me. I write both when I cut a release.

## Releases

These steps are for the maintainer.

1. Add a section to `CHANGELOG.md` and set `VERSION` in `src/main.ts`.
2. Merge to `main`.
3. Tag the merge commit `v<version>` and push the tag.

The `Release` workflow checks that the tag matches `governor version`, builds the x86_64 and ARM64
binaries, runs the Linux smoke test and publishes the release with `SHA256SUMS`.

## License

Contributions are released under the [MIT License](../LICENSE), like the rest of the project.
