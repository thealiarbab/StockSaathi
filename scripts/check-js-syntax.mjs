#!/usr/bin/env node
// Syntax-check every ES module under js/ — PARSE ONLY, never execute.
//
// Run with:  node --experimental-vm-modules scripts/check-js-syntax.mjs
//
// WHY THIS EXISTS
// `node --check` does NOT reliably catch syntax errors in ES modules: it
// parses as a script, so module-only constructs and some malformed literals
// sail straight through. On 2026-09-13 exactly that shipped to production —
// a double-quoted string split across two lines in js/pages/chat.js passed
// `node --check`, deployed, and took the whole /chat page down with
// "Uncaught SyntaxError: Invalid or unexpected token". A module that fails to
// parse simply never runs, so there is no stack trace pointing at it and no
// test that fails; the page is just blank.
//
// Dynamic `import()` would catch it, but import EXECUTES the module — these
// files start timers and network calls at module scope, so the checker hangs.
// vm.SourceTextModule compiles (and therefore parses) without evaluating,
// which is exactly and only what we want.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

if (typeof SourceTextModule !== "function") {
  console.error("Re-run with --experimental-vm-modules (vm.SourceTextModule unavailable).");
  process.exit(2);
}

const targets = [path.join(ROOT, "js")];
for (const extra of ["sw.js"]) {
  try { statSync(path.join(ROOT, extra)); targets.push(path.join(ROOT, extra)); } catch {}
}

const files = [];
for (const t of targets) {
  if (statSync(t).isDirectory()) walk(t, files);
  else files.push(t);
}
files.sort();

const broken = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  try {
    // Constructing compiles the source. No link(), no evaluate().
    new SourceTextModule(src, { identifier: file });
  } catch (e) {
    broken.push({ file: path.relative(ROOT, file), msg: e.message });
  }
}

if (broken.length) {
  console.error(`\nSYNTAX ERRORS in ${broken.length} file(s):\n`);
  for (const b of broken) console.error(`  ${b.file}\n    ${b.msg}\n`);
  process.exit(1);
}
console.log(`js syntax OK — ${files.length} files parsed`);
