#!/usr/bin/env python3
"""Offline SSH stand-in for testing the wizard's prompts, not provisioning."""
import json
import os
import shlex
import sys

args = shlex.split(sys.argv[-1])
mode = args[args.index("bridge") + 1]
raw = sys.stdin.buffer.read()
assert bool(raw) == (mode != "preflight")
with open(os.environ["GOVERNOR_WIZARD_TEST_LOG"], "a") as log:
    log.write(mode + "\n")
if mode == "preflight":
    print("Governor supports the restricted Hostinger broker.")
else:
    print(
        json.dumps(
            {
                "vm_id": 12345,
                "cpus": 8,
                "cpu_samples": 3,
                "config_hash": "a" * 64,
                "balance": 34560,
                "accepting": True,
                "backup": "/fixture/protected-backup",
            }
        )
    )
