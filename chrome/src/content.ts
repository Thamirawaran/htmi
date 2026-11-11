/**
 * HTMi on github.com, inside GitHub's own layout. An HTML file gets a
 * Preview view next to GitHub's Code and Blame, selected by default, the way
 * GitHub shows Markdown. An issue or pull request description written as one
 * fenced html block gets Preview and Code the same way. In "Files changed", an
 * HTML file gets Diff and Preview. The preview is the document as authored,
 * built by HTMi's own core in a sandboxed extension page (see viewer.ts);
 * selecting an element, a passage or part of an image prepares a comment that
 * goes into GitHub's own comment box, and the reviewer posts it there.
 *
 * Everything is read with the signed-in user's own session from github.com,
 * the same requests GitHub's pages make. The extension stores no token and
 * posts nothing by itself.
 */

declare const chrome: {
  runtime: { getURL(path: string): string };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
};

interface Description {
  repo: string;
  number: number;
  kind: "issue" | "pull";
  title: string;
  body: string;
  url: string;
  updatedAt: string;
}

type Page =
  | { type: "file"; repo: string; ref: string; path: string }
  | { type: "issue"; repo: string; number: number }
  | { type: "pull"; repo: string; number: number };

interface Target {
  label: string;
  /** How the review bar names it; the label by default. */
  name?: string;
  /** What the overlay builds. */
  load: () => Promise<{ request: Record<string, unknown>; files?: { repo: string; commit: string } }>;
  /** Where prepared comments go: a description of the box, or null when there is none on this page. */
  handoffTo: string | null;
}

const PENDING = "htmi:pending-comments";
const HTML_FILE = /\.html?$/i;

function currentPage(): Page | null {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if (parts[2] === "issues" && /^\d+$/.test(parts[3]!)) return { type: "issue", repo, number: Number(parts[3]) };
  if (parts[2] === "pull" && /^\d+$/.test(parts[3]!)) return { type: "pull", repo, number: Number(parts[3]) };
  if (parts[2] === "blob") {
    // "repo/docs/page.html at branch · owner/repo": GitHub resolves branches that contain slashes for us.
    const m = /^(.+?) at (.+?) · ([\w.-]+\/[\w.-]+)$/.exec(document.title);
    if (!m || m[3] !== repo) return null;
    const path = m[1]!.slice(m[1]!.indexOf("/") + 1);
    return HTML_FILE.test(path) ? { type: "file", repo, ref: m[2]!, path } : null;
  }
  return null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${url}`);
  return (await r.json()) as T;
}

/** The commit a ref (or a file at a ref) points at, as GitHub's own file pages ask for it. */
async function headCommit(repo: string, ref: string): Promise<string> {
  const j = await getJson<{ oid: string }>(`/${repo}/latest-commit/${ref}`);
  return j.oid;
}

async function rawFile(repo: string, commit: string, path: string): Promise<ArrayBuffer | null> {
  const r = await fetch(`/${repo}/raw/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`);
  return r.ok ? r.arrayBuffer() : null;
}

/** Decode the text of a textarea from raw HTML exactly; the browser's parser would turn CRLF into LF. */
function textareaText(html: string, name: string): string | null {
  const m = new RegExp(`<textarea[^>]*name="${name.replace(/[[\]]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</textarea>`).exec(
    html,
  );
  if (!m) return null;
  const text = m[1]!.replace(/^\r?\n/, "");
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "#39" || k === "apos") return "'";
    return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}

