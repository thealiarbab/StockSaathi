// Deploy-time bundle (vercel.json buildCommand). Runs in Vercel's clone of
// the repo and rewrites it in place; nothing it writes is committed.
//
// Before: every page loaded ~67 ES modules and 2 stylesheets as separate
// files, and the service worker re-checked each one on every load, so a
// repeat visit still cost ~33 CDN requests. After:
//   /assets/app.<hash>.js      core bundle (everything app.js imports statically)
//   /assets/<page>.<hash>.js   one chunk per lazily imported page/feature
//   /assets/chunk.<hash>.js    code shared between chunks
//   /assets/app.<hash>.css     main.css + components.css
//   /assets/coach.<hash>.css   coach styles, still loaded only when the coach opens
//   /assets/va|ga.<hash>.js    the two classic analytics scripts, unchanged
//   /assets/supabase-*.<hash>.js  the pinned SDK (loaded by URL, so not bundled)
// Content-hashed names never change meaning, so vercel.json serves /assets/
// as immutable and sw.js serves them cache-first with no re-check.
//
// Then every HTML page is pointed at the hashed names, and sw.js gets the
// build's file list (it precaches the core and prunes old builds' files).
//
// Local dev skips all of this: the source HTML still references /js/app.js
// and sw.js runs with BUILD = null.

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");
const posix = (p) => p.split(sep).join("/");
const urlOf = (abs) => "/" + posix(relative(ROOT, abs));
const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Copy a file to /assets/<name>.<hash><ext>, optionally transformed.
function emitHashed(name, ext, content) {
  const file = join(OUT, `${name}.${hash8(content)}${ext}`);
  writeFileSync(file, content);
  return urlOf(file);
}

// ── 1. Stylesheets ──────────────────────────────────────────────────────────
async function buildCss(entry, name) {
  const r = await esbuild.build({
    entryPoints: { [name]: join(ROOT, entry) },
    bundle: true,
    minify: true,
    write: false,
    outdir: OUT,
    external: ["/fonts/*", "/images/*"],
    logLevel: "warning",
  });
  return emitHashed(name, ".css", r.outputFiles[0].contents);
}
const appCss = await buildCss("build/app.css", "app");
const coachCss = await buildCss("css/coach.css", "coach");

// ── 2. Files loaded by URL rather than import ──────────────────────────────
// The SDK shim imports its UMD neighbour by relative path, so the shim is
// rewritten to the UMD's hashed name before it is hashed itself.
const umdSrc = readFileSync(join(ROOT, "js/vendor/supabase-js-2.45.4.umd.js"));
const umdUrl = emitHashed("supabase-js-2.45.4.umd", ".js", umdSrc);
const shimSrc = readFileSync(join(ROOT, "js/vendor/supabase-js-2.45.4.js"), "utf8");
if (!shimSrc.includes('"./supabase-js-2.45.4.umd.js"')) throw new Error("supabase shim import changed");
const shimUrl = emitHashed("supabase-js-2.45.4", ".js",
  shimSrc.replace('"./supabase-js-2.45.4.umd.js"', JSON.stringify("./" + basename(umdUrl))));

// Classic (non-module) scripts in every page's <head>. Copied byte for byte.
const vaUrl = emitHashed("va", ".js", readFileSync(join(ROOT, "js/va.js")));
const gaUrl = emitHashed("ga", ".js", readFileSync(join(ROOT, "js/ga.js")));

// ── 3. JavaScript ───────────────────────────────────────────────────────────
// String paths the code builds at runtime that esbuild cannot follow. Each
// must be found at least once, so a rename fails the deploy instead of
// silently loading the raw file.
const LITERALS = {
  "/css/coach.css": coachCss,
  "/css/components.css": appCss,
  "/js/vendor/supabase-js-2.45.4.js": shimUrl,
};
const literalHits = new Set();
const SS_CORE = "ss:core";

