export function fileURLToPath(u: string | URL): string {
  return decodeURIComponent(new URL(String(u)).pathname);
}
export function pathToFileURL(p: string): URL {
  return new URL(`file://${encodeURI(p)}`);
}
const URLClass = globalThis.URL;
export { URLClass as URL };
export default { fileURLToPath, pathToFileURL, URL: URLClass };
