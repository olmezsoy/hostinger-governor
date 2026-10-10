// Turns a rules-watch report into one GitHub issue per version of the article: a new issue, or a
// comment on the open one. A version counts as reported only when its exact marker appears in an
// issue or comment written by the workflow or by someone with write access, so an outside comment
// cannot silence an alert. Closing an issue without accepting silences its versions.
export type Author = { login: string; association?: string };
export type Issue = {
  number: number;
  open: boolean;
  author: Author;
  body: string;
  comments: number;
};
export type Comment = { author: Author; body: string };
export type Report = { title: string; body: string; fingerprint: string };

export interface IssueApi {
  // Every issue with the label, open or closed, across all pages.
  issues(label: string): Promise<Issue[]>;
  // Every comment on an issue, across all pages.
  comments(issue: number): Promise<Comment[]>;
  canWrite(login: string): Promise<boolean>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  create(title: string, body: string, label: string): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
}

export const LABEL = "hostinger-rules";
export const BOT = "github-actions[bot]";
const ASSOCIATED = new Set(["MEMBER", "COLLABORATOR"]);
export async function trusted(a: Author, canWrite: IssueApi["canWrite"]): Promise<boolean> {
  if (a.login === BOT || a.association === "OWNER") return true;
  // An organization member or collaborator may have only read/triage access.
  return ASSOCIATED.has(a.association ?? "") && await canWrite(a.login);
}
export const marker = (fingerprint: string) => `<!-- rules-watch:${fingerprint} -->`;
const marked = (body: string, fingerprint: string) =>
  body.split(/\r?\n/).some((line) => line.trim() === marker(fingerprint));

export async function publish(api: IssueApi, r: Report, owner?: string): Promise<string> {
  if (!/^[\w-]+$/.test(r.fingerprint)) throw new Error(`bad fingerprint ${r.fingerprint}`);
  await api.ensureLabel(LABEL, "B60205", "Hostinger changed its CPU credit article");
  const permissions = new Map<string, Promise<boolean>>();
  const canWrite = (login: string) => {
    if (!permissions.has(login)) permissions.set(login, api.canWrite(login));
    return permissions.get(login)!;
  };
  const reported = async (author: Author, body: string) => {
    // Bot reports own their first line. Quoted page content must not introduce other markers.
    const found = author.login === BOT
      ? body.split(/\r?\n/, 1)[0].trim() === marker(r.fingerprint)
      : marked(body, r.fingerprint);
    return found && await trusted(author, canWrite);
  };
  const issues = await api.issues(LABEL);
  for (const i of issues) {
    if (await reported(i.author, i.body)) return `#${i.number} already reports ${r.fingerprint}`;
    if (!i.comments) continue;
    for (const c of await api.comments(i.number)) {
      if (await reported(c.author, c.body)) {
        return `#${i.number} already reports ${r.fingerprint}`;
      }
    }
  }
  const body = `${marker(r.fingerprint)}\n${r.body}${owner ? `\n\ncc @${owner}` : ""}`;
  const open = issues.filter((i) => i.open && i.author.login === BOT)
    .sort((a, b) => b.number - a.number)[0];
  if (open) {
    await api.comment(open.number, body);
    return `commented on #${open.number}`;
  }
  return `opened #${await api.create(r.title, body, LABEL)}`;
}

type GhIssue = {
  number: number;
  state: string;
  user: { login: string } | null;
  author_association?: string;
  body: string | null;
  comments: number;
  pull_request?: unknown;
};
type GhComment = {
  user: { login: string } | null;
  author_association?: string;
  body: string | null;
};

export function githubApi(repo: string, token: string, fetchFn: typeof fetch = fetch): IssueApi {
  const base = `https://api.github.com/repos/${repo}`;
  const call = (url: string, init: { method?: string; body?: unknown } = {}) =>
    fetchFn(url.startsWith("https://") ? url : `${base}${url}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "hostinger-governor-rules-watch",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const expect = async (r: Response, ...ok: number[]) => {
    if (r.ok || ok.includes(r.status)) return r;
    throw new Error(`GitHub answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
  const all = async <T>(path: string): Promise<T[]> => {
    const out: T[] = [];
    let pages = 0;
    for (let next: string | undefined = path; next; pages++) {
      if (pages === 100) throw new Error(`GitHub kept paginating ${path}`);
      const r = await expect(await call(next));
      out.push(...await r.json() as T[]);
      next = r.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return out;
  };
  const author = (x: { user: { login: string } | null; author_association?: string }) => ({
    login: x.user?.login ?? "",
    association: x.author_association,
  });
  return {
    issues: async (label) =>
      (await all<GhIssue>(`/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`))
        .filter((i) => !i.pull_request)
        .map((i) => ({
          number: i.number,
          open: i.state === "open",
          author: author(i),
          body: i.body ?? "",
          comments: i.comments,
        })),
    comments: async (issue) =>
      (await all<GhComment>(`/issues/${issue}/comments?per_page=100`))
        .map((c) => ({ author: author(c), body: c.body ?? "" })),
    canWrite: async (login) => {
      const r = await call(`/collaborators/${encodeURIComponent(login)}/permission`);
      if (r.status === 404) {
        await r.body?.cancel();
        return false;
      }
      const permission = (await (await expect(r)).json()).permission;
      // GitHub maps maintain to write and triage to read in this field.
      return permission === "write" || permission === "admin";
    },
    ensureLabel: async (name, color, description) => {
      // 422: the label exists already.
      await (await expect(
        await call("/labels", { method: "POST", body: { name, color, description } }),
        422,
      ))
        .body?.cancel();
    },
    create: async (title, body, label) => {
      const r = await expect(
        await call("/issues", { method: "POST", body: { title, body, labels: [label] } }),
      );
      return (await r.json()).number;
    },
    comment: async (issue, body) => {
      await (await expect(
        await call(`/issues/${issue}/comments`, { method: "POST", body: { body } }),
      ))
        .body?.cancel();
    },
  };
}
