// The module hooks that let Node load the server's sources as written for
// the Workers runtime (Atelier 2.0, task 1; design-branches-2026-10-28.md,
// section 4.2): `cloudflare:workers` resolves to the Node shim beside this
// file, a relative import without an extension
// finds its `.ts` file as the Workers bundler found it, and a `.css` file
// loads as its text, as wrangler's Text rule loaded it. Registered once per
// process by `register()`; registering again does nothing.
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIMS = {
  "cloudflare:workers": new URL("./workers.mjs", import.meta.url).href,
};

let registered = false;

export function register() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (SHIMS[specifier]) return { url: SHIMS[specifier], format: "module", shortCircuit: true };
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        const last = specifier.slice(specifier.lastIndexOf("/") + 1);
        if (!last.includes(".") || !/\.(m?[jt]s|json|css)$/.test(last)) {
          const base = fileURLToPath(new URL(specifier, context.parentURL));
          for (const candidate of [`${base}.ts`, `${base}/index.ts`, `${base}.mjs`]) {
            if (existsSync(candidate) && statSync(candidate).isFile()) return next(pathToFileURL(candidate).href, context);
          }
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith("file:") && url.endsWith(".css")) {
        return { format: "module", source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

register();