// One onLoad for both jobs (esbuild uses the first plugin that answers):
// swap the runtime paths above, and on pass 2 make the lazy entries import
// the whole core (see below).
function sourcePlugin(core = null, lazyEntries = new Set()) {
  const coreSet = new Set(core || []);
  coreSet.add("js/app.js");
  return {
    name: "stocksaathi-source",
    setup(b) {
      b.onResolve({ filter: /^ss:core$/ }, () => ({ path: SS_CORE, namespace: "ss-core" }));
      b.onLoad({ filter: /.*/, namespace: "ss-core" }, () => ({
        contents: core.map((m) => `import ${JSON.stringify("./" + m)};`).join("\n"),
        resolveDir: ROOT,
        loader: "js",
      }));
      b.onLoad({ filter: /[\\/]js[\\/].*\.js$/ }, (args) => {
        let src = readFileSync(args.path, "utf8");
        let changed = false;
        for (const [from, to] of Object.entries(LITERALS)) {
          for (const q of ['"', "'", "`"]) {
            const needle = q + from + q;
            if (src.includes(needle)) {
              src = src.split(needle).join(JSON.stringify(to));
              literalHits.add(from);
              changed = true;
            }
          }
        }
        const rel = posix(relative(ROOT, args.path));
        if (core && !coreSet.has(rel)) {
          // A lazy file's import("<core module>") becomes a static import:
          // the module is already loaded, and leaving it dynamic makes it an
          // entry point of its own, which splits the core into more chunks.
          // (Inside core files they stay dynamic: a new static edge there
          // could change the evaluation order of a circular pair.)
          let n = 0;
          const hoisted = [];
          src = src.replace(/\bimport\(\s*(["'])(\.\.?\/[^"'?#]+)\1\s*\)/g, (whole, q, spec) => {
            const target = posix(relative(ROOT, join(dirname(args.path), spec)));
            if (!coreSet.has(target)) return whole;
            const name = `__ssCore${n++}`;
            hoisted.push(`import * as ${name} from ${JSON.stringify(spec)};`);
            return `Promise.resolve(${name})`;
          });
          if (lazyEntries.has(rel)) hoisted.unshift(`import "${SS_CORE}";`);
          if (hoisted.length) {
            src = hoisted.join("\n") + "\n" + src;
            changed = true;
          }
        }
        return changed ? { contents: src, loader: "js" } : undefined;
      });
    },
  };
}

const jsOptions = {
  absWorkingDir: ROOT,          // metafile paths are relative to this
  entryPoints: { app: "js/app.js" },
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  // Error messages, the router's error card and a few console logs print
  // function names; keep them readable.
  keepNames: true,
  outdir: OUT,
  entryNames: "[name].[hash]",
  chunkNames: "chunk.[hash]",
  metafile: true,
  logLevel: "warning",
  logOverride: { "unsupported-dynamic-import": "silent" },  // supabase.js: import(url) by design
};

// esbuild puts a module in a chunk per distinct SET of entry points that
// reach it. A module the core shares with two lazy pages lands in its own
// chunk, so the core alone came out as 20 files of 0.1-60 KB. But the core
// always runs before any lazy page, so it is safe for every lazy page to
// import all of it: pass 1 finds the modules the core reaches statically,
// pass 2 adds `import "ss:core"` to every lazy entry. Every core
// module then has the same entry set and they share one chunk. Module
// instances are unchanged: one copy of each, loaded once. app.js itself is
// left alone so its imports still run in their written order.
const pass1 = await esbuild.build({ ...jsOptions, write: false, plugins: [sourcePlugin()] });
const o1 = pass1.metafile.outputs;
const coreModules = new Set();
const seen = new Set();
(function walk(key) {
  if (seen.has(key)) return;
  seen.add(key);
  for (const src of Object.keys(o1[key].inputs)) coreModules.add(src);
  for (const i of o1[key].imports) if (i.kind === "import-statement" && o1[i.path]) walk(i.path);
})(Object.keys(o1).find((o) => o1[o].entryPoint === "js/app.js"));
coreModules.delete("js/app.js");
const lazyEntries = new Set(Object.values(o1).map((o) => o.entryPoint)
  .filter((e) => e && e !== "js/app.js" && !coreModules.has(e)));

const js = await esbuild.build({ ...jsOptions, plugins: [sourcePlugin([...coreModules].sort(), lazyEntries)] });
for (const k of Object.keys(LITERALS)) {
  if (!literalHits.has(k)) throw new Error(`runtime path ${k} not found in js/ — update LITERALS`);
}

const outputs = js.metafile.outputs;
const appKey = Object.keys(outputs).find((o) => outputs[o].entryPoint === "js/app.js");
const appJs = "/" + appKey;
// Chunks the core bundle imports statically: the browser needs them before
// anything runs, so the HTML preloads them instead of discovering them one
// round trip later.
const coreChunks = outputs[appKey].imports
  .filter((i) => i.kind === "import-statement").map((i) => "/" + i.path);

// Precached by sw.js on install with the core: the market, a stock page and
// the portfolio, with the trade-coaching detectors they load, so trading
// still opens offline. The coach chat and admin stay load-on-first-use.
const OFFLINE_PAGES = ["js/pages/stocks.js", "js/pages/stockDetail.js", "js/pages/portfolio.js"];
const offline = new Set();
(function walk(keys) {
  for (const key of keys) {
    if (offline.has("/" + key)) continue;
    offline.add("/" + key);
    walk(outputs[key].imports.filter((i) => i.kind === "import-statement" && outputs[i.path]).map((i) => i.path));
  }
})(Object.keys(outputs).filter((o) => OFFLINE_PAGES.includes(outputs[o].entryPoint)));
if (!OFFLINE_PAGES.every((p) => Object.values(outputs).some((o) => o.entryPoint === p))) {
  throw new Error("an OFFLINE_PAGES entry is no longer lazily imported");
}

// Which output file each source file ended up in. scripts/smoke_test.py uses
// it to run its "is this module loaded on that page" checks against the
// bundle. Not served (middleware.js blocks /build/).
const sourceMap = {
  "/css/main.css": appCss, "/css/components.css": appCss, "/css/coach.css": coachCss,
  "/js/va.js": vaUrl, "/js/ga.js": gaUrl,
  "/js/vendor/supabase-js-2.45.4.js": shimUrl, "/js/vendor/supabase-js-2.45.4.umd.js": umdUrl,
};
for (const [out, info] of Object.entries(outputs)) {
  for (const src of Object.keys(info.inputs || {})) sourceMap["/" + src] = "/" + out;
}
writeFileSync(join(ROOT, "build", "meta.json"), JSON.stringify({ sourceMap }, null, 1));

// ── 4. HTML ─────────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "assets", "build", ".git", "partials", "scripts", "docs", "api-backup", "edge", ".github"]);
function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* htmlFiles(p); }
    else if (name.endsWith(".html")) yield p;
  }
}
const preloads = coreChunks.map((u) => `<link rel="modulepreload" href="${u}" />`).join("\n  ");
let pages = 0;
for (const file of htmlFiles(ROOT)) {
  const before = readFileSync(file, "utf8");
  if (!before.includes('"/js/app.js"') && !before.includes('"/css/main.css"')) continue;
  let html = before
    // components.css now lives inside app.css (incl. app-shell's preload + noscript copy)
    .replace(/[ \t]*<noscript><link rel="stylesheet" href="\/css\/components\.css" \/><\/noscript>\r?\n?/g, "")
    .replace(/[ \t]*<link rel="(?:stylesheet|preload)" href="\/css\/components\.css"[^>]*>\r?\n?/g, "")
    .replaceAll('href="/css/main.css"', `href="${appCss}"`)
    .replaceAll('href="/css/coach.css"', `href="${coachCss}"`)   // chat.html styles the coach up front
    .replaceAll('src="/js/va.js"', `src="${vaUrl}"`)
    .replaceAll('src="/js/ga.js"', `src="${gaUrl}"`)
    .replace(/<link rel="preload" href="\/js\/app\.js" as="script" crossorigin \/>/,
      `<link rel="modulepreload" href="${appJs}" />` + (preloads ? "\n  " + preloads : ""))
    .replaceAll('"/js/app.js"', `"${appJs}"`);
  const leftover = html.match(/"\/(?:js\/(?:app|va|ga)\.js|css\/(?:main|components|coach)\.css)"/);
  if (leftover) throw new Error(`${urlOf(file)} still references ${leftover[0]}`);
  writeFileSync(file, html);
  pages++;
}

