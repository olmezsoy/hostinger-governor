# Security policy

## Supported versions

I fix security problems in the latest release only. To upgrade, run the installer again. It keeps
your configuration and credit estimate.

## Report a vulnerability

Report it privately through GitHub. Open the
[Security tab](https://github.com/olmezsoy/hostinger-governor/security), choose **Report a
vulnerability** and fill in the form. The
[advisory form](https://github.com/olmezsoy/hostinger-governor/security/advisories/new) is the
direct link. Your report stays private while I look into it. Please don't open a public issue,
discussion or pull request about a vulnerability.

Include as much of this as you can:

- the output of `governor version` and how you installed it;
- what an attacker needs, such as a local account, file access or a network position;
- the steps to reproduce it and the impact you saw.

Use placeholders for tokens and credentials. If you think a Hostinger API token has leaked, revoke
it in hPanel first. The governor can't revoke it for you.

## What to expect

This is a one-person project shared as is, so I can't promise response times. When I confirm a
problem, I fix it in a new release and publish a GitHub security advisory. The advisory credits you
unless you ask me not to.

## Scope

These boundaries matter most:

- **The daemon's privileges.** `governor.service` runs as the unprivileged `governor` user. Its only
  sudo rule runs `/usr/local/libexec/governor-cap`, which sets `CPUQuota` on `user.slice` and
  nothing else. Anything that lets the `governor` user or another local user do more is in scope.
- **Root-only controls.** `governor limit`, `seed` and `tick` must stay root-only. The daemon
  accepts request files in `/run/governor/requests` only when root owns them, and its control socket
  admits only root and the daemon's user.
- **Hostinger credentials.** The installer's token file is readable only by root and the `governor`
  group. The optional `request_command` broker keeps the token away from the daemon. See
  [Hostinger credential isolation](../docs/hostinger-credentials.md).
- **Hooks.** Hooks run as the `governor` user with public state on stdin. The daemon doesn't log
  their output.
- **Installer and releases.** The installer checks downloads against the release's `SHA256SUMS` and
  validates the sudoers fragment it writes.
- **The rules watch workflow.** It fetches Hostinger's article without the GitHub token, and writes
  issues in a separate step that never reads the article.

Out of scope:

- Hostinger's platform, hPanel and API. Report those to Hostinger.
- Throttling or billing the governor didn't predict. Open a regular issue for those.
- Attacks that already need root on the VPS.
- The raw token that `token_file` and `token_command` hand to the daemon. That trade-off is
  documented, and the broker exists to avoid it.