/** The exact description of this issue or pull request, as GitHub stores it. */
async function readDescription(page: Extract<Page, { type: "issue" | "pull" }>): Promise<Description> {
  const url = `https://github.com/${page.repo}/${page.type === "pull" ? "pull" : "issues"}/${page.number}`;
  // "Title by author · Pull Request #21 · owner/repo", or "Title · Issue #22 · owner/repo".
  const fromTab = /^(.*?)(?: by \S+)? · (?:Pull Request|Issue) #\d+ · /.exec(document.title)?.[1];
  const titleText = (
    document.querySelector("bdi.js-issue-title, [data-testid='issue-title']")?.textContent ??
    fromTab ??
    ""
  ).trim();
  // Issue pages carry the body in their page data, for every reader.
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/json"]')) {
    if (!script.textContent?.includes('"body"')) continue;
    let found: { body: string; title?: string } | null = null;
    try {
      (function walk(o: unknown): void {
        if (found || !o || typeof o !== "object") return;
        const r = o as Record<string, unknown>;
        if (r.number === page.number && typeof r.body === "string" && typeof r.title === "string") {
          found = { body: r.body, title: r.title };
          return;
        }
        for (const v of Object.values(r)) walk(v);
      })(JSON.parse(script.textContent));
    } catch {
      continue;
    }
    if (found) {
      const f = found as { body: string; title?: string };
      return {
        repo: page.repo,
        number: page.number,
        kind: page.type,
        title: f.title ?? titleText,
        body: f.body,
        url,
        updatedAt: "",
      };
    }
  }
  // Otherwise the edit form, which GitHub gives to people who can edit the description.
  const fragment = document.querySelector('include-fragment[src*="/edit_form"]')?.getAttribute("src");
  if (fragment) {
    const r = await fetch(fragment, { headers: { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" } });
    const body = r.ok
      ? textareaText(await r.text(), page.type === "pull" ? "pull_request[body]" : "issue[body]")
      : null;
    if (body !== null)
      return { repo: page.repo, number: page.number, kind: page.type, title: titleText, body, url, updatedAt: "" };
  }
  throw new Error(
    "GitHub did not include this description's source in the page. It does for issues, and for pull requests when you can edit them.",
  );
}

function fileTarget(repo: string, ref: string, path: string, handoffTo: string | null, commit?: string): Target {
  return {
    label: path,
    handoffTo,
    load: async () => {
      const head = commit ?? (await headCommit(repo, ref));
      const main = await rawFile(repo, head, path);
      if (!main) throw new Error(`${path} could not be read at ${head.slice(0, 7)}`);
      return { request: { kind: "file", path, commit: head, files: { [path]: main } }, files: { repo, commit: head } };
    },
  };
}

// ------------------------------------------------------------------ comment box

function commentBox(): HTMLTextAreaElement | null {
  return (
    document.querySelector<HTMLTextAreaElement>('textarea[name="comment[body]"]') ??
    document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Use Markdown to format your comment"]') ??
    document.querySelector<HTMLTextAreaElement>("#new_comment_field")
  );
}

/** Put text into GitHub's comment box the way typing would, so its editor notices. Nothing is posted. */
function addToCommentBox(markdown: string): boolean {
  const box = commentBox();
  if (!box) return false;
  const value = box.value.trim() ? `${box.value.replace(/\s+$/, "")}\n\n${markdown}` : markdown;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.focus();
  const notify = () => {
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
  notify();
  // Some of GitHub's forms check the box a moment later; tell them again.
  setTimeout(notify, 600);
  return true;
}

async function deliverPending(page: Page): Promise<void> {
  if (page.type === "file") return;
  const stored = (await chrome.storage.local.get(PENDING))[PENDING] as
    | { repo: string; number: number; comments: string[] }
    | undefined;
  if (!stored || stored.repo !== page.repo || stored.number !== page.number) return;
  // GitHub's own scripts must be listening before the box is filled, or its Comment button stays disabled.
  if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
  for (let i = 0; i < 20 && !commentBox(); i++) await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 1000));
  if (stored.comments.every((c) => addToCommentBox(c))) {
    await chrome.storage.local.remove(PENDING);
    commentBox()?.scrollIntoView({ block: "center" });
    toast(
      `HTMi added ${stored.comments.length} comment${stored.comments.length > 1 ? "s" : ""} to the box below. Press Comment to post.`,
    );
  }
}

/** Keep a prepared comment for an issue or pull request page that has no comment box open here. */
async function keepForConversation(page: Page, markdown: string): Promise<void> {
  if (page.type === "file") return;
  const stored = (await chrome.storage.local.get(PENDING))[PENDING] as
    | { repo: string; number: number; comments: string[] }
    | undefined;
  const same = stored && stored.repo === page.repo && stored.number === page.number;
  const comments = [...(same ? stored!.comments : []), markdown];
  await chrome.storage.local.set({ [PENDING]: { repo: page.repo, number: page.number, comments } });
  toast(
    `HTMi keeps ${comments.length} comment${comments.length > 1 ? "s" : ""} for the Conversation tab; open it to post them.`,
  );
}

// ------------------------------------------------------------------ UI

const STYLE = `
.htmi-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;font:600 14px system-ui,sans-serif;
  background:#1f2328;color:#fff;border:0;border-radius:999px;padding:10px 16px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
.htmi-menu{position:fixed;right:20px;bottom:68px;z-index:2147483000;background:#fff;color:#1f2328;border:1px solid #d1d9e0;
  border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);min-width:280px;font:14px system-ui,sans-serif;overflow:hidden}
.htmi-menu h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#59636e;margin:0;padding:10px 14px 6px}
.htmi-menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:9px 14px;font:inherit;color:inherit;cursor:pointer}
.htmi-menu button:hover,.htmi-menu button:focus-visible{background:#f6f8fa}
.htmi-menu p{margin:0;padding:9px 14px;color:#59636e}
.htmi-overlay{position:fixed;inset:0;z-index:2147483001;background:#fff;display:flex;flex-direction:column}
.htmi-bar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid #d1d9e0;font:14px system-ui,sans-serif;color:#1f2328;background:#f6f8fa}
.htmi-bar b{font-weight:650}.htmi-bar .htmi-note{color:#59636e;flex:1}
.htmi-bar button,.htmi-bar input{font:inherit;padding:5px 10px;border:1px solid #d1d9e0;border-radius:6px;background:#fff;color:#1f2328}
.htmi-bar input{width:70px}
.htmi-overlay iframe{flex:1;border:0;width:100%}
.htmi-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483002;background:#1f2328;color:#fff;
  font:14px system-ui,sans-serif;padding:10px 16px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.htmi-preview{background:var(--bgColor-default,#fff)}
.htmi-preview-note{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:6px 16px;font-size:12px;
  color:var(--fgColor-muted,#59636e);border-bottom:1px solid var(--borderColor-muted,#d1d9e0b3)}
.htmi-preview-note span{flex:1;min-width:200px}
.htmi-preview-note button,.htmi-preview-note input{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--borderColor-default,#d1d9e0);
  border-radius:6px;background:var(--button-default-bgColor-rest,#f6f8fa);color:var(--fgColor-default,#1f2328);cursor:pointer}
.htmi-preview-note input{width:64px;cursor:text;background:var(--bgColor-default,#fff)}
.htmi-preview iframe{display:block;width:100%;height:240px;border:0;background:#fff}
.htmi-switch{display:inline-flex;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;overflow:hidden;
  background:var(--bgColor-muted,#f6f8fa);font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.htmi-switch button{border:0;background:none;padding:4px 12px;color:var(--fgColor-default,#1f2328);cursor:pointer;font:inherit}
.htmi-switch button+button{border-left:1px solid var(--borderColor-default,#d1d9e0)}
.htmi-switch button[aria-pressed=true]{background:var(--bgColor-default,#fff);font-weight:600;box-shadow:inset 0 0 0 1px var(--borderColor-default,#d1d9e0)}
.htmi-desc{border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;overflow:hidden;margin-bottom:16px}
.htmi-desc-head{display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bgColor-muted,#f6f8fa);
  border-bottom:1px solid var(--borderColor-default,#d1d9e0)}
.htmi-desc-head .htmi-tag{margin-left:auto;font-size:12px;color:var(--fgColor-muted,#59636e)}
.htmi-desc .highlight{margin:0}
.htmi-desc .highlight pre{margin:0;border-radius:0}
.htmi-diff-switch{margin:0 8px 0 0;list-style:none;padding:0}
.htmi-switch.htmi-icons{list-style:none;margin:0 8px 0 0;padding:0}
.htmi-switch.htmi-icons li{display:flex}
.htmi-switch.htmi-icons button{padding:3px 8px;display:flex;align-items:center}
.htmi-switch.htmi-icons li[data-selected] button{background:var(--bgColor-default,#fff);box-shadow:inset 0 0 0 1px var(--borderColor-default,#d1d9e0)}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function toast(message: string): void {
  const t = el("div", { class: "htmi-toast", role: "status" }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}

function ensureStyle(): void {
  if (document.getElementById("htmi-style")) return;
  const style = el("style", { id: "htmi-style" });
  style.textContent = STYLE;
  document.head.append(style);
}

/**
 * A sandboxed viewer frame showing one document, built by HTMi's core. It
 * answers the viewer's requests (the document, then the files it uses) and
 * passes prepared comments on. Embedded frames take the page's own height.
 */
function mountViewer(
  frame: HTMLIFrameElement,
  target: Target,
  options: { embed: boolean; onComment: (markdown: string) => void },
): () => void {
  let request: Record<string, unknown> | null = null;
  let source: { repo: string; commit: string } | undefined;
  const files: Record<string, ArrayBuffer> = {};
  const unavailable: string[] = [];
  const build = () =>
    frame.contentWindow?.postMessage(
      {
        type: "htmi:build",
        ...request,
        files: { ...((request!.files as Record<string, ArrayBuffer>) ?? {}), ...files },
        unavailable,
        handoffTo: target.handoffTo,
        embed: options.embed,
        builtAt: new Date().toISOString(),
      },
      "*",
    );
  async function onMessage(event: MessageEvent) {
    if (event.source !== frame.contentWindow) return;
    const m = event.data as {
      type?: string;
      paths?: string[];
      message?: string;
      markdown?: string;
      height?: number;
      by?: number;
    };
    try {
      if (m.type === "htmi:viewer-ready") {
        const loaded = await target.load();
        request = loaded.request;
        source = loaded.files;
        build();
      } else if (m.type === "htmi:needs") {
        // The files the page uses (stylesheets, images, fonts), at the same commit. One that
        // GitHub does not have is reported by the page as missing, as the CLI would.
        for (const p of m.paths ?? []) {
          const data = source ? await rawFile(source.repo, source.commit, p) : null;
          if (data) files[p] = data;
          else unavailable.push(p);
        }
        build();
      } else if (m.type === "htmi:height" && options.embed && typeof m.height === "number") {
        frame.style.height = `${Math.max(120, Math.min(m.height, 20000))}px`;
      } else if (m.type === "htmi:scroll" && options.embed && typeof m.by === "number") {
        // The page grew around the element the reader clicked (the comment card took the
        // margin); scroll by the same amount so the element stays under the pointer.
        window.scrollBy({ top: Math.max(-20000, Math.min(m.by, 20000)), behavior: "instant" });
      } else if (m.type === "htmi:error") {
        toast(`HTMi could not show this: ${m.message}`);
      } else if (m.type === "htmi:comment" && m.markdown) {
        options.onComment(m.markdown);
      }
    } catch (error) {
      toast(`HTMi could not show this: ${(error as Error).message}`);
    }
  }
  window.addEventListener("message", onMessage);
  frame.src = chrome.runtime.getURL("viewer.html");
  return () => window.removeEventListener("message", onMessage);
}

/** The preview block: a one-line note, the embedded page, and for file pages a way to send prepared comments. */
function previewBlock(page: Page, target: Target, note: string): HTMLElement {
  const block = el("div", { class: "htmi-preview", "data-htmi": "preview" });
  const bar = el("div", { class: "htmi-preview-note" });
  bar.append(el("span", {}, note));
  const frame = el("iframe", { title: `HTMi preview of ${target.label}`, loading: "lazy" });
  const comments = el("button", { type: "button" }, "Comments");
  comments.addEventListener("click", () => frame.contentWindow?.postMessage({ type: "htmi:panel" }, "*"));
  bar.append(comments);
  const prepared: string[] = [];
  if (!target.handoffTo) {
    const number = el("input", {
      type: "number",
      min: "1",
      placeholder: "#",
      "aria-label": "Issue or pull request number",
    });
    const send = el("button", { type: "button" }, "Open it with the comments");
    send.addEventListener("click", async () => {
      const n = Number(number.value);
      if (!n || !prepared.length) {
        toast(prepared.length ? "Enter the issue or pull request number first." : "Prepare a comment first.");
        return;
      }
      await chrome.storage.local.set({ [PENDING]: { repo: page.repo, number: n, comments: prepared } });
      location.href = `https://github.com/${page.repo}/issues/${n}`;
    });
    bar.append(el("span", { class: "htmi-send" }, "Send prepared comments to"), number, send);
  }
  block.append(bar, frame);
  mountViewer(frame, target, {
    embed: true,
    onComment: (markdown) => {
      prepared.push(markdown);
      if (!target.handoffTo) return;
      // Files changed has no conversation box: keep the comment for the Conversation tab, which fills its box.
      if (!addToCommentBox(markdown)) void keepForConversation(page, markdown);
    },
  });
  return block;
}

