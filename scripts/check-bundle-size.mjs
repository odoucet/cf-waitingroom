// SPDX-License-Identifier: Apache-2.0
//
// Builds the Worker with `wrangler deploy --dry-run` and fails when the bundle
// (main module + text modules, minified, source maps excluded) exceeds 250 KiB.
// Cloudflare allows far more; this only catches a dependency pulled in by mistake.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const LIMIT = 250 * 1024;
const configs = { waitingroom: "wrangler/waitingroom.example.jsonc" };
let failed = false;

for (const [name, config] of Object.entries(configs)) {
  const out = mkdtempSync(join(tmpdir(), `wr-size-${name}-`));
  try {
    execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--config", config, "--outdir", out], { stdio: "pipe" });
    let raw = 0;
    let gz = 0;
    for (const f of readdirSync(out)) {
      if (f.endsWith(".map") || f === "README.md") continue;
      const p = join(out, f);
      raw += statSync(p).size;
      gz += gzipSync(readFileSync(p)).length;
    }
    const ok = raw <= LIMIT;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${(raw / 1024).toFixed(1)} KiB (gzip ${(gz / 1024).toFixed(1)} KiB), limit ${LIMIT / 1024} KiB`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
