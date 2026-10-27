// SPDX-License-Identifier: Apache-2.0

import type { EdgeCounters } from "./types.js";

export function zeroEdgeCounters(): EdgeCounters {
  return {
    provisionalIssued: 0,
    provisionalClaimed: 0,
    waitingPages: 0,
    botBypass: 0,
    ipBypass: 0,
    headerBypass: 0,
    passBypass: 0,
    failOpen: 0,
    errTimeout: 0,
    errOverloaded: 0,
    errOther: 0,
    reserveTooEarly: 0,
    reservePowFailed: 0,
    reserveBusy: 0,
    reserveCrossSite: 0,
    reserveNoProvisional: 0,
    reserveTurnstileFailed: 0,
    sessionRefused: 0,
    ticketRefused: 0,
    passRefused: 0,
    bypassRefused: 0,
    workerRequests: 0,
    earlyExits: 0,
  };
}