function switchControl(labels: string[], pressed: string, onPick: (label: string) => void): HTMLElement {
  const sw = el("div", { class: "htmi-switch", role: "group", "aria-label": "HTMi view" });
  for (const label of labels) {
    const b = el("button", { type: "button", "aria-pressed": String(label === pressed) }, label);
    b.addEventListener("click", () => {
      sw.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(label);
    });
    sw.append(b);
  }
  return sw;
}

// ------------------------------------------------------------------ file pages: Preview, Code, Blame

/** Per file, what the reviewer chose last on this page: GitHub re-renders often, and the choice must hold. */
const fileMode = new Map<string, "preview" | "code">();
const fileBlocks = new Map<string, HTMLElement>();

function integrateFile(page: Extract<Page, { type: "file" }>): void {
  const control = document.querySelector<HTMLUListElement>('ul[aria-label="File view"]');
  const anchor = document.getElementById("highlighted-line-menu-positioner");
  const section = anchor?.closest("section");
  if (!control || !anchor || !section) return;
  const codeWrap = [...section.children].find((c) => c.contains(anchor)) as HTMLElement | undefined;
  if (!codeWrap) return;
  const key = `${page.repo}/${page.ref}/${page.path}`;
  const codeItem = [...control.children].find((li) => li.textContent?.trim() === "Code") as HTMLElement | undefined;
  if (!codeItem) return;
  let previewItem = control.querySelector<HTMLElement>("li[data-htmi='preview']");
  if (!previewItem) {
    // GitHub's own control, with Preview first as it is for Markdown.
    previewItem = codeItem.cloneNode(true) as HTMLElement;
    previewItem.dataset.htmi = "preview";
    const text = [...previewItem.querySelectorAll("*")].find(
      (n) => n.children.length === 0 && n.textContent?.trim() === "Code",
    );
    if (text) text.textContent = "Preview";
    previewItem.querySelector("button")!.addEventListener("click", () => {
      fileMode.set(key, "preview");
      setPlain(false);
      integrateFile(page);
    });
    codeItem.querySelector("button")!.addEventListener("click", () => {
      fileMode.set(key, "code");
      setPlain(true);
      integrateFile(page);
    });
    control.prepend(previewItem);
  }
  const mode = fileMode.get(key) ?? (new URLSearchParams(location.search).get("plain") === "1" ? "code" : "preview");
  // GitHub's control marks the chosen item with data-selected and its button with aria-pressed.
  for (const [item, on] of [
    [previewItem, mode === "preview"],
    [codeItem, mode === "code"],
  ] as const) {
    item.querySelector("button")!.setAttribute("aria-pressed", String(on));
    if (on) item.dataset.selected = "true";
    else delete item.dataset.selected;
  }
  let block = fileBlocks.get(key);
  if (mode === "preview") {
    if (!block) {
      block = previewBlock(
        page,
        fileTarget(page.repo, page.ref, page.path, null),
        "HTMi preview: the page as written, without its scripts. Click an element or select text to comment.",
      );
      fileBlocks.set(key, block);
    }
    if (block.parentElement !== section) section.insertBefore(block, codeWrap);
    block.hidden = false;
    codeWrap.style.display = "none";
  } else {
    if (block) block.hidden = true;
    codeWrap.style.display = "";
  }
}