// ── 5. Service worker ───────────────────────────────────────────────────────
const assets = readdirSync(OUT).map((n) => "/assets/" + n).sort();
// Build id: changes whenever anything the worker serves cache-first could
// have changed — the asset names, the data index files (the daily universe
// refresh) and the unhashed icons/manifest. A new id makes browsers install
// the new worker, which starts a fresh cache for those unhashed files.
const idHash = createHash("sha256").update(assets.join("\n"));
const unhashed = ["manifest.json", "logo.svg", "favicon.ico", "og-image.svg",
  "js/data/universeFull.meta.json", "js/data/mfFull.meta.json"];
function addTree(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) addTree(p);
    else idHash.update(urlOf(p)).update(readFileSync(p));
  }
}
for (const f of unhashed) if (existsSync(join(ROOT, f))) idHash.update(f).update(readFileSync(join(ROOT, f)));
if (existsSync(join(ROOT, "images"))) addTree(join(ROOT, "images"));
const build = {
  id: idHash.digest("hex").slice(0, 10),
  core: [...new Set([appJs, ...coreChunks, appCss, vaUrl, gaUrl, shimUrl, umdUrl, ...offline])],
  assets,
};
const swPath = join(ROOT, "sw.js");
const sw = readFileSync(swPath, "utf8");
const marker = "const BUILD = null;";
if (!sw.includes(marker)) throw new Error("sw.js: BUILD marker missing");
writeFileSync(swPath, sw.replace(marker, `const BUILD = ${JSON.stringify(build)};`));

const kb = (n) => (n / 1024).toFixed(0) + " KB";
const size = (u) => statSync(join(ROOT, u.slice(1))).size;
console.log(`bundle: ${pages} pages rewritten, ${assets.length} assets, build ${build.id}`);
console.log(`  core: ${build.core.length} files, ${kb(build.core.reduce((s, u) => s + size(u), 0))}`);
console.log(`  all:  ${kb(assets.reduce((s, u) => s + size(u), 0))}`);
