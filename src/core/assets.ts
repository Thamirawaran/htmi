import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { digestOf } from "./digest.js";
import { repoRelative } from "./revision.js";

/**
 * A reference to an image or icon. Agents receive this record, never the
 * bytes; renderers call `readAsset` when they need the picture itself.
 */
export interface AssetRef {
  /** The reference exactly as written in the source. */
  ref: string;
  kind: "file" | "library";
  /** Repository relative path, for file assets. */
  path?: string;
  library?: { name: "lucide"; icon: string; version: string };
  mediaType?: string;
  digest?: string;
  size?: number;
  license?: { identifier: string; noticeFile?: string };
  /** Set when the asset could not be resolved; the reason is user facing. */
  error?: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function mediaTypeFor(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()];
}

/** Paths that resolve outside the repository, or that are URLs, are rejected rather than followed. */
export function resolveAsset(ref: string, repoRoot: string, docDir: string): AssetRef {
  if (ref.startsWith("lucide:")) return resolveLucide(ref, repoRoot);
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
    return { ref, kind: "file", error: "remote and data URLs are not embedded; use a file inside the repository" };
  }
  const absolute = ref.startsWith("/") ? join(repoRoot, ref) : resolve(docDir, ref);
  const mediaType = mediaTypeFor(absolute);
  if (!mediaType) return { ref, kind: "file", error: `unsupported image type "${extname(absolute) || "none"}"` };
  // Scope is checked before existence so nothing is revealed about files outside the repository.
  const lexical = repoRelative(repoRoot, absolute);
  if (!lexical) return { ref, kind: "file", mediaType, error: "path resolves outside the repository" };
  if (!existsSync(absolute)) return { ref, kind: "file", path: lexical, mediaType, error: "file not found" };
  // A symlink inside the repository may still point outside it.
  const real = realpathSync(absolute);
  const rel = repoRelative(realpathSync(repoRoot), real);
  if (!rel) return { ref, kind: "file", mediaType, error: "path resolves outside the repository" };
  const bytes = readFileSync(real);
  return { ref, kind: "file", path: rel, mediaType, digest: digestOf(bytes), size: bytes.length };
}

function resolveLucide(ref: string, repoRoot: string): AssetRef {
  const icon = ref.slice("lucide:".length);
  if (!/^[a-z0-9-]+$/.test(icon)) return { ref, kind: "library", error: `invalid icon name "${icon}"` };
  const pkgDir = findPackageDir("lucide-static", repoRoot);
  if (!pkgDir) {
    return {
      ref,
      kind: "library",
      error: "lucide-static is not installed; run `npm install lucide-static` to use lucide: icons",
    };
  }
  const file = join(pkgDir, "icons", `${icon}.svg`);
  const version = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;
  if (!existsSync(file)) {
    return {
      ref,
      kind: "library",
      library: { name: "lucide", icon, version },
      error: `lucide has no icon named "${icon}"`,
    };
  }
  const bytes = readFileSync(file);
  return {
    ref,
    kind: "library",
    library: { name: "lucide", icon, version },
    mediaType: "image/svg+xml",
    digest: digestOf(bytes),
    size: bytes.length,
    license: { identifier: "ISC", noticeFile: "node_modules/lucide-static/LICENSE" },
  };
}

function findPackageDir(name: string, repoRoot: string): string | null {
  for (const base of [join(repoRoot, "package.json"), import.meta.url]) {
    try {
      return dirname(createRequire(base).resolve(`${name}/package.json`));
    } catch {
      // try the next base
    }
  }
  return null;
}

/** The bytes of a resolved asset. */
export function readAsset(asset: AssetRef, repoRoot: string): Buffer | null {
  if (asset.error) return null;
  if (asset.kind === "library" && asset.library) {
    const pkgDir = findPackageDir("lucide-static", repoRoot);
    return pkgDir ? readFileSync(join(pkgDir, "icons", `${asset.library.icon}.svg`)) : null;
  }
  return asset.path ? readFileSync(join(repoRoot, asset.path)) : null;
}

/** A data URI for embedding in a self-contained page. SVG is only ever used through <image>, where it cannot run script. */
export function assetDataUri(asset: AssetRef, repoRoot: string): string | null {
  const bytes = readAsset(asset, repoRoot);
  if (!bytes || !asset.mediaType) return null;
  return `data:${asset.mediaType};base64,${bytes.toString("base64")}`;
}
