import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  acceptProblems,
  type ArticleRecord,
  articleText,
  contradictions,
  extractFacts,
  fetchArticle,
  missingFacts,
  planMismatches,
  readRecord,
  record,
  report,
  Unreadable,
  unreadable,
} from "../tools/rules-watch.ts";
import { plan } from "../src/plans.ts";

// A stand-in for the help-center page: its structure and the sentences the facts come from, with
// filler text instead of the article's prose.
function page(o: {
  baseline?: number;
  updated?: string;
  modified?: string;
  faqLimit?: number;
  extra?: string;
} = {}) {
  const b = o.baseline ?? 60;
  const rows = [1, 2, 4, 8].map((v) => {
    const base = (v * b) / 100;
    const cap = Math.round(10_800 * (v - base)).toLocaleString("en-US");
    return `<tr><td>${v}</td><td>${base.toFixed(2)}</td><td>${cap}</td><td>3 hours</td></tr>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head>
<title>How CPU credits work on Hostinger VPS</title>
<meta property="article:modified_time" content="${o.modified ?? "2026-10-09T14:26:10+00:00"}" />
<script>window.dataLayer = ["<h1>CPU credits in a script</h1>"];</script>
<style>h1 { color: red }</style>
</head><body>
<header class="site"><nav><a href="/pricing">Pricing</a><a href="/vps">VPS hosting</a></nav>
<form class="search"><input name="q"><button>Search in all categories</button></form></header>
<main><article>
<header class="entry-header"><h1 class="title">How CPU credits work on <span>Hostinger VPS</span></h1>
<p class="lede">Filler lede about bursting and recovering.</p>
<p class="meta">${o.updated ?? "Updated 4 hours ago"}</p></header>
<!-- <p>The baseline is 99% on every plan.</p> -->
<p>Filler paragraph one explains the battery analogy in plain words, without numbers, and goes on
long enough to look like a real introduction to the topic at hand for the reader.</p>
<h2>How Hostinger calculates your CPU credit balance</h2>
<p>The baseline is ${b}% on every plan. Filler sentence after it.</p>
<table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody>
<tr><td><strong>Baseline</strong></td><td><strong>${b}% of the allocated CPU capacity</strong>. Filler.</td></tr>
<tr><td><strong>Capacity</strong></td><td>The maximum credit balance, calculated as <code>10,800 &times; (vCPUs &minus; baseline)</code>.</td></tr>
</tbody></table>
<pre><code>baseline = vCPUs &#215; 0.30

earned = baseline &times; interval_seconds</code></pre>
<table><thead><tr><th>Allocated vCPUs</th><th>Baseline in equivalent fully utilized vCPUs</th>
<th>Maximum balance in core-seconds</th><th>Approximate duration</th></tr></thead><tbody>
${rows}
</tbody></table>
<p>When credits run out, available CPU capacity is reduced to your plan&rsquo;s limit: 40% on KVM 1
and 30% on KVM 2, KVM 4 and KVM 8.</p>
<ol><li><strong>CPU demand must decrease.</strong> While limited, if the VPS is throttled in
<strong>33% or more of CPU scheduling periods</strong>, credit earning pauses.</li>
<li><strong>A reserve must be rebuilt.</strong> The limit is removed only when the balance reaches
<strong>20% of its maximum capacity</strong>.</li></ol>
<p>Filler paragraph two talks about troubleshooting with top and htop, pausing heavy jobs, and
checking the dashboard, again without any of the numbers the governor depends on.</p>
${o.extra ?? ""}
<h2>FAQ</h2>
<p><strong>How is the CPU credit limit different from the CPU use limit?</strong><br>
CPU credits are a burstable model, limiting you to ${
    o.faqLimit ?? 20
  }% capacity only when your credit
balance is empty. Filler about abuse prevention.</p>
<aside class="related">Related articles: CPU steal, CPU use limit</aside>
<h2>Did this article answer your question?</h2><button>Yes</button><button>No</button>
</article></main>
<footer><a href="/web-hosting">Web hosting</a> The baseline is 10% on every plan.</footer>
</body></html>`;
}

const live = async (o?: Parameters<typeof page>[0]) => {
  const article = articleText(page(o));
  return { article, rec: await record(article, new Date("2026-10-10T00:00:00Z")) };
};

Deno.test("article text keeps the article and drops scripts, comments, navigation and footer", () => {
  const { text, modified } = articleText(page());
  assertEquals(modified, "2026-10-09T14:26:10+00:00");
  const lines = text.split("\n");
  assertEquals(lines[0], "How CPU credits work on Hostinger VPS");
  assert(lines.includes("1 | 0.60 | 4,320 | 3 hours"));
  assert(lines.includes("8 | 4.80 | 34,560 | 3 hours"));
  assert(lines.includes("baseline = vCPUs \u00d7 0.30"));
  for (
    const gone of ["Pricing", "Search in all", "99%", "10%", "Related articles", "Yes", "script"]
  ) {
    assert(!text.includes(gone), `kept "${gone}"`);
  }
  assert(!/Updated/.test(text));
});

Deno.test("decoded HTML entities cannot reintroduce markup into article text", () => {
  const { text } = articleText(page({ extra: "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>" }));
  assert(!text.includes("<script"), text);
  assert(!/[<>]/.test(text), text);
});

Deno.test("the relative 'Updated' label and the modified timestamp do not count as changes", async () => {
  const a = await live();
  const b = await live({ updated: "Updated 6 days ago", modified: "2026-10-10T09:00:00+00:00" });
  assertEquals(b.rec.sha256, a.rec.sha256);
  assertEquals(report(a.rec, b.rec, b.article.text), undefined);
});

Deno.test("facts come from the sentences the governor depends on", () => {
  const { facts, quotes } = extractFacts(articleText(page()).text);
  assertEquals(facts.baselinePct, 60);
  assertEquals(facts.formulaShare, 0.3);
  assertEquals(facts.capacityFactor, 10_800);
  assertEquals(facts.table["8"], { baseline: 4.8, capacity: 34_560 });
  assertEquals(facts.limitPct, { "1": 40, "2": 30, "4": 30, "8": 30 });
  assertEquals(facts.recoveryPct, 20);
  assertEquals(facts.pausePct, 33);
  assertEquals(facts.baselineMentions, [60]);
  assertEquals(facts.limitMentions, [20, 40]);
  assertEquals(quotes.baselinePct, "The baseline is 60% on every plan.");
});

Deno.test("leftovers from older revisions are reported as contradictions", () => {
  const found = contradictions(extractFacts(articleText(page()).text).facts);
  assert(found.some((c) => c.includes("vCPUs \u00d7 0.3 (30%)")), found.join("\n"));
  assert(found.some((c) => c.includes("limits CPU to 20%")), found.join("\n"));
  const clean = contradictions(
    extractFacts(articleText(page({ faqLimit: 30 })).text.replace("0.30", "0.60")).facts,
  );
  assertEquals(clean, []);
});

Deno.test("src/plans.ts agrees with the current article and disagrees with a changed one", () => {
  assertEquals(planMismatches(extractFacts(articleText(page()).text).facts, plan), []);
  const changed = planMismatches(
    extractFacts(articleText(page({ baseline: 50 })).text).facts,
    plan,
  );
  assertEquals(changed, [
    "Baseline: article 50%, src/plans.ts 60%.",
    "KVM 1 capacity: article 5,400, src/plans.ts 4,320.",
    "KVM 2 capacity: article 10,800, src/plans.ts 8,640.",
    "KVM 4 capacity: article 21,600, src/plans.ts 17,280.",
    "KVM 8 capacity: article 43,200, src/plans.ts 34,560.",
  ]);
});

Deno.test("a rule change is reported with old and new numbers and the changed lines", async () => {
  const a = await live();
  const b = await live({ baseline: 50 });
  const r = report(a.rec, b.rec, b.article.text)!;
  assert(r.title.startsWith("Hostinger CPU credit rules changed: baseline"), r.title);
  assert(r.title.endsWith("(src/plans.ts disagrees)"), r.title);
  assert(r.body.includes("| Baseline | 60% | **50%** |"), r.body);
  assert(r.body.includes("> The baseline is 50% on every plan."), r.body);
  assert(!r.body.includes("> Filler paragraph one"), "quoted an unchanged line");
  assert(r.body.endsWith(`Fingerprint: ${r.fingerprint}`));
  assertEquals(r.fingerprint, b.rec.sha256.slice(0, 16));
});

Deno.test("rewording without new numbers is reported as such", async () => {
  const a = await live();
  const b = await live({ extra: "<p>A new filler paragraph with no rule in it.</p>" });
  const r = report(a.rec, b.rec, b.article.text)!;
  assertEquals(r.title, "Hostinger CPU credit article reworded; rule numbers unchanged");
  assert(r.body.includes("> A new filler paragraph with no rule in it."), r.body);
  assert(r.body.includes("(1 new, 0 reviewed lines gone or changed)"), r.body);
});

Deno.test("without a record the report asks for one and shows what it would record", async () => {
  const b = await live();
  const r = report(undefined, b.rec, b.article.text)!;
  assertEquals(r.title, "Record the reviewed Hostinger CPU credit rules");
  assert(r.body.includes("| Baseline | 60% |"), r.body);
  assert(r.body.includes("baselinePct: \u201cThe baseline is 60% on every plan.\u201d"), r.body);
  assert(r.body.includes('"sha256": "'), r.body);
  assert(!r.body.includes("Filler paragraph"), "copied article prose into the issue");
});

Deno.test("pages that are not the article are rejected instead of reported as changes", async () => {
  assertThrows(
    () => articleText("<html><body><h1>Just a moment...</h1></body></html>"),
    Unreadable,
  );
  const tiny = articleText("<h1>CPU credits</h1><p>baseline credit vCPU</p>");
  await assertRejects(() => record(tiny), Unreadable);
  const refused = (status: number) => () =>
    fetchArticle(undefined, 1, () => Promise.resolve(new Response("Just a moment...", { status })));
  const e = await assertRejects(refused(403), Unreadable);
  assertEquals(e.category, "http-403");
});

Deno.test("one kind of failure keeps one fingerprint whatever its details", () => {
  const a = unreadable(new Unreadable("not-article", "unexpected article length (900 characters)"));
  const b = unreadable(new Unreadable("not-article", "unexpected article length (950 characters)"));
  assertEquals(a.fingerprint, "unreadable-not-article");
  assertEquals(b.fingerprint, a.fingerprint);
  assert(b.body.includes("950 characters"));
});

// The fact sentences reworded beyond the extractor, with filler so the page still looks complete.
const reworded = () =>
  page({ extra: `<p>${"Filler about recovery and limits without numbers. ".repeat(20)}</p>` })
    .replace(/The baseline is 60% on every plan\./, "Every plan earns sixty percent.")
    .replace(/<code>10,800[^<]*<\/code>/, "ten thousand eight hundred seconds per spare vCPU")
    .replace(/<tr><td>\d<\/td><td>[\d.]+<\/td>[\s\S]*?<\/tr>/g, "")
    .replace(/40% on KVM 1[\s\S]*?KVM 8\./, "a smaller share on each plan.")
    .replace(/throttled in\s*<strong>33% or more/, "throttled in <strong>a third or more")
    .replace(/reaches\s*<strong>20%/, "is back at <strong>a fifth");

Deno.test("a record without the essential numbers cannot be accepted", async () => {
  const { rec } = await live();
  assertEquals(missingFacts(rec.facts), []);
  assertEquals(acceptProblems(rec), []);
  const bare = await record(articleText(reworded()));
  assertEquals(missingFacts(bare.facts), [
    "baseline",
    "capacity formula",
    "lift threshold",
    "earning-pause threshold",
    "table row for 1 vCPU",
    "table row for 2 vCPUs",
    "table row for 4 vCPUs",
    "table row for 8 vCPUs",
    "KVM 1 limit",
    "KVM 2 limit",
    "KVM 4 limit",
    "KVM 8 limit",
  ]);
  assertEquals(planMismatches(bare.facts), [], "nothing to compare is not agreement");
  assertEquals(acceptProblems(bare).length, 12);
});

Deno.test("a reworded article the extractor no longer reads is reported, not passed", async () => {
  const a = await live();
  const b = await record(articleText(reworded()));
  const r = report(a.rec, b, articleText(reworded()).text)!;
  assertEquals(
    r.title,
    "Hostinger CPU credit article changed " +
      "(watcher cannot find baseline, capacity formula, lift threshold and more)",
  );
  assert(r.body.includes("**The watcher cannot find these numbers in the live article**"), r.body);
  assert(r.body.includes("| Baseline | 60% | **not found** |"), r.body);
});

Deno.test("the guard covers the earning-pause threshold as well as plan parameters", async () => {
  const { rec } = await live();
  const paused = { ...rec.facts, pausePct: 50 };
  assertEquals(planMismatches(paused), [
    "Earning pause: article 50% of periods throttled, src/plans.ts 33%.",
  ]);
  assertEquals(acceptProblems({ ...rec, facts: paused }).length, 1);
});

Deno.test("heartbeat health distinguishes a readable article from a handled failure", async () => {
  const { article, rec } = await live();
  const good = report(undefined, rec, article.text)!;
  assert("healthy" in good && good.healthy === true);
  const failed = unreadable(new Unreadable("http-403", "HTTP 403"));
  assert("healthy" in failed && failed.healthy === false);
  const incomplete = await record(articleText(reworded()));
  const bad = report(rec, incomplete, articleText(reworded()).text)!;
  assert("healthy" in bad && bad.healthy === false);
});

Deno.test("unchanged article text cannot hide an extractor that lost an essential field", async () => {
  const { article, rec } = await live();
  const incomplete = { ...rec, facts: { ...rec.facts, pausePct: undefined } };
  const r = report(rec, incomplete, article.text);
  assert(r, "a matching hash hid missing facts");
  assert(r.body.includes("earning-pause threshold"));
});

const reviewed: ArticleRecord | undefined = await readRecord();
Deno.test({
  name: "the reviewed Hostinger record is complete and the code agrees with it",
  ignore: !reviewed,
  fn() {
    assertEquals(acceptProblems(reviewed!), []);
  },
});
