// SPDX-License-Identifier: Apache-2.0
//
// Minifies the HTML pages, each made of a page (markup and style) and a script
// inlined in place of {{SCRIPT}}, into <dir>/generated/<page>.html:
//   - src/edge/templates/waiting.html + waiting.js.txt, imported by src/edge/waiting.ts;
//   - src/shared/templates/dashboard.html + dashboard.js.txt, imported by
//     src/shared/dashboard-template.ts.
// Wrangler imports text modules as they are, so this runs before every build:
// as the wrangler custom build of the Worker, and from vitest.config.ts for
// the tests. The output is git-ignored; it is only rewritten when it changes,
// so that `wrangler dev` does not rebuild in a loop.

import { transformSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const PAGES = [
  { dir: `${src}edge/templates/`, name: "waiting" },
  { dir: `${src}shared/templates/`, name: "dashboard" },
];

function buildPage({ dir, name }) {
  const script = transformSync(readFileSync(`${dir}${name}.js.txt`, "utf8"), { loader: "js", minify: true, target: "es2020" }).code.trim();
  // Placeholders are filled at runtime over the whole page, script included.
  if (/\{\{\w+\}\}/.test(script)) throw new Error(`${name}.js.txt: the minified script contains a {{placeholder}}`);
  const html = readFileSync(`${dir}${name}.html`, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/, (_, open, css, close) => open + transformSync(css, { loader: "css", minify: true }).code.trim() + close)
    .replace(/>\s+</g, "><")
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .replace("{{SCRIPT}}", () => script);
  if (html.includes("{{SCRIPT}}") || !html.includes("{{NONCE}}")) throw new Error(`${name}.html: unexpected placeholders`);
  const out = `${dir}generated/${name}.html`;
  mkdirSync(`${dir}generated`, { recursive: true });
  if (!existsSync(out) || readFileSync(out, "utf8") !== html) writeFileSync(out, html);
  return html.length;
}

export function buildTemplates() {
  return Object.fromEntries(PAGES.map((p) => [p.name, buildPage(p)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildTemplates();
