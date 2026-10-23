// Watches Hostinger's CPU credit article for changes. The repository keeps a record of the reviewed
// version (rules/hostinger-cpu-credits.json): a fingerprint of the article text, the numbers the
// code depends on, and the sentences they came from. It never stores the article itself. The daemon
// never reads the article: rule changes reach the governor through reviewed releases.
//
//   deno task rules:check                     compare the live article with the record
//   deno task rules:accept                    record the live article as reviewed (complete only)
//   ... check --report <dir>                  write title.txt, body.md and fingerprint.txt
//   ... publish --report <dir>                open or update the GitHub issue for that report
//   ... check|accept --html <file>            read a saved copy of the page (needs --allow-read)
import { EARNING_PAUSE_SHARE, type Plan, plan } from "../src/plans.ts";
import { githubApi, publish, type Report as IssueReport } from "./rules-issue.ts";

export const ARTICLE_URL =
  "https://www.hostinger.com/support/how-cpu-credits-work-on-hostinger-vps/";
export const RECORD_PATH = "rules/hostinger-cpu-credits.json";
const USER_AGENT =
  "hostinger-governor-rules-watch (+https://github.com/olmezsoy/hostinger-governor)";
// Plans whose numbers the article must state for a record to be complete.
export const PLAN_SIZES = [1, 2, 4, 8];

export type Facts = {
  // "The baseline is 60% on every plan."
  baselinePct?: number;
  // Every percentage the article calls a baseline, to expose leftovers from older revisions.
  baselineMentions: number[];
  // "baseline = vCPUs x 0.30"
  formulaShare?: number;
  // "10,800 x (vCPUs - baseline)"
  capacityFactor?: number;
  // Per-plan table, keyed by vCPUs: baseline in vCPUs and capacity in core-seconds.
  table: Record<string, { baseline: number; capacity: number }>;
  // "40% on KVM 1 and 30% on KVM 2, KVM 4 and KVM 8", keyed by vCPUs.
  limitPct: Record<string, number>;
  // Every "limited/reduced to N%" sentence, including ones that disagree with the per-plan limits.
  limitMentions: number[];
  // "reaches 20% of its maximum capacity"
  recoveryPct?: number;
  // "throttled in 33% or more of CPU scheduling periods"
  pausePct?: number;
};

export type ArticleRecord = {
  url: string;
  recorded: string;
  modified?: string;
  sha256: string;
  lines: string[];
  facts: Facts;
  quotes: Record<string, string>;
};

export type Article = { text: string; modified?: string };
export type Report = IssueReport & { healthy: boolean };

// A page the watcher cannot read. The category, not the message, identifies the failure, so one
// kind of failure is reported once however its details vary.
export class Unreadable extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  ndash: "\u2013",
  mdash: "\u2014",
  times: "\u00d7",
  minus: "\u2212",
  hellip: "\u2026",
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? m;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

// Markup that never carries article text, page furniture included.
const DROP =
  /<(script|style|noscript|svg|template|iframe|nav|aside|form|button|select)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
  /<\/?(?:p|div|section|article|main|header|footer|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption|dl|dt|dd|details|summary|hr)\b[^>]*>|<br\s*\/?>/gi;
// Relative edit ages can be stale in cached HTML; they do not identify a content revision.
const RELATIVE =
  /\bUpdated\s+(?:\d+|an?|one)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi;
const END = /Did this article answer your question|Was this article helpful|<\/article>|<footer\b/i;

const tidy = (line: string) =>
  line.replace(RELATIVE, " ").replace(/[\s\u200b]+/g, " ").replace(/\s*\|\s*/g, " | ").trim()
    .replace(/^\|\s*/, "").replace(/\s*\|$/, "").trim();

