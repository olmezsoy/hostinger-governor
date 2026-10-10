import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Author,
  BOT,
  type Comment,
  githubApi,
  type Issue,
  type IssueApi,
  marker,
  publish,
} from "../tools/rules-issue.ts";

const bot: Author = { login: BOT, association: "NONE" };
const owner: Author = { login: "olmezsoy", association: "OWNER" };
const stranger: Author = { login: "someone", association: "NONE" };

function memory(issues: (Issue & { thread?: Comment[] })[] = [], writers: string[] = []) {
  const log: string[] = [];
  const permissionChecks: string[] = [];
  const permissions = {
    canWrite: (login: string) => {
      permissionChecks.push(login);
      return Promise.resolve(writers.includes(login));
    },
  };
  const api: IssueApi = {
    ...permissions,
    issues: () => Promise.resolve(issues.map(({ thread: _, ...i }) => i)),
    comments: (n) => Promise.resolve(issues.find((i) => i.number === n)?.thread ?? []),
    ensureLabel: () => Promise.resolve(),
    create: (title, body) => {
      const number = issues.length + 1;
      issues.push({ number, open: true, author: bot, body, comments: 0, thread: [] });
      log.push(`create ${title}`);
      return Promise.resolve(number);
    },
    comment: (n, body) => {
      const issue = issues.find((i) => i.number === n)!;
      issue.thread = [...issue.thread ?? [], { author: bot, body }];
      issue.comments++;
      log.push(`comment #${n}`);
      return Promise.resolve();
    },
  };
  return { api, issues, log, permissionChecks };
}
const report = (fingerprint: string) => ({
  title: `Title ${fingerprint}`,
  body: "Body",
  fingerprint,
});

Deno.test("each version is reported once, as a new issue or on the open one", async () => {
  const m = memory();
  assertEquals(await publish(m.api, report("aaaa"), "olmezsoy"), "opened #1");
  assert(m.issues[0].body.startsWith(`${marker("aaaa")}\n`));
  assert(m.issues[0].body.endsWith("cc @olmezsoy"));
  assertEquals(await publish(m.api, report("aaaa")), "#1 already reports aaaa");
  assertEquals(await publish(m.api, report("bbbb")), "commented on #1");
  assertEquals(await publish(m.api, report("bbbb")), "#1 already reports bbbb");
  m.issues[0].open = false;
  assertEquals(await publish(m.api, report("bbbb")), "#1 already reports bbbb");
  assertEquals(await publish(m.api, report("cccc")), "opened #2");
  assertEquals(m.log, ["create Title aaaa", "comment #1", "create Title cccc"]);
});

Deno.test("a marker from someone without write access cannot silence an alert", async () => {
  const m = memory([{
    number: 1,
    open: true,
    author: bot,
    body: marker("aaaa"),
    comments: 1,
    thread: [{ author: stranger, body: marker("bbbb") }],
  }, {
    number: 2,
    open: true,
    author: stranger,
    body: marker("cccc"),
    comments: 0,
  }]);
  assertEquals(await publish(m.api, report("bbbb")), "commented on #1");
  assertEquals(await publish(m.api, report("cccc")), "commented on #1");
});

Deno.test("a maintainer can silence a version with the exact marker", async () => {
  const m = memory([{
    number: 1,
    open: false,
    author: bot,
    body: marker("aaaa"),
    comments: 2,
    thread: [
      { author: owner, body: `Not a real change.\n${marker("bbbb")}` },
      { author: owner, body: `${marker("cccc").replace("-->", "x -->")} cccc` },
    ],
  }]);
  assertEquals(await publish(m.api, report("bbbb")), "#1 already reports bbbb");
  assertEquals(await publish(m.api, report("cccc")), "opened #2", "a near-miss marker counted");
});

Deno.test("fingerprints that could break the marker are refused", async () => {
  await assertRejects(() => publish(memory().api, report("aa --> <b>")));
});

Deno.test("organization membership and collaborator association do not prove write access", async () => {
  for (const association of ["MEMBER", "COLLABORATOR"]) {
    const m = memory([{
      number: 1,
      open: true,
      author: bot,
      body: marker("old"),
      comments: 1,
      thread: [{ author: { login: "reader", association }, body: marker("new") }],
    }]);
    assertEquals(await publish(m.api, report("new")), "commented on #1", association);
    assertEquals(m.permissionChecks, ["reader"]);
  }
});

Deno.test("verified writers can dismiss a version and permission lookups are cached", async () => {
  const m = memory([{
    number: 1,
    open: false,
    author: bot,
    body: marker("old"),
    comments: 3,
    thread: [
      { author: { login: "reader", association: "MEMBER" }, body: marker("new") },
      { author: { login: "reader", association: "MEMBER" }, body: marker("new") },
      { author: { login: "writer", association: "COLLABORATOR" }, body: marker("new") },
    ],
  }], ["writer"]);
  assertEquals(await publish(m.api, report("new")), "#1 already reports new");
  assertEquals(m.permissionChecks, ["reader", "writer"]);
});

