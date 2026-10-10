# Resource reports

The governor exposes a read-only resource report. It does not send messages or register commands.
Use the included layout as a starting point, or build your own from the JSON data.

```sh
governor report                         # Text tables and charts, last 12 hours
governor report 24 --format html        # HTML fragment with tables and charts
governor report --format json           # Structured data and the default presentation
```

History windows range from 1 to 72 hours. Text is the default. The report reads public governor
state, sysstat history and local resource counters. It needs no root privileges, additional runtime,
bot token or Hostinger API token. Users still need read access to sysstat files for historical
charts. Missing or unreadable samples appear as gaps, not zero usage.

## Included layout

The report contains:

- the estimated bank, earning or spending rate, reserve, burst headroom and full-CPU runway;
- quota, baseline, billing margin, job admission, detected host limits and recovery;
- outside workload, per-user CPU, guest and Hostinger API history, and steal;
- memory, swap, load and root-disk usage, with historical charts.

The heading is `Server vitals`, followed by the history window and configured timezone. No hostname
is included. CI queues and model-job counts are not part of the governor's data; add those in your
integration if your scheduler provides them.

The HTML output is a fragment with standard headings, tables and preformatted charts. It contains no
scripts, styles or platform-specific markup. Apply your own styles, or open the editable
[`examples/resource-report.html`](../examples/resource-report.html) template in a browser and load a
saved JSON report. The template is also included in release assets. The preview works locally,
without uploading the report anywhere:

```sh
governor report --format json > resource.json
```

The template is a viewer, not a server or live monitor. It displays the saved snapshot's time.
`src/resource.ts` holds the shared layout and calculations, so text, HTML and JSON use the same
figures. `src/report.ts` collects the machine readings.

## Connect your tools

Run the command from your existing bot, scheduled task or dashboard. Use JSON for Slack blocks or
other structured layouts, HTML where rich tables are supported, or text inside a monospace block. If
you want a `/resource` command, map that command to the report in your own dispatcher. The governor
does not consume Telegram updates, create Slack apps or ask for messaging credentials.

Validate any user-supplied history window and pass it as a separate process argument. Never insert
message text into a shell command. Restrict who can request reports and where they are published.
Reports contain usernames and resource figures, so a public endpoint or channel may disclose server
activity. No report contains the private governor config or API credentials.

## JSON interface

The document has `schema: 1` and these top-level fields:

| Field                   | Contents                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| `collectedAt`, `window` | Unix milliseconds and the requested history window                                |
| `timezone`              | The configured display timezone, or UTC if the governor is unavailable            |
| `governor`              | Fresh public governor state, or `null`; the same state exposed by `status --json` |
| `credits`               | Derived credit figures with `estimated: true`, or `null` without fresh state      |
| `resources`             | Live machine counters and historical series                                       |
| `sections`              | Ordered titles, notes, tables and chart strings for the included layout           |

`credits.rate` is credits per second and is `null` before the first CPU sample. `reserveEtaSeconds`
and `fullBankEtaSeconds` are `null` unless the observed rate is positive. `fullCpuRunwaySeconds`
spends only the surplus above the reserve and includes the billing margin.

Each history point is `{ "at": <Unix milliseconds>, "v": <value> }`. CPU, steal and swap values are
percentages. Memory history is free GiB, load history is the 1-minute load average. Live memory,
swap capacity and disk figures are GiB. `resources.load.current` contains the 1-, 5- and 15-minute
averages. Missing history is an empty array. Do not substitute zero for missing data.

Each section can have `title`, `note`, `chart` and `table`. Tables have `headers` and `rows`, with
all cells already formatted as strings. This lets an integration reuse the presentation without
reimplementing credit calculations. Use the numeric fields if you want different units or layout.
Treat strings as text and escape them when constructing HTML or messaging markup.

## Estimate and freshness

The bank is a conservative guest-side estimate, not a balance fetched from hPanel. A reboot,
untrusted old state, or a changed plan can reset that estimate while the real bank still has
credits. `Estimate rebuilding` explains that state. Reaching the local reserve clears the notice.
Rebuilding alone does not pause jobs, and ordinary spending below the reserve does not restore the
notice.

Runway stops at the reserve rather than promising the entire estimated bank can be spent. Refill
ETAs assume the measured rate continues. A detected host limit and paused work are shown separately.
Hostinger API history is diagnostic and never raises the estimate.

The command refuses to display a stale bank. Without fresh governor state it still reports machine
resources, with `governor` and `credits` set to `null` and an unavailable notice. API history may be
missing even while guest accounting works. Collect and display the report's timestamps so readers
can distinguish a new report from a saved or delayed one.