// The article's text from its page: from the heading to the feedback prompt, one block per line,
// table cells joined with " | ".
export function articleText(html: string): Article {
  const meta = (key: string) => {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      if (new RegExp(`(?:property|name)\\s*=\\s*["']${key}["']`, "i").test(tag)) {
        return decode(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "") || undefined;
      }
    }
  };
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP, "\n");
  const heading = s.search(/<h1\b[^>]*>(?:(?!<\/h1>)[\s\S])*?CPU credits/i);
  if (heading < 0) throw new Unreadable("no-heading", "the page has no CPU credits heading");
  s = s.slice(heading);
  const end = s.search(END);
  if (end > 0) s = s.slice(0, end);
  // Source line breaks are only whitespace, except inside <pre>.
  s = s.replace(/<pre\b[\s\S]*?<\/pre>/gi, (pre) => pre.replace(/\r?\n/g, "<br>"))
    .replace(/\s+/g, " ");
  const text = decode(
    s.replace(/<\/t[dh]\s*>/gi, " | ").replace(BLOCK, "\n").replace(/<[^>]*>/g, ""),
  ).replace(/[<>]/g, "").normalize("NFC").split("\n").map(tidy).filter(Boolean).join("\n");
  return {
    text,
    modified: meta("article:modified_time") ?? meta("og:updated_time"),
  };
}

export function validate(text: string) {
  const lower = text.toLowerCase();
  const missing = ["baseline", "credit", "vcpu"].filter((w) => !lower.includes(w));
  if (missing.length) {
    throw new Unreadable("not-article", `the article text has no ${missing.join(", ")}`);
  }
  if (text.length < 1000 || text.length > 200_000) {
    throw new Unreadable("not-article", `unexpected article length (${text.length} characters)`);
  }
}

const num = (s: string) => Number(s.replace(/,/g, ""));
const FIRST = {
  baselinePct: /\bbaseline is (\d+(?:\.\d+)?) ?%/i,
  formulaShare: /\bbaseline ?= ?vCPUs ?[\u00d7x*] ?(\d*\.\d+)/i,
  capacityFactor:
    /(\d{1,3}(?:,\d{3})+|\d{4,}) ?[\u00d7x*] ?\( ?vCPUs ?[\u2212\u2013-] ?baseline ?\)/i,
  recoveryPct: /\breaches (\d+(?:\.\d+)?) ?% of (?:its |the )?(?:maximum )?capacity/i,
  pausePct: /\bthrottled in (\d+(?:\.\d+)?) ?% or more of (?:CPU )?scheduling periods/i,
};
const BASELINE_MENTIONS =
  /(\d+(?:\.\d+)?) ?% baseline|\bbaseline (?:is |of )(\d+(?:\.\d+)?) ?%|\bBaseline \| (\d+(?:\.\d+)?) ?% of/gi;