/** Mirror GitHub's Markdown behaviour: the Code view is ?plain=1, so it survives a reload or a shared link. */
function setPlain(plain: boolean): void {
  const url = new URL(location.href);
  if (plain) url.searchParams.set("plain", "1");
  else url.searchParams.delete("plain");
  history.replaceState(history.state, "", url);
}

// ------------------------------------------------------------------ descriptions: Preview, Code

/** The description's body element, and its html code block when the description is exactly one fenced html block. */
function htmlDescription(page: Extract<Page, { type: "issue" | "pull" }>): HTMLElement | null {
  let body: Element | null = null;
  if (page.type === "issue") {
    const viewer = document.querySelector('[data-testid="issue-body-viewer"]');
    body = viewer ? ([...viewer.querySelectorAll(".markdown-body")].pop() ?? null) : null;
  } else {
    body = document.querySelector('[id^="pullrequest-"] .js-comment-body');
  }
  if (!body) return null;
  const blocks = [...body.children].filter((c) => !(c as HTMLElement).dataset.htmi);
  const block = blocks.length === 1 ? (blocks[0] as HTMLElement) : null;
  if (!block?.matches("div.highlight-text-html-basic")) return null;
  const outside = [...body.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
  return outside.length ? null : block;
}

function integrateDescription(page: Extract<Page, { type: "issue" | "pull" }>): boolean {
  const existing = document.querySelector<HTMLElement>("div.htmi-desc");
  if (existing?.isConnected) return true;
  const code = htmlDescription(page);
  if (!code) return false;
  const what = page.type === "pull" ? `pull request #${page.number}` : `issue #${page.number}`;
  const shown = code.querySelector("pre")?.textContent ?? "";
  const target: Target = {
    label: `the description of ${what}`,
    handoffTo: `the comment box of ${what}`,
    load: async () => {
      try {
        return { request: { kind: "description", description: await readDescription(page) } };
      } catch {
        // GitHub shows the code to every reader but gives the exact text only to editors: show the page, take no comments.
        const description: Description = {
          repo: page.repo,
          number: page.number,
          kind: page.type,
          title: "",
          body: "```html\n" + shown.replace(/\n$/, "") + "\n```\n",
          url: location.href,
          updatedAt: "",
        };
        return {
          request: {
            kind: "description",
            description,
            disabled:
              "Comments on this description need its exact text, which GitHub gives to people who can edit it. The page is shown as GitHub displays its code.",
          },
        };
      }
    },
  };
  const wrap = el("div", { class: "htmi-desc", "data-htmi": "description" });
  const head = el("div", { class: "htmi-desc-head" });
  const preview = previewBlock(
    page,
    target,
    `HTMi preview of this HTML description. Click an element or select text to comment; it goes to ${target.handoffTo}.`,
  );
  head.append(
    switchControl(["Preview", "Code"], "Preview", (label) => {
      preview.hidden = label !== "Preview";
      code.hidden = label === "Preview";
    }),
    el("span", { class: "htmi-tag" }, "HTML, shown by HTMi"),
  );
  code.parentElement!.insertBefore(wrap, code);
  wrap.append(head, preview, code);
  code.hidden = true;
  return true;
}

// ------------------------------------------------------------------ Files changed: Diff, Preview

let pullFiles: { key: string; head: string | null } | null = null;

async function headOfPull(page: Extract<Page, { type: "pull" }>): Promise<string | null> {
  const key = `${page.repo}#${page.number}`;
  if (pullFiles?.key === key) return pullFiles.head;
  const text = await (
    await fetch(`/${page.repo}/pull/${page.number}/files`, { headers: { Accept: "application/json" } })
  ).text();
  pullFiles = { key, head: /"headOid":"([0-9a-f]{40})"/.exec(text)?.[1] ?? null };
  return pullFiles.head;
}

/**
 * Per file in Files changed: the view chosen and its preview. GitHub re-draws file headers after
 * loading, so the switch is added again each time, from this state, and the preview is reused.
 */
interface DiffView {
  mode: "Diff" | "Preview";
  block?: HTMLElement;
  /** The preview being made, so a header re-drawn meanwhile does not make a second one. */
  making?: Promise<HTMLElement | null>;
}
const diffViews = new Map<string, DiffView>();

function integrateChanges(page: Extract<Page, { type: "pull" }>): void {
  for (const header of document.querySelectorAll<HTMLElement>('div[class*="diff-file-header"]')) {
    if (header.querySelector(".htmi-diff-switch")) continue;
    const name =
      header
        .querySelector("h3")
        ?.textContent?.trim()
        .replace(/^\u200e|\u200e$/g, "") ?? "";
    if (!HTML_FILE.test(name)) continue;
    const key = `${page.repo}#${page.number}:${name}`;
    // Rendered by default, as GitHub shows SVG files here.
    const view: DiffView = diffViews.get(key) ?? { mode: "Preview" };
    diffViews.set(key, view);
    const sw = iconSwitch(view.mode, (label) => {
      view.mode = label;
      void showDiffView(page, header, name, view);
    });
    sw.classList.add("htmi-diff-switch");
    // Beside GitHub's own buttons for the file, where it puts the same control for SVG files.
    const buttons = [...header.querySelectorAll<HTMLElement>(":scope > div")].pop() ?? header;
    buttons.prepend(sw);
    void showDiffView(page, header, name, view);
  }
}

async function showDiffView(
  page: Extract<Page, { type: "pull" }>,
  header: HTMLElement,
  name: string,
  view: DiffView,
): Promise<void> {
  if (view.mode === "Preview" && !view.block) {
    view.making ??= (async () => {
      const head = await headOfPull(page);
      if (!head) {
        toast("HTMi could not find this pull request's head commit.");
        return null;
      }
      const what = `pull request #${page.number}`;
      return previewBlock(
        page,
        fileTarget(page.repo, head, name, `the comment box on the Conversation tab of ${what}`, head),
        `HTMi preview of ${name} at ${head.slice(0, 7)}, the head of this pull request. Comments go to its conversation.`,
      );
    })();
    view.block = (await view.making) ?? undefined;
  }
  // Found after any wait: GitHub may have re-drawn the file meanwhile.
  const entry = header.isConnected
    ? header.closest<HTMLElement>('[class*="diffTargetable"]')
    : [...document.querySelectorAll<HTMLElement>('div[class*="diff-file-header"]')]
        .find((h) => h.querySelector("h3")?.textContent?.includes(name))
        ?.closest<HTMLElement>('[class*="diffTargetable"]');
  const headerWrap = [...(entry?.children ?? [])].find((c) => c.querySelector('div[class*="diff-file-header"]')) as
    | HTMLElement
    | undefined;
  if (!entry || !headerWrap) return;
  if (view.block && !entry.contains(view.block)) headerWrap.after(view.block);
  const others = [...entry.children].filter((c) => c !== headerWrap && c !== view.block) as HTMLElement[];
  if (view.mode === "Preview") {
    view.block!.hidden = false;
    others.forEach((o) => (o.style.display = "none"));
  } else {
    if (view.block) view.block.hidden = true;
    others.forEach((o) => (o.style.display = ""));
  }
}

const OCTICON_CODE =
  "m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z";
const OCTICON_FILE =
  "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z";

/**
 * GitHub's own source/rich switch, as it shows for SVG files in Files changed: built from the
 * page's own control when one is there, so it looks like GitHub's; otherwise styled to match.
 */
function iconSwitch(initial: "Diff" | "Preview", onPick: (label: "Diff" | "Preview") => void): HTMLElement {
  const template = document.querySelector<HTMLElement>('ul[data-component="SegmentedControl"][data-size="small"]');
  const ns = "http://www.w3.org/2000/svg";
  const icon = (d: string) => {
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "octicon");
    svg.setAttribute("data-component", "Octicon");
    svg.style.cssText = "display:inline-block;width:16px;height:16px;vertical-align:text-bottom;overflow:visible";
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  };
  const items: ["Diff" | "Preview", string, string][] = [
    ["Diff", "Display the source diff", OCTICON_CODE],
    ["Preview", "Display the rendered page (HTMi)", OCTICON_FILE],
  ];
  const ul = el("ul", { "aria-label": "File view", "data-htmi": "switch" });
  const liClass = template?.querySelector("li")?.className;
  const buttonClass = template?.querySelector("button")?.className;
  const contentClass = template?.querySelector("button > span")?.className;
  if (template) ul.className = template.className;
  else ul.classList.add("htmi-switch", "htmi-icons");
  for (const [label, tip, d] of items) {
    const li = el("li", liClass ? { class: liClass } : {});
    const b = el("button", {
      type: "button",
      "aria-pressed": String(label === initial),
      "aria-label": tip,
      title: tip,
      "data-label": label,
    });
    if (buttonClass) b.className = buttonClass;
    if (contentClass) {
      const holder = el("span", { class: contentClass });
      holder.append(icon(d));
      b.append(holder);
    } else b.append(icon(d));
    b.addEventListener("click", () => {
      ul.querySelectorAll("li").forEach((x) => delete (x as HTMLElement).dataset.selected);
      ul.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      li.dataset.selected = "true";
      onPick(label);
    });
    if (label === initial) li.dataset.selected = "true";
    li.append(b);
    ul.append(li);
  }
  return ul;
}

