// Percentages here are percentages of ONE vCPU, matching systemd CPUQuota.
import { MAX_VCPUS } from "./plans.ts";
export const DEFAULT_FALLBACK_CPU_PERCENT = 20;
export type FallbackConfig = { fallback_cpu_percent?: number };

export function fallbackCpuPercent(cfg: FallbackConfig, vcpus = MAX_VCPUS): number {
  const percent = cfg.fallback_cpu_percent ?? DEFAULT_FALLBACK_CPU_PERCENT;
  if (
    !Number.isSafeInteger(percent) || percent < DEFAULT_FALLBACK_CPU_PERCENT ||
    percent > 100 * vcpus
  ) {
    throw new Error(
      `fallback_cpu_percent must be an integer from ${DEFAULT_FALLBACK_CPU_PERCENT} to ${
        100 * vcpus
      }`,
    );
  }
  // null in a decoded configuration is invalid, not permission to use a default.
  if (cfg.fallback_cpu_percent === null) throw new Error("fallback_cpu_percent must be a number");
  return percent;
}
