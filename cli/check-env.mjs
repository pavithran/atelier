// The environment a local check gets, and a home runner's harness with it
// (runner.mjs harnessEnv). Its own module, because runner.mjs cannot import
// atelier.mjs: atelier.mjs imports runner.mjs, and `atelier runner` would
// then wait on its own unfinished module.
//
// A local check runs code from the item's head, which an agent wrote, so it
// gets only the variables toolchains need to find themselves and their caches:
//   PATH, HOME, USER, LOGNAME, SHELL  tools and the user's caches: npm's ~/.npm,
//                                     Xcode's DerivedData, uv, Playwright's browsers
//   LANG, LC_*, TZ                    locale and time zone, which tests may read
//   TMPDIR                            the per-user temporary folder on macOS, used
//                                     by xcodebuild, swift and mktemp
//   CI                                kept when the caller sets it
//   DEVELOPER_DIR, TOOLCHAINS         the Xcode and Swift toolchain the caller chose
//   NODE_EXTRA_CA_CERTS, NODE_USE_SYSTEM_CA, SSL_CERT_FILE, SSL_CERT_DIR
//                                     certificates trusted by npm ci and uv sync
//   npm_config_*                      npm settings given as variables
// Nothing named ATELIER_*, and no variable whose name says it holds a token, a
// key, a secret, a password or a credential, so npm_config__authToken is
// dropped. SSH_AUTH_SOCK is not on the list: it lets a process sign in
// wherever the caller's SSH keys reach. A check that needs anything else sets it
// in its own command, as ourai's check sets its own HOME. This keeps the
// caller's credentials out of a check's environment; it does not keep the
// check from reading the caller's files or Keychain, which is why untrusted
// code belongs in the sandbox (atelier check --sandbox).
const CHECK_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR", "CI", "DEVELOPER_DIR", "TOOLCHAINS", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
const SECRET_NAME = /token|secret|passw|credential|auth|key|otp/i;
export function checkEnv(base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    const listed = CHECK_ENV.has(name) || name.startsWith("LC_") || /^npm_config_/i.test(name);
    if (listed && value !== undefined && !name.startsWith("ATELIER_") && !SECRET_NAME.test(name)) env[name] = value;
  }
  return env;
}