// ------------------------------------------------------------------ the overlay, for Markdown descriptions

function openReview(page: Page, target: Target): void {
  const overlay = el("div", {
    class: "htmi-overlay",
    role: "dialog",
    "aria-label": `HTMi review of ${target.label}`,
  });
  const bar = el("div", { class: "htmi-bar" });
  bar.append(
    el("b", {}, "HTMi"),
    el(
      "span",
      { class: "htmi-note" },
      `Reviewing ${target.name ?? target.label}. Comments go to ${target.handoffTo}; you post them.`,
    ),
  );
  const close = el("button", { type: "button" }, "Close");
  const frame = el("iframe", { title: `HTMi review of ${target.label}` });
  const unmount = mountViewer(frame, target, { embed: false, onComment: (markdown) => addToCommentBox(markdown) });
  close.addEventListener("click", () => {
    overlay.remove();
    unmount();
    commentBox()?.scrollIntoView({ block: "center" });
  });
  bar.append(close);
  overlay.append(bar, frame);
  document.body.append(overlay);
  close.focus();
}

function launcher(page: Extract<Page, { type: "issue" | "pull" }>): void {
  if (document.querySelector(".htmi-launch")) return;
  const launch = el("button", { type: "button", class: "htmi-launch" }, "Review with HTMi");
  launch.addEventListener("click", () => {
    const what = page.type === "pull" ? `pull request #${page.number}` : `issue #${page.number}`;
    openReview(page, {
      label: "The description",
      name: `the description of ${what}`,
      handoffTo: `the comment box of ${what}`,
      load: async () => ({ request: { kind: "description", description: await readDescription(page) } }),
    });
  });
  document.body.append(launch);
}

// ------------------------------------------------------------------ follow GitHub's navigation

let delivered = "";
let scheduled = false;
function integrate(): void {
  scheduled = false;
  const page = currentPage();
  const onChanges = /\/pull\/\d+\/(files|changes)/.test(location.pathname);
  if (!page) {
    document.querySelectorAll(".htmi-launch").forEach((e) => e.remove());
    return;
  }
  ensureStyle();
  if (page.type === "file") integrateFile(page);
  else if (onChanges && page.type === "pull") integrateChanges(page);
  else {
    // An HTML description is shown in place; any other description can still be reviewed in the overlay.
    if (integrateDescription(page)) document.querySelectorAll(".htmi-launch").forEach((e) => e.remove());
    else if (document.querySelector('[data-testid="issue-body-viewer"], [id^="pullrequest-"] .js-comment-body'))
      launcher(page);
  }
  if (delivered !== location.pathname) {
    delivered = location.pathname;
    void deliverPending(page);
  }
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(integrate);
}

integrate();
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", schedule);
