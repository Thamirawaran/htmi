/**
 * The environment HTMi passes to the git and gh it starts. Whoever runs HTMi (an agent, a
 * plugin host, an MCP client) may hold provider keys and other secrets in its environment;
 * none of that reaches child processes. What is kept: the system basics, locale, temporary
 * folders, where gh and git keep their configuration, network proxies and certificate
 * settings, and the variables gh and git document themselves (GH_*, GITHUB_TOKEN, GIT_*).
 */
const NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "GITHUB_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "NO_COLOR",
  "SystemRoot",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);
const PREFIXES = ["LC_", "GH_", "GIT_"];

export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (NAMES.has(name) || PREFIXES.some((p) => name.startsWith(p)))) env[name] = value;
  }
  return env;
}