const LIMIT_MENTIONS =
  /\b(?:limited|reduced|limiting(?: you| available capacity)?|capped) to (?:your plan[\u2019']s limit: )?(\d+(?:\.\d+)?) ?%/gi;
const LIMIT_PLANS = /(\d+(?:\.\d+)?) ?% on (KVM ?\d+(?:(?:, (?:and )?| and )KVM ?\d+)*)/gi;
const TABLE_ROW = /^(\d+) \| (\d+(?:\.\d+)?) \| (\d{1,3}(?:,\d{3})+|\d+) \| /;

const sentenceOf = (line: string, match: string) =>
  (line.split(/(?<=[.!?])\s+/).find((s) => s.includes(match)) ?? line).slice(0, 300);
const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

// The numbers the code depends on, with the sentence each came from.
export function extractFacts(text: string): { facts: Facts; quotes: Record<string, string> } {
  const lines = text.split("\n");
  const quotes: Record<string, string> = {};
  const first = (key: keyof typeof FIRST) => {
    for (const line of lines) {
      const m = line.match(FIRST[key]);
      if (m) {
        quotes[key] = sentenceOf(line, m[0]);
        return num(m[1]);
      }
    }
  };
  const facts: Facts = {
    baselinePct: first("baselinePct"),
    baselineMentions: [],
    formulaShare: first("formulaShare"),
    capacityFactor: first("capacityFactor"),
    table: {},
    limitPct: {},
    limitMentions: [],
    recoveryPct: first("recoveryPct"),
    pausePct: first("pausePct"),
  };
  for (const line of lines) {
    for (const m of line.matchAll(BASELINE_MENTIONS)) {
      facts.baselineMentions.push(num(m[1] ?? m[2] ?? m[3]));
    }
    for (const m of line.matchAll(LIMIT_MENTIONS)) {
      facts.limitMentions.push(num(m[1]));
      quotes[`limit ${m[1]}%`] ??= sentenceOf(line, m[0]);
    }
    for (const m of line.matchAll(LIMIT_PLANS)) {
      for (const k of m[2].matchAll(/KVM ?(\d+)/gi)) facts.limitPct[k[1]] ??= num(m[1]);
      quotes.limitPct ??= sentenceOf(line, m[0]);
    }
    const row = line.match(TABLE_ROW);
    if (row) facts.table[row[1]] ??= { baseline: num(row[2]), capacity: num(row[3]) };
  }
  facts.baselineMentions = sorted(facts.baselineMentions);
  facts.limitMentions = sorted(facts.limitMentions);
  return { facts, quotes };
}

// Essential numbers the watcher could not find. A record missing any of them cannot be accepted:
// the guard would have nothing to compare.
export function missingFacts(f: Facts): string[] {
  const out: string[] = [];
  if (f.baselinePct === undefined) out.push("baseline");
  if (f.capacityFactor === undefined) out.push("capacity formula");
  if (f.recoveryPct === undefined) out.push("lift threshold");
  if (f.pausePct === undefined) out.push("earning-pause threshold");
  for (const v of PLAN_SIZES) {
    if (!f.table[String(v)]) out.push(`table row for ${v} vCPU${v === 1 ? "" : "s"}`);
  }
  for (const v of PLAN_SIZES) {
    if (f.limitPct[String(v)] === undefined) out.push(`KVM ${v} limit`);
  }
  return out;
}

const pct = (x: number) => `${+x.toFixed(2)}%`;
const vcpus = (v: string) => `${v} vCPU${v === "1" ? "" : "s"}`;

// Places where the article disagrees with itself.
export function contradictions(f: Facts): string[] {
  const out: string[] = [];
  if (f.baselinePct !== undefined) {
    for (const b of f.baselineMentions) {
      if (b !== f.baselinePct) {
        out.push(
          `A sentence mentions a ${pct(b)} baseline; the stated baseline is ${pct(f.baselinePct)}.`,
        );
      }
    }
    if (f.formulaShare !== undefined && Math.abs(f.formulaShare * 100 - f.baselinePct) > 1e-9) {
      out.push(
        `The earning formula uses vCPUs \u00d7 ${f.formulaShare} (${
          pct(f.formulaShare * 100)
        }), but the stated baseline is ${pct(f.baselinePct)}.`,
      );
    }
  }
  const limits = sorted(Object.values(f.limitPct));
  for (const l of f.limitMentions) {
    if (limits.length && !limits.includes(l)) {
      out.push(
        `A sentence limits CPU to ${pct(l)}; the per-plan limits are ${
          limits.map(pct).join(" and ")
        }.`,
      );
    }
  }
  for (const [v, row] of Object.entries(f.table)) {
    if (
      f.baselinePct !== undefined &&
      Math.abs(row.baseline - Number(v) * f.baselinePct / 100) > 0.005
    ) {
      out.push(
        `The table gives ${vcpus(v)} a baseline of ${row.baseline}, not ${pct(f.baselinePct)}.`,
      );
    }
    const expected = (f.capacityFactor ?? NaN) * (Number(v) - row.baseline);
    if (Number.isFinite(expected) && Math.abs(row.capacity - expected) > 0.5) {
      out.push(`The table gives ${vcpus(v)} a capacity of ${row.capacity}, not ${expected}.`);
    }
  }
  return out;
}

// Where the code disagrees with the article's numbers: the plan parameters the governor uses, and
// the earning-pause threshold the simulator models. Missing numbers are missingFacts' business.
export function planMismatches(
  f: Facts,
  planFor: (vcpus: number) => Plan = plan,
  pauseShare = EARNING_PAUSE_SHARE,
): string[] {
  const out: string[] = [];
  const n = (x: number) => (+x.toFixed(4)).toLocaleString("en-US");
  const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
  const share = 100 * planFor(8).baseline / 8;
  let baselineDiffers = false;
  if (f.baselinePct !== undefined && !near(share, f.baselinePct, 1e-6)) {
    baselineDiffers = true;
    out.push(`Baseline: article ${pct(f.baselinePct)}, src/plans.ts ${pct(share)}.`);
  }
  if (f.capacityFactor !== undefined) {
    const p = planFor(8);
    const factor = p.capacity / (p.vcpus - p.baseline);
    if (!near(factor, f.capacityFactor, 0.5)) {
      out.push(
        `Capacity: article ${n(f.capacityFactor)} \u00d7 (vCPUs \u2212 baseline), src/plans.ts ${
          n(factor)
        } \u00d7 (vCPUs \u2212 baseline).`,
      );
    }
  }
  if (f.pausePct !== undefined && !near(f.pausePct, 100 * pauseShare, 1e-6)) {
    out.push(
      `Earning pause: article ${pct(f.pausePct)} of periods throttled, src/plans.ts ${
        pct(100 * pauseShare)
      }.`,
    );
  }
  const sizes = sorted([...Object.keys(f.table), ...Object.keys(f.limitPct)].map(Number));
  for (const v of sizes) {
    const p = planFor(v);
    const row = f.table[String(v)];
    const limit = f.limitPct[String(v)];
    if (row && !baselineDiffers && !near(p.baseline, row.baseline, 0.005)) {
      out.push(
        `KVM ${v} baseline: article ${n(row.baseline)} vCPUs, src/plans.ts ${n(p.baseline)}.`,
      );
    }
    if (row && !near(p.capacity, row.capacity, 0.5)) {
      out.push(`KVM ${v} capacity: article ${n(row.capacity)}, src/plans.ts ${n(p.capacity)}.`);
    }
    if (limit !== undefined && !near(p.limit, (limit / 100) * v, 1e-6)) {
      out.push(`KVM ${v} limit: article ${pct(limit)}, src/plans.ts ${pct(100 * p.limit / v)}.`);
    }
    if (
      f.recoveryPct !== undefined && !near(p.recovered, (f.recoveryPct / 100) * p.capacity, 0.5)
    ) {
      out.push(
        `KVM ${v} lift: article ${pct(f.recoveryPct)} of capacity, src/plans.ts ${
          pct(100 * p.recovered / p.capacity)
        }.`,
      );
    }
  }
  return out;
}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export async function record(article: Article, at = new Date()): Promise<ArticleRecord> {
  validate(article.text);
  const { facts, quotes } = extractFacts(article.text);
  return {
    url: ARTICLE_URL,
    recorded: at.toISOString().slice(0, 10),
    ...(article.modified ? { modified: article.modified } : {}),
    sha256: await sha256(article.text),
    lines: await Promise.all(
      article.text.split("\n").map(async (l) => (await sha256(l)).slice(0, 12)),
    ),
    facts,
    quotes,
  };
}

// Why a record cannot be accepted, or nothing when it can.
export function acceptProblems(r: ArticleRecord, planFor: (vcpus: number) => Plan = plan) {
  const missing = missingFacts(r.facts);
  return [
    ...missing.map((m) => `the watcher cannot find the ${m}`),
    ...planMismatches(r.facts, planFor).map((m) => `src/plans.ts disagrees: ${m}`),
  ];
}

const FACT_ROWS: [name: string, key: string, show: (f: Facts) => string][] = [
  ["Baseline", "baseline", (f) => f.baselinePct === undefined ? "not found" : pct(f.baselinePct)],
  [
    "Capacity",
    "capacity",
    (f) =>
      f.capacityFactor === undefined
        ? "not found"
        : `${f.capacityFactor.toLocaleString("en-US")} \u00d7 (vCPUs \u2212 baseline)`,
  ],
  [
    "Limit at zero",
    "limit",
    (f) =>
      Object.entries(f.limitPct).map(([v, l]) => `KVM ${v}: ${pct(l)}`).join(", ") || "not found",
  ],
  [
    "Limit lifts at",
    "lift",
    (f) => f.recoveryPct === undefined ? "not found" : `${pct(f.recoveryPct)} of capacity`,
  ],
  [
    "Earning pauses at",
    "earning pause",
    (f) => f.pausePct === undefined ? "not found" : `${pct(f.pausePct)} of periods throttled`,
  ],
  [
    "Plan table (baseline vCPUs / capacity)",
    "plan table",
    (f) =>
      Object.entries(f.table).map(([v, r]) =>
        `${v}: ${r.baseline} / ${r.capacity.toLocaleString("en-US")}`
      ).join("; ") || "not found",
  ],
  [
    "All baseline mentions",
    "baseline mentions",
    (f) => f.baselineMentions.map(pct).join(", ") || "none",
  ],
  ["All limit mentions", "limit mentions", (f) => f.limitMentions.map(pct).join(", ") || "none"],
  [
    "Earning formula",
    "earning formula",
    (f) => f.formulaShare === undefined ? "not found" : `vCPUs \u00d7 ${f.formulaShare}`,
  ],
];

const DIAGNOSTIC = new Set(["baseline mentions", "limit mentions", "earning formula"]);
const cell = (s: string) => s.replace(/\|/g, "\\|");
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
const few = (xs: string[]) =>
  xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and more` : xs.join(", ");

// The issue to open when the live article differs from the reviewed record, or nothing when it
// matches. Changed lines are quoted from the live page; unchanged text is never repeated.
export function report(
  reviewed: ArticleRecord | undefined,
  live: ArticleRecord,
  text: string,
  mismatches: string[] = planMismatches(live.facts),
): Report | undefined {
  const missing = missingFacts(live.facts);
  if (reviewed?.sha256 === live.sha256 && !missing.length) return;
  const fingerprint = live.sha256.slice(0, 16);
  const rows = FACT_ROWS.map(([name, key, show]) => {
    const now = show(live.facts);
    const was = reviewed ? show(reviewed.facts) : undefined;
    return { name, key, now, was, changed: was !== undefined && was !== now };
  });
  // Only rule rows name a change; the mention and formula rows are there to expose contradictions.
  // A number the watcher can no longer find is listed as missing, not as a changed rule.
  const changed = rows.filter((r) => r.changed && r.now !== "not found" && !DIAGNOSTIC.has(r.key))
    .map((r) => r.key);
  const suffix = [
    missing.length ? `watcher cannot find ${few(missing)}` : "",
    mismatches.length ? "src/plans.ts disagrees" : "",
  ].filter(Boolean).join("; ");
  const title =
    (!reviewed
      ? "Record the reviewed Hostinger CPU credit rules"
      : changed.length
      ? `Hostinger CPU credit rules changed: ${changed.join(", ")}`
      : missing.length
      ? "Hostinger CPU credit article changed"
      : "Hostinger CPU credit article reworded; rule numbers unchanged") +
    (suffix ? ` (${suffix})` : "");

  const parts: string[] = [];
  if (reviewed) {
    parts.push(
      `The [CPU credit article](${ARTICLE_URL}) no longer matches the reviewed record in ` +
        "`rules/hostinger-cpu-credits.json`.",
      [
        "| | Reviewed | Live |",
        "|---|---|---|",
        `| Article modified | ${reviewed.modified ?? "unknown"} | ${live.modified ?? "unknown"} |`,
        ...rows.map((r) =>
          `| ${r.name} | ${cell(r.was ?? "")} | ${r.changed ? `**${cell(r.now)}**` : cell(r.now)} |`
        ),
      ].join("\n"),
    );
  } else {
    parts.push(
      `There is no reviewed record of the [CPU credit article](${ARTICLE_URL}) yet. This is what ` +
        "the watcher reads from the live page; check it against the article before accepting it.",
      [
        "| | Live |",
        "|---|---|",
        `| Article modified | ${live.modified ?? "unknown"} |`,
        ...rows.map((r) => `| ${r.name} | ${cell(r.now)} |`),
      ].join("\n"),
    );
  }
  if (missing.length) {
    parts.push(
      `**The watcher cannot find these numbers in the live article** (it may have been reworded; ` +
        `\`deno task rules:accept\` refuses until \`tools/rules-watch.ts\` reads them again):\n${
          bullets(missing)
        }`,
    );
  }
  if (mismatches.length) {
    parts.push(`**The code disagrees with the live article:**\n${bullets(mismatches)}`);
  }
  const contra = contradictions(live.facts);
  if (contra.length) parts.push(`**The live article contradicts itself:**\n${bullets(contra)}`);
  if (reviewed) {
    const known = new Set(reviewed.lines);
    const current = new Set(live.lines);
    const lines = text.split("\n");
    const fresh = lines.filter((_, i) => !known.has(live.lines[i]));
    const gone = reviewed.lines.filter((l) => !current.has(l)).length;
    const shown = fresh.slice(0, 15).map((l) =>
      `> ${l.length > 300 ? `${l.slice(0, 300)}\u2026` : l}`
    );
    parts.push(
      `**New or changed lines** (${fresh.length} new, ${gone} reviewed line${
        gone === 1 ? "" : "s"
      } gone or changed):\n\n${
        shown.join("\n>\n") || "_none: lines were only removed or reordered_"
      }${fresh.length > shown.length ? `\n\n_and ${fresh.length - shown.length} more_` : ""}`,
    );
  } else {
    const quoted = Object.entries(live.quotes).map(([k, q]) => `- ${k}: \u201c${q}\u201d`);
    if (quoted.length) parts.push(`**Sentences the numbers come from:**\n${quoted.join("\n")}`);
  }
  parts.push(
    [
      "**To accept this version**",
      "1. Read the article. If the rules changed, update `src/plans.ts` and whatever depends on it.",
      "2. Run `deno task rules:accept`, review `git diff rules/`, and commit. It refuses an " +
      "incomplete record, and `deno task check` fails while the record and the code disagree.",
      "3. Close this issue. Closing it without accepting silences this version of the article.",
    ].join("\n"),
    `<details><summary>Record of the live version</summary>\n\n\`\`\`json\n${
      JSON.stringify(live, null, 2)
    }\n\`\`\`\n\n</details>`,
    `Fingerprint: ${fingerprint}`,
  );
  return { title, body: parts.join("\n\n"), fingerprint, healthy: !missing.length };
}

