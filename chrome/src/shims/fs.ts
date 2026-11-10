import { Bytes } from "./bytes.js";
import { normalize } from "./path.js";

/**
 * An in-memory file system for HTMi's core in the browser. The extension
 * fetches the document and the files it uses from GitHub, mounts them here,
 * and the core reads them exactly as it reads files on disk.
 */
const files = new Map<string, Bytes>();

function key(p: string | URL): string {
  const s = typeof p === "string" ? p : p.href;
  return normalize(s.startsWith("file://") ? decodeURIComponent(new URL(s).pathname) : s);
}

function isDirectory(p: string): boolean {
  const prefix = p.endsWith("/") ? p : `${p}/`;
  for (const name of files.keys()) if (name.startsWith(prefix)) return true;
  return false;
}

function missing(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
}

export function mount(path: string, data: Uint8Array | ArrayBuffer | string): void {
  files.set(key(path), Bytes.fromData(data));
}

export function unmountAll(): void {
  files.clear();
}

export function existsSync(p: string | URL): boolean {
  const k = key(p);
  return files.has(k) || isDirectory(k);
}

export function readFileSync(p: string | URL, options?: string | { encoding?: string }): Bytes | string {
  const k = key(p);
  const bytes = files.get(k);
  if (!bytes) throw missing(k);
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
}

export function realpathSync(p: string | URL): string {
  const k = key(p);
  if (!files.has(k) && !isDirectory(k)) throw missing(k);
  return k;
}

export function statSync(p: string | URL) {
  const k = key(p);
  const bytes = files.get(k);
  if (!bytes && !isDirectory(k)) throw missing(k);
  return { isFile: () => !!bytes, isDirectory: () => !bytes, size: bytes?.length ?? 0 };
}

function readOnly(): never {
  throw new Error("HTMi's browser extension does not write files");
}
export const writeFileSync = readOnly;
export const appendFileSync = readOnly;
export const mkdirSync = readOnly;
export const renameSync = readOnly;
export default {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
};
