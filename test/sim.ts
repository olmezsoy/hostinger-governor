// test/sim.ts: drives the real Governor class (src/governor.ts) through simulated days against a
// second-by-second model of Hostinger's credit rules. Only GovernorIO is faked, so whatever is in
// src/ is what gets tested.
//
//   deno task sim                        every scenario, seed 1
//   deno task sim "hidden overhead" 5    scenarios whose name starts with that, seeds 1-5
//   deno task sim "baseline 30%" 3 --episodes
//
// Host model (help center, revised 2026-10-09): earn the baseline in core-seconds every second, pay
// what the VM is billed (billMul x busy + billAdd), clamp to [0, capacity]; at 0, limit the VM to
// `limit` cores; while limited, any second in which 33% or more of scheduler periods are throttled
// earns nothing; lift at 20% of capacity. Demand inside each 100 ms period is uniform on
// [0.7, 1.3] x the second's demand. Assumptions worth remembering when reading the numbers:
//   - by default the model freezes a growing bank while pressing, matching the supplied review;
//     debitPaused scenarios instead subtract billed CPU while earning is suspended;
//   - the 33% rule is applied per second; if Hostinger measures it over longer windows, short
//     bursts against the limit (probes, lift tests) cost less than shown here;
//   - the governor always assumes the documented 60% baseline; baselineTrue changes the host only;
//   - workload: web services inside the slice (0.25 cores, a daily wave, noise, about three
//     2-6 core spikes a day), 0.2 cores of system load outside, and batch work that saturates
//     whatever the slice allows; neighbours steal a share of whatever runs, in episodes.
//
// Output per run: throttles (host-side limit events), throttled_h (hours limited), paused_h (hours
// limited AND pressing, so earning nothing: the real loss), used_pct (credits spent / earned),
// services_unmet_pct, slice_at_20pct_min, probes, false_limits (limits the governor entered that
// the host never imposed), burn_tests, margin, and with --episodes one line per host limit:
// lag_s (host limit to governor noticing), gov_min (minutes the governor knew), burns, avgCeil,
// paused_min split by cause (burn test, probe, other = pressing with no test running).
import { Governor, type GovernorIO } from "../src/governor.ts";
import { EARNING_PAUSE_SHARE, plan } from "../src/plans.ts";

type Sc = {
  name: string;
  days?: number;
  seed?: number;
  baselineTrue?: number; // the real baseline share (the governor always assumes 0.6)
  limitShare?: number; // the real limit, share of the vCPUs
  perVcpu?: boolean | "spread"; // per-vCPU limit; true = all demand on the fewest threads
  billMul?: number;
  debitPaused?: boolean; // also charge CPU while earning is paused, instead of freezing the bank
  billAdd?: number;
  nnPerDay?: number;
  nnMax?: number;
  overload?: [number, number, number]; // outside user.slice: start hour, hours, extra cores
  stop?: [number, number]; // VM stopped at hour h for d hours
  bankStart?: number; // real bank at start, share of real capacity
  servicesOutside?: boolean; // services left in system.slice instead of enrolled
  batchIdle?: boolean; // batch work in the slice at idle CPU weight
};

const VCPUS = 8;
const DAY = 86_400;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (lo: number, hi: number) => lo + (hi - lo) * next(),
    exp: (mean: number) => -Math.log(1 - next()) * mean,
    normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  };
}

function workload(sc: Sc, n: number) {
  const r = rng(sc.seed ?? 1);
  const services = new Float64Array(n); // web/containers inside user.slice
  const outside = new Float64Array(n); // system services left outside user.slice
  const nn = new Float64Array(n); // neighbour steal share
  for (let i = 0; i < n; i++) {
    services[i] = 0.25 + 0.12 * Math.sin(2 * Math.PI * (i / DAY - 0.3)) +
      Math.exp(-2.6 + 0.6 * r.normal());
    outside[i] = 0.2;
  }
  const episodes = (
    perDay: number,
    mean: number,
    lo: number,
    hi: number,
    f: (s: number, e: number) => void,
  ) => {
    let t = 0;
    while (perDay > 0) {
      t += r.exp(DAY / perDay);
      if (t >= n) break;
      const d = Math.min(Math.max(r.exp(mean), lo), hi);
      f(Math.floor(t), Math.min(n, Math.floor(t + d)));
    }
  };
  episodes(3, 600, 120, 3600, (s, e) => { // traffic spikes on the services
    const h = r.uniform(2, 6);
    for (let i = s; i < e; i++) services[i] += h;
  });
  episodes(sc.nnPerDay ?? 4, 900, 300, 1800, (s, e) => {
    const f = r.uniform(0.05, sc.nnMax ?? 0.25);
    for (let i = s; i < e; i++) nn[i] = Math.max(nn[i], Math.min(f * r.uniform(0.6, 1.4), 0.6));
  });
  if (sc.overload) {
    const [h, d, c] = sc.overload;
    for (let i = h * 3600; i < Math.min(n, (h + d) * 3600); i++) outside[i] += c;
  }
  return { services, outside, nn };
}

