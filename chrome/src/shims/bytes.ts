/** The few Buffer behaviours HTMi's core uses, on a Uint8Array. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export class Bytes extends Uint8Array {
  static fromData(data: Uint8Array | ArrayBuffer | string): Bytes {
    if (typeof data === "string") return new Bytes(new TextEncoder().encode(data));
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const out = new Bytes(view.length);
    out.set(view);
    return out;
  }

  override toString(encoding = "utf8"): string {
    switch (encoding) {
      case "utf8":
      case "utf-8":
        return new TextDecoder("utf-8").decode(this);
      case "hex":
        return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
      case "base64":
      case "base64url": {
        let out = "";
        for (let i = 0; i < this.length; i += 3) {
          const n = (this[i]! << 16) | ((this[i + 1] ?? 0) << 8) | (this[i + 2] ?? 0);
          out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
          out += i + 1 < this.length ? B64[(n >> 6) & 63]! : "=";
          out += i + 2 < this.length ? B64[n & 63]! : "=";
        }
        return encoding === "base64" ? out : out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      }
      default:
        throw new Error(`encoding ${encoding} is not supported in the browser`);
    }
  }
}
