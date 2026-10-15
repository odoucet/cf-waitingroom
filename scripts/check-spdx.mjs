// SPDX-License-Identifier: Apache-2.0
//
// Fails when a source file lacks the SPDX license header.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "test", "scripts", "deploy", "wrangler", ".github"];
const EXT = /\.(ts|mjs|js|txt|html|jsonc|sh|ya?ml)$/;
// Generated files, and the build output of `wrangler dev` (git-ignored).
const SKIP = /worker-configuration\.d\.ts$|[\\/](generated|\.wrangler)[\\/]/;
const missing = [];

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXT.test(p) && !SKIP.test(p)) {
      const head = readFileSync(p, "utf8").split("\n").slice(0, 5).join("\n");
      if (!head.includes("SPDX-License-Identifier: Apache-2.0")) missing.push(p);
    }
  }
}

for (const r of ROOTS) walk(r);
if (missing.length > 0) {
  console.error(`Missing SPDX header:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log("SPDX headers: ok");