export function run(sc: Sc) {
  const days = sc.days ?? 7;
  const n = days * DAY;
  const w = workload(sc, n);
  const share = sc.baselineTrue ?? 0.6;
  const baseline = share * VCPUS;
  const capacity = 10_800 * (VCPUS - baseline);
  const recovered = 0.2 * capacity;
  const limitShare = sc.limitShare ?? 0.3;
  const mul = sc.billMul ?? 1.02, add = sc.billAdd ?? 0.04;

  const h = {
    i: 0, // seconds simulated (index into the workload)
    t: Date.parse("2026-10-12T00:00:00Z"),
    uptime: 600_000,
    bootId: "boot-0",
    busyT: 0,
    stealT: 0,
    totalT: 0,
    sliceUsec: 0,
    ceiling: 20 as number | null, // the boot drop-in's 20% until the daemon's first tick
    burners: [] as number[],
    bank: (sc.bankStart ?? 1) * capacity,
    limited: false,
    phase: "" as "" | "probe" | "burn",
    ep: null as null | Record<string, number>,
    eps: [] as Record<string, number>[],
    m: {
      events: 0,
      limitedS: 0,
      pausedS: 0,
      wasted: 0,
      billed: 0,
      earned: 0,
      svcWant: 0,
      svcGot: 0,
      batch: 0,
      lowCeilS: 0,
      minBank: Infinity,
      bankStart: 0,
    },
  };
  h.m.bankStart = h.bank;

  const gRef = { g: null as Governor | null };
  const stopAt = sc.stop ? sc.stop[0] * 3600 : -1;
  const step = () => {
    const i = Math.min(h.i, n - 1);
    h.burners = h.burners.filter((e) => e > h.t);
    const C = h.ceiling === null ? VCPUS : h.ceiling / 100;
    const S = sc.servicesOutside ? 0 : w.services[i], B = VCPUS; // batch work never runs out
    let sv = S, bv = B;
    if (S + B > C) {
      if (sc.batchIdle) [sv, bv] = [Math.min(S, C), C - Math.min(S, C)]; // batch at idle weight
      else { // equal CPU weights inside the slice
        const half = C / 2;
        if (S <= half) [sv, bv] = [S, C - S];
        else [sv, bv] = [half, half];
      }
    }
    const slice = sv + bv;
    const outside = w.outside[i] + h.burners.length + (sc.servicesOutside ? w.services[i] : 0);
    const want = Math.min(VCPUS, slice + outside);
    // the host: limit, then neighbours
    let busy = want, throttled = 0;
    if (h.limited && want > 0 && sc.perVcpu === "spread") {
      const L = limitShare;
      const sources = [slice, w.outside[i], ...h.burners.map(() => 1)].filter((x) => x > 0);
      let got = 0, refusedWeight = 0;
      for (const d of sources) {
        const threads = Math.max(1, Math.ceil(d - 1e-9)), per = d / threads;
        const lo = 0.7 * per, hi = 1.3 * per;
        let b = per, thr = 0;
        if (L <= lo) [b, thr] = [L, 1];
        else if (L < hi) {
          thr = (hi - L) / (hi - lo);
          b = (L * L - lo * lo) / (2 * (hi - lo)) + L * thr;
        }
        got += b * threads;
        refusedWeight += thr * d;
      }
      busy = Math.min(got, want);
      throttled = refusedWeight / sources.reduce((a, b) => a + b, 0);
    } else if (h.limited && want > 0) {
      const threads = sc.perVcpu ? Math.max(1, Math.ceil(want - 1e-9)) : 1;
      const per = want / threads, L = sc.perVcpu ? limitShare : limitShare * VCPUS;
      const lo = 0.7 * per, hi = 1.3 * per;
      let b = per;
      if (L <= lo) [b, throttled] = [L, 1];
      else if (L < hi) {
        throttled = (hi - L) / (hi - lo);
        b = (L * L - lo * lo) / (2 * (hi - lo)) + L * throttled;
      }
      busy = b * threads;
    }
    busy *= 1 - w.nn[i];
    const steal = Math.max(0, want - busy);
    const bill = busy * mul + add;
    let delta = baseline - bill;
    if (h.limited && throttled >= EARNING_PAUSE_SHARE) {
      delta = sc.debitPaused ? -bill : Math.min(delta, 0);
      h.m.pausedS++;
      if (h.ep) {
        if (h.phase === "burn") h.ep.pausedBurn++;
        else if (h.phase === "probe") h.ep.pausedProbe++;
        else h.ep.pausedOther++;
      }
    }
    h.m.billed += bill;
    h.m.earned += baseline;
    let bank = h.bank + delta;
    if (bank > capacity) [h.m.wasted, bank] = [h.m.wasted + bank - capacity, capacity];
    if (bank <= 0) {
      bank = 0;
      if (!h.limited) {
        [h.limited, h.m.events] = [true, h.m.events + 1];
        h.ep = {
          start: h.i,
          dur: 0,
          pausedBurn: 0,
          pausedProbe: 0,
          pausedOther: 0,
          burns: 0,
          detectLag: -1,
          ceilSum: 0,
          ceilN: 0,
          govLimitS: 0,
        };
      }
    }
    if (h.limited) {
      h.m.limitedS++;
      if (h.ep) {
        h.ep.dur++;
        if (h.phase === "" && h.ceiling !== null) {
          h.ep.ceilSum += h.ceiling;
          h.ep.ceilN++;
        }
        if (gRef.g?.s.limit) h.ep.govLimitS++;
      }
      if (bank >= recovered) {
        h.limited = false;
        if (h.ep) {
          h.eps.push({ ...h.ep, avgCeil: h.ep.ceilN ? Math.round(h.ep.ceilSum / h.ep.ceilN) : -1 });
          h.ep = null;
        }
      }
    }
    h.bank = bank;
    h.m.minBank = Math.min(h.m.minBank, bank);
    // the guest's view
    const ratio = want > 0 ? busy / want : 0;
    h.busyT += busy * 100;
    h.stealT += steal * 100;
    h.totalT += VCPUS * 100;
    h.sliceUsec += slice * ratio * 1e6;
    h.m.svcWant += w.services[i];
    h.m.svcGot += (sc.servicesOutside ? w.services[i] : sv) * ratio;
    h.m.batch += bv * ratio;
    if (h.ceiling !== null && h.ceiling <= 20) h.m.lowCeilS++;
    h.i++;
    h.t += 1000;
    h.uptime += 1000;
  };
  const advance = (seconds: number) => {
    for (let k = 0; k < Math.round(seconds); k++) step();
  };
  const sample = (ms: number) => {
    const a = { busy: h.busyT, steal: h.stealT, total: h.totalT };
    advance(ms / 1000);
    const demand = h.busyT - a.busy + h.stealT - a.steal;
    return {
      steal: demand > 0 ? (h.stealT - a.steal) / demand : 0,
      busy: (h.busyT - a.busy) / (h.totalT - a.total),
      seconds: ms / 1000,
    };
  };
  const counts = { probes: 0, entries: 0, falseEntries: 0, burnTests: 0 };
  const io: GovernorIO = {
    clock: () => Promise.resolve({ at: h.t, uptime: h.uptime, bootId: h.bootId }),
    counters: () => Promise.resolve({ busy: h.busyT, steal: h.stealT, total: h.totalT }),
    usage: (_s, at) => Promise.resolve({ at, usage: {}, total: h.sliceUsec }),
    cap: (_s, pct) => {
      h.ceiling = pct;
      return Promise.resolve(true);
    },
    ceiling: () => Promise.resolve(h.ceiling),
    readings: () => Promise.resolve([]),
    hooks: () => Promise.resolve(),
    snapshot: () => Promise.resolve(),
    requestInfo: () => Promise.reject(new Error("unused")),
    requestBody: () => Promise.reject(new Error("unused")),
    pause: (ms) => {
      advance(ms / 1000);
      return Promise.resolve();
    },
    steal: (ms) => Promise.resolve(sample(ms).steal),
    demand: (ms) => Promise.resolve(sample(ms)),
    burner: () => {
      const end = h.t + 35_000;
      h.burners.push(end);
      return {
        get status() {
          if (h.t < end) advance((end - h.t) / 1000);
          return Promise.resolve({ success: false, code: 124, signal: null });
        },
        kill: () => {
          h.burners = h.burners.filter((e) => e !== end || h.t >= end);
        },
      } as unknown as Pick<Deno.ChildProcess, "status" | "kill">;
    },
  };

  const p = plan(VCPUS); // the governor's assumption: the documented 60%
  let g = new Governor({ tick_seconds: 30 }, p, undefined, io);
  gRef.g = g;
  const wrap = (gov: Governor) => {
    const probe = gov.probe.bind(gov);
    gov.probe = async (...a) => {
      counts.probes++;
      h.phase = "probe";
      try {
        return await probe(...a);
      } finally {
        h.phase = "";
      }
    };
    const enter = gov.enterLimit.bind(gov);
    gov.enterLimit = (now, learn) => {
      counts.entries++;
      if (!h.limited) counts.falseEntries++;
      if (h.ep && h.ep.detectLag < 0) h.ep.detectLag = h.i - h.ep.start;
      return enter(now, learn);
    };
    const gone = gov.limitGone.bind(gov);
    gov.limitGone = async () => {
      counts.burnTests++;
      if (h.ep) h.ep.burns++;
      h.phase = "burn";
      try {
        return await gone();
      } finally {
        h.phase = "";
      }
    };
  };
  wrap(g);
  let stopped = false;
  return (async () => {
    while (h.i < n) {
      if (!stopped && stopAt >= 0 && h.i >= stopAt) { // stop, then boot with a fresh kernel
        stopped = true;
        h.ceiling = 20;
        h.t += sc.stop![1] * 3600 * 1000;
        h.uptime = 20_000;
        h.bootId = "boot-1";
        h.busyT =
          h.stealT =
          h.totalT =
          h.sliceUsec =
            0;
        g = new Governor({ tick_seconds: 30 }, p, structuredClone(g.s), io);
        gRef.g = g;
        wrap(g);
      }
      await g.tick();
      advance(30);
    }
    const m = h.m;
    return {
      name: sc.name,
      throttles: m.events,
      throttled_h: +(m.limitedS / 3600).toFixed(2),
      paused_h: +(m.pausedS / 3600).toFixed(2),
      min_bank: Math.round(m.minBank),
      used_pct: +(100 * (m.billed - Math.max(0, m.bankStart - h.bank)) / m.earned).toFixed(1),
      wasted_core_h: +(m.wasted / 3600).toFixed(1),
      batch_core_h: +(m.batch / 3600).toFixed(1),
      services_unmet_pct: +(100 * (1 - m.svcGot / m.svcWant)).toFixed(2),
      slice_at_20pct_min: Math.round(m.lowCeilS / 60),
      probes: counts.probes,
      limit_entries: counts.entries,
      false_limits: counts.falseEntries,
      burn_tests: counts.burnTests,
      margin: g.s.margin,
      episodes: h.eps.map((e) => ({
        at_h: +(e.start / 3600).toFixed(1),
        min: Math.round(e.dur / 60),
        lag_s: e.detectLag,
        gov_min: Math.round(e.govLimitS / 60),
        burns: e.burns,
        avgCeil: e.avgCeil,
        paused_min: {
          burn: Math.round(e.pausedBurn / 60),
          probe: Math.round(e.pausedProbe / 60),
          other: Math.round(e.pausedOther / 60),
        },
      })),
    };
  })();
}

