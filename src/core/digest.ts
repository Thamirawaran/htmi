import { createHash, randomBytes } from "node:crypto";

/** Hex SHA-256 of a string (UTF-8) or buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A labelled digest, for example `sha256:9f86d0...`. */
export function digestOf(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

/** The first `length` hex characters of a digest, for display only. */
export function shortDigest(digest: string, length = 12): string {
  return digest.replace(/^sha256:/, "").slice(0, length);
}

/**
 * JSON with object keys sorted and undefined members dropped, so that two
 * structurally equal values always serialise to the same string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = sortValue(member);
    }
    return out;
  }
  return value;
}

/** Digest of a value's canonical JSON form. */
export function digestValue(value: unknown): string {
  return digestOf(canonicalJson(value));
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A short random identifier such as `C-7KQ2XM`, using Crockford base32. */
export function newId(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return `${prefix}-${out}`;
}
