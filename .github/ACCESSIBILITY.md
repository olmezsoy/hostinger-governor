# Accessibility

hostinger-governor runs on Linux servers and reports what it does as text. I want people to be able
to use it with a screen reader, a braille display, screen magnification or their own colors. This
page covers how the output works, known barriers and their workarounds, how to report a barrier, and
how I work on accessibility.

## How the output works

- The `governor` command prints plain text. It uses no color codes, spinners or animations, and it
  never prompts for input.
- `governor status --json`, `governor report --format json` and
  `governor calibrate --explain --json` print their information as JSON, so you can pick out only
  the fields you need. The text form of `calibrate --explain` shows the same status fields, one
  topic per line. [Resource reports](../docs/resource-reports.md) describes the report's fields. For
  example, this prints CPU history as one reading per line:

  ```sh
  governor report --format json | jq -r '.resources.cpu[] | "\(.at / 1000 | floor | todate)  CPU \(.v)%"'
  ```

- `governor report --format html` prints an HTML fragment with real tables.
  [`examples/resource-report.html`](../examples/resource-report.html) shows a saved JSON report as a
  page with headings and tables. It follows your system's light or dark setting and announces load
  errors to screen readers.

## Known limitations

- **Charts are rows of block characters.** `governor report` draws history as characters such as
  `▁▃▅█`, with `·` for missing samples. Screen readers read them as symbol names or skip them. The
  tables next to each chart give the average, peak or lowest value, and the JSON format has every
  data point.
- **Status circles rely on color.** The memory, swap, load and disk rows start with 🟢, 🟡 or 🔴.
  The circles differ only in color, and the text doesn't say which level each one means. The number
  in the same row carries the information.
- **Text tables are aligned with spaces.** Matching a value to its column can take a lot of moving
  around with a screen reader. Use the JSON or HTML format instead.
- **The HTML fragment has no section headings.** Section titles are bold paragraphs, so you can't
  jump between sections by heading. The example page uses real headings.
- **The broker setup wizard redraws the screen.** `tools/setup-hostinger-broker.sh` clears the
  terminal before each stage and uses color when the terminal supports it. It needs an interactive
  terminal for input and output, and it hides the token as you type. If the clearing gets in your
  way, follow the manual steps in [Hostinger credential isolation](../docs/hostinger-credentials.md)
  instead.
- **The README diagram is an image.** Its alt text summarizes it, and the list under it in
  [How it works](../README.md#how-it-works) describes each part in words.
- **Everything is in English.**

## Report a barrier

If something here is hard or impossible for you to use, please tell me. You don't need to tell me
about any disability.

[Open an accessibility issue](https://github.com/olmezsoy/hostinger-governor/issues/new?template=04-accessibility.yml)
and include as much of this as you can:

- what you were trying to do, and what happened instead;
- the command you ran and the output format;
- the output of `governor version`;
- your operating system, terminal or browser, and shell;
- any assistive technology you use, such as a screen reader or magnifier, and its version.

I add the `accessibility` label to these issues. If I know a workaround, I'll share it in the issue.
This is a one-person project, so I can't promise when a fix will ship.

## Supported environments

The governor runs on Linux with systemd and cgroup v2, such as Ubuntu 22.04 or later and Debian 12
or later. You read its output in whatever terminal you use to reach the server, usually over SSH.
Reports contain Unicode block characters and emoji, so your terminal and font need to show them.

I haven't tested the governor with specific screen readers or braille displays, and I make no
conformance claim. If you use one, I'd like to hear what works and what doesn't.

## How I work on accessibility

- Output should make sense as plain text, read from top to bottom.
- Color and symbols can add meaning but should never be the only way to show it.
- Every report format has a structured alternative in JSON.
- The governor itself never asks questions interactively. Scripts and assistive technology can use
  every command.

Contributors who change output should keep it plain text, keep the JSON in step with the text, and
show the output before and after the change in the pull request.

I maintain this page and update it when the output changes or someone reports a new barrier.
