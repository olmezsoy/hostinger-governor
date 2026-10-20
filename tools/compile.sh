#!/usr/bin/env bash
set -euo pipefail
mode=${1:?pass jitless or jit-fixture}
shift
case $mode in
  jitless)
    if (($# == 0)); then set -- -o dist/governor; fi
    # Embed the flag: standalone binaries cannot accept runtime V8 flags.
    set -- --v8-flags=--jitless "$@"
    ;;
  jit-fixture)
    (($#)) || { echo "pass output flags for the smoke test's temporary fixture" >&2; exit 2; }
    ;;
  *) echo "expected jitless or jit-fixture" >&2; exit 2 ;;
esac
exec deno compile --allow-all "$@" src/main.ts
