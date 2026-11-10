import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { reviewApi, ReviewApiError, type ReviewApi } from "../../src/app/review-api.js";
import { AnnotationStore } from "../../src/core/annotations.js";
import type { DocModel } from "../../src/core/document.js";
import { buildAnyModel } from "../../src/core/load.js";
import { planOperation, type OperationConflict, type OperationResult } from "../../src/core/operations.js";
import { resolveThreads } from "../../src/core/resolve.js";
import { findRepoRoot, repoRelative, workingRevision } from "../../src/core/revision.js";
import { openWorkspace, type Workspace } from "../../src/core/workspace.js";
import { buildReviewPage, setClientDir } from "../../src/render/review-page.js";

/**
 * HTMi in VS Code: the review page beside the source editor. The text
 * document stays authoritative: the page is rebuilt from the buffer as it
 * changes (saved or not), comments are written only against saved text,
 * "Show in source" selects the element's exact source range, and checked
 * operations become a WorkspaceEdit, so they land in the undo stack and are
 * saved like any other edit. The webview gets no VS Code API object of its
 * own beyond posting messages; every message is checked here.
 */

const VERSION = "0.1.0";

export interface ReviewPanel {
  readonly document: vscode.TextDocument;
  readonly root: string;
  readonly path: string;
  model: DocModel;
  html: string;
  /** Messages the page has sent, newest last. */
  readonly received: { type: string; [key: string]: unknown }[];
  handleMessage(message: unknown): Promise<unknown>;
  dispose(): void;
}

export interface HtmiApi {
  panels: Map<string, ReviewPanel>;
}

const panels = new Map<string, ReviewPanel>();

function locate(document: vscode.TextDocument): { root: string; path: string; ws: Workspace } {
  if (document.uri.scheme !== "file") throw new Error("HTMi reviews files on disk");
  const root = findRepoRoot(dirname(document.uri.fsPath));
  const path = repoRelative(root, document.uri.fsPath);
  if (!path) throw new Error(`${document.uri.fsPath} is outside ${root}`);
  return { root, path, ws: openWorkspace(root) };
}

/**
 * The text HTMi works on: the file as saved while the buffer is clean, the
 * buffer while it has unsaved changes. VS Code can hold a clean buffer that
 * differs from the file (it normalises mixed line endings when it loads), so
 * offsets are exchanged with the editor as line and column, never directly.
 */
function sourceText(document: vscode.TextDocument): string {
  return document.isDirty ? document.getText() : readFileSync(document.uri.fsPath, "utf8");
}

export function positionIn(text: string, offset: number): vscode.Position {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return new vscode.Position(lines.length - 1, lines[lines.length - 1]!.length);
}

export function offsetIn(text: string, position: vscode.Position): number {
  const eol = /\r\n|\r|\n/g;
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const m = eol.exec(text);
    if (!m) return text.length;
    start = m.index + m[0].length;
  }
  return Math.min(start + position.character, text.length);
}

/** The document model of the text as it is now, saved or not. */
function modelOf(document: vscode.TextDocument, root: string, path: string): DocModel {
  const revision = workingRevision(root, path);
  const unsaved = document.isDirty
    ? { ...revision, state: "modified" as const, label: `${revision.label}+unsaved` }
    : revision;
  return buildAnyModel(sourceText(document), path, root, unsaved);
}

