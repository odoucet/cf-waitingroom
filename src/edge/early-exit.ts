// SPDX-License-Identifier: Apache-2.0
//
// Early exit for what routes cannot express (file extensions scattered in the
// tree). Evaluated before any I/O, compiled once per isolate.
//
// The path is the only input, so the early exit is limited to reads and
// refused for path forms that some origins resolve to a dynamic page:
// "/index.php/x.css" (PATH_INFO), "/cart;.js" and "/static/..;/cart" (path
// parameters, Tomcat/Spring), encoded slashes or backslashes. Never under /__wr/
// (waiting-room endpoints), and a prefix matches whole path segments only:
// "/static" covers "/static" and "/static/x", not "/static-checkout".

import type { EdgeEnv } from "./env.js";

interface Compiled {
  src: string;
  exts: Set<string>;
  /** Prefixes without trailing slash ("/static"), matched on segment boundaries. */
  prefixes: string[];
}

let compiled: Compiled | null = null;

function compile(env: EdgeEnv): Compiled {
  const src = `${env.EARLY_EXIT_EXTENSIONS ?? ""}|${env.EARLY_EXIT_PREFIXES ?? ""}`;
  if (compiled && compiled.src === src) return compiled;
  const split = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  compiled = {
    src,
    exts: new Set(split(env.EARLY_EXIT_EXTENSIONS).map((e) => e.replace(/^\./, "").toLowerCase())),
    prefixes: split(env.EARLY_EXIT_PREFIXES)
      .map((p) => p.replace(/\/+$/, ""))
      .filter((p) => p.startsWith("/") && p !== "/__wr" && !p.startsWith("/__wr/")),
  };
  return compiled;
}

const UNSAFE_PATH = /;|%2f|%5c|\.(?:php\d?|phtml|aspx?|jsp|cgi|pl|py)\//i;

/** True when the request must be relayed untouched (static asset). */
export function isEarlyExit(method: string, pathname: string, env: EdgeEnv): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname === "/__wr" || pathname.startsWith("/__wr/")) return false;
  const c = compile(env);
  if ((c.prefixes.length === 0 && c.exts.size === 0) || UNSAFE_PATH.test(pathname)) return false;
  for (const p of c.prefixes) if (pathname === p || pathname.startsWith(`${p}/`)) return true;
  if (c.exts.size === 0) return false;
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot <= slash) return false;
  return c.exts.has(pathname.slice(dot + 1).toLowerCase());
}