Deno.test("maintainer markers count even on an issue opened by an outsider", async () => {
  const m = memory([{
    number: 1,
    open: false,
    author: stranger,
    body: "An ordinary issue",
    comments: 1,
    thread: [{ author: owner, body: marker("new") }],
  }]);
  assertEquals(await publish(m.api, report("new")), "#1 already reports new");
});

Deno.test("article content quoted by the bot cannot introduce another trusted marker", async () => {
  const m = memory([{
    number: 1,
    open: false,
    author: bot,
    body: `${marker("old")}\nArticle content\n${marker("new")}`,
    comments: 0,
  }]);
  assertEquals(await publish(m.api, report("new")), "opened #2");
});

// GitHub's REST API as served to githubApi: three pages of issues, one of them a pull request.
function fakeGitHub() {
  const calls: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
  const issue = (number: number) => ({
    number,
    state: number % 2 ? "open" : "closed",
    user: { login: number === 205 ? BOT : "someone" },
    author_association: "NONE",
    body: number === 205 ? marker("found") : null,
    comments: number === 7 ? 101 : 0,
    ...(number === 3 ? { pull_request: {} } : {}),
  });
  const page = (items: unknown[], next?: string) =>
    new Response(JSON.stringify(items), {
      headers: next ? { link: `<${next}>; rel="next", <x>; rel="last"` } : {},
    });
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url,
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const base = "https://api.github.com/repos/o/r";
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => issue(from + i));
    if (url === `${base}/issues?page=2`) {
      return Promise.resolve(page(range(101, 200), `${base}/issues?page=3`));
    }
    if (method === "GET" && url.startsWith(`${base}/issues?labels=`)) {
      return Promise.resolve(page(range(1, 100), `${base}/issues?page=2`));
    }
    if (url === `${base}/issues?page=3`) return Promise.resolve(page(range(201, 250)));
    if (url.startsWith(`${base}/issues/7/comments`)) {
      const c = (i: number) => ({
        user: { login: "x" },
        author_association: "OWNER",
        body: `${i}`,
      });
      return Promise.resolve(
        url.includes("page=2") ? page([c(101)]) : page(
          Array.from({ length: 100 }, (_, i) => c(i + 1)),
          `${base}/issues/7/comments?page=2`,
        ),
      );
    }
    if (url === `${base}/labels`) return Promise.resolve(new Response("{}", { status: 422 }));
    const permissionUser = url.match(/\/collaborators\/([^/]+)\/permission$/)?.[1];
    if (permissionUser && permissionUser !== "missing") {
      const permission = permissionUser === "triage"
        ? "read"
        : permissionUser === "maintain"
        ? "write"
        : permissionUser;
      return Promise.resolve(new Response(JSON.stringify({ permission })));
    }
    if (url === `${base}/issues` && method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ number: 251 }), { status: 201 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { api: githubApi("o/r", "t0ken", fetchFn), calls };
}

Deno.test("the GitHub client reads every page and skips pull requests", async () => {
  const g = fakeGitHub();
  const issues = await g.api.issues("hostinger-rules");
  assertEquals(issues.length, 249);
  assert(!issues.some((i) => i.number === 3));
  const found = issues.find((i) => i.number === 205)!;
  assertEquals(found, { number: 205, open: true, author: bot, body: marker("found"), comments: 0 });
  assertEquals((await g.api.comments(7)).length, 101);
  assert(g.calls.every((c) => c.auth === "Bearer t0ken"));
  assert(g.calls[0].url.includes("labels=hostinger-rules&state=all&per_page=100"), g.calls[0].url);
});

Deno.test("the GitHub client tolerates an existing label and reports other failures", async () => {
  const g = fakeGitHub();
  await g.api.ensureLabel("hostinger-rules", "B60205", "d");
  assertEquals(await g.api.create("t", "b", "hostinger-rules"), 251);
  assertEquals(g.calls.at(-1)!.body, { title: "t", body: "b", labels: ["hostinger-rules"] });
  await assertRejects(() => g.api.comment(9, "b"));
});

Deno.test("publishing finds a version reported on page three", async () => {
  const g = fakeGitHub();
  assertEquals(await publish(g.api, report("found")), "#205 already reports found");
});

Deno.test("the GitHub client verifies write permission instead of author association", async () => {
  const g = fakeGitHub();
  for (const role of ["write", "maintain", "admin"]) assertEquals(await g.api.canWrite(role), true);
  for (const role of ["read", "triage", "none", "missing"]) {
    assertEquals(await g.api.canWrite(role), false);
  }
  assert(g.calls.every((c) => c.auth === "Bearer t0ken"));
});