const HIDDEN = { billMul: 1.12, billAdd: 0.15 };
export const SCENARIOS: Sc[] = [
  { name: "normal" },
  { name: "noisy neighbours", nnPerDay: 10, nnMax: 0.4 },
  { name: "hidden overhead", ...HIDDEN },
  { name: "paused earning debits CPU, overhead", ...HIDDEN, debitPaused: true },
  { name: "hidden overhead, per-vCPU limit", ...HIDDEN, perVcpu: true },
  { name: "hidden overhead, per-vCPU, spread", ...HIDDEN, perVcpu: "spread" },
  { name: "real baseline 30% (article wrong)", baselineTrue: 0.3, limitShare: 0.2 },
  { name: "services outside slice +5 cores 6h", overload: [33, 6, 5] },
  { name: "stopped 3h at a low bank", stop: [30, 3], bankStart: 0.25 },
  { name: "normal, services not enrolled", servicesOutside: true },
  { name: "normal, batch at idle weight", batchIdle: true },
  {
    name: "paused earning debits CPU, baseline 30%",
    baselineTrue: 0.3,
    limitShare: 0.2,
    debitPaused: true,
  },
  { name: "baseline 30%, two weeks", baselineTrue: 0.3, limitShare: 0.2, days: 14 },
  { name: "hidden overhead + heavy neighbours", ...HIDDEN, nnPerDay: 12, nnMax: 0.45 },
  {
    name: "hidden overhead + heavy neighbours, per-vCPU spread",
    ...HIDDEN,
    nnPerDay: 12,
    nnMax: 0.45,
    perVcpu: "spread",
  },
];

if (import.meta.main) {
  const flags = Deno.args.filter((a) => a.startsWith("--"));
  const [only, seedArg] = Deno.args.filter((a) => !a.startsWith("--"));
  const seeds = Number(seedArg ?? 1);
  const log = console.log;
  for (const sc of SCENARIOS.filter((s) => !only || s.name.startsWith(only))) {
    for (let seed = 1; seed <= seeds; seed++) {
      console.log = () => {}; // the governor's own log lines
      const r = await run({ ...sc, seed });
      console.log = log;
      const { episodes, ...summary } = r;
      console.log(JSON.stringify({ ...summary, seed }));
      if (flags.includes("--episodes")) {
        for (const e of episodes) console.log("  " + JSON.stringify(e));
      }
    }
  }
}
