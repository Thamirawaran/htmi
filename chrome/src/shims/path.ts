/** POSIX path functions for HTMi's core in the browser; the virtual file system uses absolute POSIX paths. */
export const sep = "/";
export const delimiter = ":";

export function normalize(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(part);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== "").join("/"));
}

export function resolve(...parts: string[]): string {
  let out = "";
  for (const p of parts) out = p.startsWith("/") ? p : out ? `${out}/${p}` : p;
  return normalize(out.startsWith("/") ? out : `/${out}`);
}

export function dirname(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : n.slice(0, i);
}

export function basename(p: string, ext?: string): string {
  const base = normalize(p).split("/").pop() ?? "";
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export const posix = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative };
export default posix;
