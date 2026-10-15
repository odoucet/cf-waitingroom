// SPDX-License-Identifier: Apache-2.0
//
// Operator hostnames (ADMIN_HOSTS). When set, the administration API, the
// metrics and the dashboard are served on these hostnames only (typically the
// script's workers.dev hostname), and these hostnames serve nothing else. Cloudflare picks the zone, then the route or the
// workers.dev script, from the requested hostname: a request routed through the
// site's zone never carries a workers.dev hostname.

import type { EdgeEnv } from "./env.js";

let hosts: Set<string> | null = null;
let hostsSrc: string | undefined;

function adminHosts(env: EdgeEnv): Set<string> {
  if (hosts === null || hostsSrc !== env.ADMIN_HOSTS) {
    hosts = new Set(
      (env.ADMIN_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ""),
    );
    hostsSrc = env.ADMIN_HOSTS;
  }
  return hosts;
}

/** True when operator endpoints are restricted to ADMIN_HOSTS. */
export function adminHostsSet(env: EdgeEnv): boolean {
  return adminHosts(env).size > 0;
}

/** True when `hostname` (lower case, as given by URL) is an operator hostname. */
export function isAdminHost(hostname: string, env: EdgeEnv): boolean {
  return adminHosts(env).has(hostname);
}
