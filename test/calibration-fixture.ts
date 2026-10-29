// Shared inputs for the pure calibration tests: box A's reference fit, ten-minute slots and a
// confirmed limit record.
import { CALIBRATION, type MeterFit } from "../src/calibration.ts";
import type { LimitRecord, Slot } from "../src/history.ts";
import { plan } from "../src/plans.ts";

export const p = plan(8);
export const at = Date.parse("2026-10-12T00:00:00Z");
export const fit: MeterFit = {
  a: 1.0463,
  b: 0.0193,
  aHi: 1.05,
  sigma: [0.0214, 0.0119],
  pairs: 222,
  days: 10,
};
export const slot = (at: number, cores: number, flags = 0): Slot => ({
  at,
  seconds: 600,
  busy: cores * 600,
  steal: 0,
  managed: cores * 600,
  outside: 0,
  charged: (1.05 * cores + 0.04) * 600,
  flags,
});
export function record(mode: LimitRecord["mode"] = "off"): LimitRecord {
  return {
    onset: at,
    entry: at + 90_000,
    path: "evident",
    balance: 5000,
    used: 50000,
    settings: { ...CALIBRATION.start },
    gap: 0,
    mode,
    track: null,
    caps: [],
    confirmed: true,
    firstTest: "limited",
    learn: true,
  };
}