function openPanel(document: vscode.TextDocument, column: vscode.ViewColumn): ReviewPanel {
  const key = document.uri.toString();
  const existing = panels.get(key);
  if (existing) return existing;
  const { root, path, ws } = locate(document);
  const api: ReviewApi = reviewApi(ws, { source: "vscode" });
  const webview = vscode.window.createWebviewPanel(
    "htmi.review",
    `Review: ${basename(path)}`,
    { viewColumn: column, preserveFocus: true },
    { enableScripts: true, enableForms: false, enableCommandUris: false, localResourceRoots: [] },
  );
  const subscriptions: vscode.Disposable[] = [];
  let timer: NodeJS.Timeout | undefined;

  const panel: ReviewPanel = {
    document,
    root,
    path,
    model: modelOf(document, root, path),
    html: "",
    received: [],
    async handleMessage(message) {
      if (!message || typeof message !== "object" || typeof (message as { type?: unknown }).type !== "string") return;
      const m = message as { type: string; id?: unknown; path?: unknown; body?: unknown; key?: unknown };
      panel.received.push(m as ReviewPanel["received"][number]);
      if (m.type === "htmi:request" && typeof m.id === "number" && typeof m.path === "string") {
        const reply = answer(m.path, m.body);
        await webview.webview.postMessage({ type: "htmi:response", id: m.id, ...reply });
        return reply;
      }
      if (m.type === "htmi:reveal" && typeof m.key === "string") return reveal(m.key);
      if (m.type === "htmi:selected" && typeof m.key === "string") {
        const t = panel.model.targets.get(m.key);
        status.text = t ? `$(comment-discussion) HTMi: ${t.block?.kind ?? t.kind} ${t.key}` : "";
        status.show();
      }
      return undefined;
    },
    dispose() {
      webview.dispose();
    },
  };

  const answer = (requestPath: string, body: unknown): { ok: boolean; status: number; json: unknown } => {
    try {
      if (requestPath.startsWith("/api/state")) {
        const doc = new URL(requestPath, "http://host").searchParams.get("doc") ?? path;
        return { ok: true, status: 200, json: api.state(doc) };
      }
      if (document.isDirty) {
        return { ok: false, status: 409, json: { error: "save the file first; comments refer to saved text" } };
      }
      const result = api.write(requestPath, body);
      render();
      return { ok: true, status: result.status, json: result.json };
    } catch (error) {
      const status = error instanceof ReviewApiError ? error.status : 422;
      return { ok: false, status, json: { error: (error as Error).message } };
    }
  };

  const reveal = async (key: string) => {
    const target = panel.model.targets.get(key);
    if (!target) return undefined;
    const text = panel.model.content;
    const range = target.span
      ? new vscode.Range(positionIn(text, target.span.start), positionIn(text, target.span.end))
      : new vscode.Range(target.lines.start - 1, 0, target.lines.end - 1, 0);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.window.visibleTextEditors.find((e) => e.document === document)?.viewColumn,
      selection: range,
      preserveFocus: false,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return range;
  };

  const render = () => {
    panel.model = modelOf(document, root, path);
    const threads = resolveThreads(panel.model, new AnnotationStore(root).threads());
    panel.html = buildReviewPage({
      doc: panel.model,
      repoRoot: root,
      threads,
      mode: "snapshot",
      builtAt: new Date().toISOString(),
      includesLocalComments: true,
      version: VERSION,
      host: document.isDirty
        ? { name: "VS Code", canSave: false, reason: "unsaved changes shown; save the file to comment" }
        : { name: "VS Code", canSave: true },
    });
    webview.webview.html = panel.html;
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 250);
  };

  subscriptions.push(
    webview.webview.onDidReceiveMessage((m) => panel.handleMessage(m)),
    vscode.workspace.onDidChangeTextDocument((e) => e.document === document && later()),
    vscode.workspace.onDidSaveTextDocument((d) => d === document && render()),
    // The cursor in the source selects the element it is in.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document !== document || e.kind === undefined) return;
      const offset = offsetIn(panel.model.content, e.selections[0]!.active);
      const inside = [...panel.model.targets.values()]
        .filter((t) => t.span && t.span.start <= offset && offset < t.span.end)
        .sort((a, b) => a.span!.end - a.span!.start - (b.span!.end - b.span!.start))[0];
      if (inside) void webview.webview.postMessage({ type: "htmi:select", key: inside.key });
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*"));
  const onFile = (uri: vscode.Uri) => {
    const rel = repoRelative(root, uri.fsPath);
    if (!rel) return;
    if (rel === ".htmi/annotations.jsonl" || panel.model.dependencies?.some((d) => d.path === rel)) later();
  };
  subscriptions.push(watcher, watcher.onDidChange(onFile), watcher.onDidCreate(onFile), watcher.onDidDelete(onFile));
  webview.onDidDispose(() => {
    clearTimeout(timer);
    subscriptions.forEach((s) => s.dispose());
    panels.delete(key);
  });

  render();
  panels.set(key, panel);
  return panel;
}

let status: vscode.StatusBarItem;

/** Apply a checked operation to the buffer (or to a file the document uses) as an undoable edit. */
async function applyOperationCommand(
  op?: unknown,
  uri?: vscode.Uri,
): Promise<(Omit<OperationResult, "content"> & { appliedTo: string }) | OperationConflict | undefined> {
  const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!document) {
    void vscode.window.showErrorMessage("HTMi: open an HTML or Markdown document first");
    return undefined;
  }
  let operation = op;
  if (operation === undefined) {
    const text = await vscode.window.showInputBox({
      prompt: "Operation JSON (from htmi read or an agent)",
      placeHolder: '{"op":"set-text","target":"#costs",...}',
    });
    if (!text) return undefined;
    try {
      operation = JSON.parse(text);
    } catch {
      void vscode.window.showErrorMessage("HTMi: the operation is not valid JSON");
      return undefined;
    }
  }
  const { root, path } = locate(document);
  const version = document.version;
  const model = modelOf(document, root, path);
  let text = model.content;
  const result = planOperation(model, root, operation);
  if (!result.ok) {
    void vscode.window.showErrorMessage(`HTMi: not applied (${result.reason}): ${result.message}`);
    return result;
  }
  let target = document;
  if (result.path !== path) {
    target = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, result.path)));
    if (target.isDirty) {
      const conflict: OperationConflict = { ok: false, reason: "stale-document", message: `save ${result.path} first` };
      void vscode.window.showErrorMessage(`HTMi: ${conflict.message}`);
      return conflict;
    }
    text = readFileSync(join(root, result.path), "utf8");
  }
  if (document.version !== version) {
    const conflict: OperationConflict = {
      ok: false,
      reason: "stale-document",
      message: "the buffer changed while the edit was prepared",
    };
    void vscode.window.showErrorMessage(`HTMi: ${conflict.message}`);
    return conflict;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const e of result.edits) {
    edit.replace(target.uri, new vscode.Range(positionIn(text, e.start), positionIn(text, e.end)), e.text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    return { ok: false, reason: "check-failed", message: "VS Code refused the edit" };
  }
  const { content: _content, ...summary } = result;
  void _content;
  return { ...summary, appliedTo: result.path };
}

export function activate(context: vscode.ExtensionContext): HtmiApi {
  setClientDir(pathToFileURL(join(context.extensionPath, "dist", "client") + "/"));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("htmi.openReview", (uri?: vscode.Uri) => {
      const run = async () => {
        const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
        if (!document) throw new Error("open an HTML or Markdown document first");
        return openPanel(document, vscode.ViewColumn.Beside);
      };
      return run().catch((error: Error) => {
        void vscode.window.showErrorMessage(`HTMi: ${error.message}`);
        return undefined;
      });
    }),
    vscode.commands.registerCommand("htmi.applyOperation", applyOperationCommand),
  );
  return { panels };
}

export function deactivate(): void {
  for (const panel of panels.values()) panel.dispose();
}
