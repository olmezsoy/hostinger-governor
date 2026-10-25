// Provider diagnostics run independently of CPU control. Transports own their request deadlines;
// shutdown waits for the active request so a privileged worker can finish its own cleanup.
import type { Reading } from "./credits.ts";
import type { Clock } from "./sample.ts";

const EVERY_MS = 30 * 60_000;
const RETRY_MS = 60_000;

type DiagnosticsIO = {
  readings: (at: number) => Promise<Reading[]>;
  clock: () => Promise<Pick<Clock, "uptime">>;
  publish: (readings: Reading[], at: number) => void;
  log: (error: unknown) => void;
};

export class DiagnosticsRunner {
  private pending?: Promise<void>;
  private closed = false;
  private generation = 0;
  private next = 0;
  private backoff = RETRY_MS;

  constructor(private readonly io: DiagnosticsIO) {}

  refresh({ at, uptime }: Pick<Clock, "at" | "uptime">) {
    if (this.closed || this.pending || uptime < this.next) return;
    this.next = uptime + EVERY_MS;
    this.pending = this.read(at, this.generation).catch((e) => this.io.log(e)).finally(() => {
      this.pending = undefined;
    });
  }

  reset() {
    this.generation++;
    this.next = 0;
    this.backoff = RETRY_MS;
  }

  async close() {
    this.closed = true;
    await this.pending;
  }

  private async read(at: number, generation: number) {
    // A reboot or counter reset discards the outcome without interrupting a privileged worker.
    const stale = () => generation !== this.generation;
    try {
      const readings = await this.io.readings(at);
      if (stale()) return;
      this.io.publish(readings, at);
      this.backoff = RETRY_MS;
    } catch (e) {
      if (stale()) return;
      const finished = await this.io.clock();
      if (stale()) return;
      this.next = finished.uptime + this.backoff;
      this.backoff = Math.min(this.backoff * 2, EVERY_MS);
      this.io.log(e);
    }
  }
}
