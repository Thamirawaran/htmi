/** Node modules HTMi's core imports but never needs in the browser: git, child processes, module loading. */
function unavailable(what: string): never {
  throw new Error(`${what} is not available in HTMi's browser extension`);
}
export function execFileSync(): never {
  return unavailable("running git");
}
export function spawnSync(): never {
  return unavailable("running a process");
}
export function createRequire() {
  const require = (id: string) => unavailable(`loading ${id}`);
  require.resolve = (id: string) => unavailable(`resolving ${id}`);
  return require;
}
export default { execFileSync, spawnSync, createRequire };