// The issue to open when the watcher cannot read the article at all.
export function unreadable(e: Unreadable): Report {
  const fingerprint = `unreadable-${e.category}`;
  return {
    title: "Hostinger rules watch cannot read the CPU credit article",
    healthy: false,
    body: [
      `The watcher could not read the [CPU credit article](${ARTICLE_URL}): ${e.message}.`,
      "Hostinger may have moved or redesigned the page, or blocked the request. Open the page; if it " +
      "moved or changed shape, update `tools/rules-watch.ts`.",
      `Fingerprint: ${fingerprint}`,
    ].join("\n\n"),
    fingerprint,
  };
}

export async function fetchArticle(
  url = ARTICLE_URL,
  attempts = 3,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 15_000 * i));
    try {
      // A unique query asks the CDN for a fresh copy; cached copies have lagged edits by hours.
      const u = new URL(url);
      u.searchParams.set("rules-watch", String(Date.now()));
      const r = await fetchFn(u, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
        },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await r.text();
      if (!r.ok) throw new Unreadable(`http-${r.status}`, `the server answered HTTP ${r.status}`);
      return body;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export async function readRecord(path = RECORD_PATH): Promise<ArticleRecord | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
}

async function writeReport(dir: string, r: Report) {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/title.txt`, r.title);
  await Deno.writeTextFile(`${dir}/body.md`, r.body);
  await Deno.writeTextFile(`${dir}/fingerprint.txt`, r.fingerprint);
  await writeHealth(dir, r.healthy);
}

async function writeHealth(dir: string, healthy: boolean) {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/health.txt`, healthy ? "ok\n" : "fail\n");
}

