"""Drive the setup wizard with dummy credentials in offline/CI tests only."""

import os
from pathlib import Path
import pty
import select
import subprocess
import termios
import time


def drive_wizard(
    script, destination, token, *, env, choice="y", timeout=10, on_confirmation=None
):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        ["/bin/bash", str(Path(script)), destination],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
    )
    transcript = b""
    deadline = time.monotonic() + timeout

    def read_available():
        nonlocal transcript
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                return False
            if not data:
                return False
            transcript += data
        return True

    def until(prompt):
        while prompt not in transcript:
            assert time.monotonic() < deadline, transcript.decode(errors="replace")
            assert read_available(), transcript.decode(errors="replace")
            assert process.poll() is None or prompt in transcript, transcript.decode(
                errors="replace"
            )

    try:
        until(b"Ready to start?")
        os.write(master, b"\n")
        until(b"Press Enter when the token is ready.")
        os.write(master, b"\n")
        until(b"Paste the token here; input is hidden:")
        while termios.tcgetattr(slave)[3] & termios.ECHO:
            assert time.monotonic() < deadline
            time.sleep(0.001)
        os.write(master, token.encode() + b"\n")
        until(
            (
                "Install the restricted broker and restart Governor on " + destination
            ).encode()
        )
        if on_confirmation:
            on_confirmation()
        os.write(master, choice.encode() + b"\n")
        while process.poll() is None:
            assert time.monotonic() < deadline, transcript.decode(errors="replace")
            read_available()
        # Closing our spare slave lets the master report EOF after all output is
        # drained, including anything written immediately before process exit.
        os.close(slave)
        slave = None
        while read_available():
            assert time.monotonic() < deadline, transcript.decode(errors="replace")
        assert process.wait(timeout=5) == 0, transcript.decode(errors="replace")
        assert (
            token.encode() not in transcript
        ), "Dummy secret appeared in wizard output."
        return transcript
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
        if slave is not None:
            os.close(slave)