async function prepareReport(dir: string) {
  await writeHealth(dir, false);
  for (const file of ["title.txt", "body.md", "fingerprint.txt"]) {
    try {
      await Deno.remove(`${dir}/${file}`);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

async function readReport(dir: string): Promise<IssueReport | undefined> {
  try {
    const [title, body, fingerprint] = await Promise.all(
      ["title.txt", "body.md", "fingerprint.txt"].map((f) => Deno.readTextFile(`${dir}/${f}`)),
    );
    return { title, body, fingerprint: fingerprint.trim() };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
}

async function main(args: string[]) {
  const [mode, ...rest] = args;
  const option = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const reportDir = option("--report");
  if (mode === "publish") {
    // Runs apart from the fetch: it holds the GitHub token and never sees Hostinger's page.
    const r = reportDir ? await readReport(reportDir) : undefined;
    if (!r) {
      console.log("Nothing to report.");
      return 0;
    }
    const repo = Deno.env.get("GITHUB_REPOSITORY");
    const token = Deno.env.get("GITHUB_TOKEN");
    if (!repo || !token) {
      console.error("publish needs GITHUB_REPOSITORY and GITHUB_TOKEN");
      return 1;
    }
    console.log(await publish(githubApi(repo, token), r, Deno.env.get("GITHUB_REPOSITORY_OWNER")));
    return 0;
  }
  if (mode !== "check" && mode !== "accept") {
    console.error(
      "usage: rules-watch.ts check|accept [--html <file>] [--report <dir>]\n" +
        "       rules-watch.ts publish --report <dir>",
    );
    return 2;
  }
  const htmlFile = option("--html");
  if (reportDir && mode === "check") await prepareReport(reportDir);
  let article: Article;
  let live: ArticleRecord;
  try {
    const html = htmlFile ? await Deno.readTextFile(htmlFile) : await fetchArticle();
    article = articleText(html);
    live = await record(article);
  } catch (e) {
    // Network failures are transient and fail the run. A page that is not the article, or a
    // persistent HTTP refusal, becomes one issue per kind of failure.
    if (!(e instanceof Unreadable)) {
      console.error(`could not fetch the article: ${e instanceof Error ? e.message : e}`);
      return 1;
    }
    if (reportDir && mode === "check") {
      await writeReport(reportDir, unreadable(e));
      console.log(`reported: ${e.message}`);
      return 0;
    }
    console.error(`could not read the article: ${e.message}`);
    return 1;
  }
  const reviewed = await readRecord();
  if (mode === "accept") {
    const problems = acceptProblems(live);
    for (const c of contradictions(live.facts)) console.log(`article contradiction: ${c}`);
    if (problems.length) {
      for (const p of problems) console.error(`not accepted: ${p}`);
      console.error(
        "Fix src/plans.ts if the rules changed, or tools/rules-watch.ts if it no longer reads the " +
          "article, then run this again.",
      );
      return 1;
    }
    await Deno.mkdir("rules", { recursive: true });
    await Deno.writeTextFile(RECORD_PATH, `${JSON.stringify(live, null, 2)}\n`);
    console.log(
      reviewed?.sha256 === live.sha256
        ? `${RECORD_PATH} already matches the live article.`
        : `Recorded the live article in ${RECORD_PATH}. Review it with git diff before committing.`,
    );
    return 0;
  }
  const r = report(reviewed, live, article.text);
  if (!r) {
    if (reportDir) await writeHealth(reportDir, true);
    console.log("The live article matches the reviewed record.");
    return 0;
  }
  console.log(r.title);
  if (reportDir) await writeReport(reportDir, r);
  else console.log(`\n${r.body}`);
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
