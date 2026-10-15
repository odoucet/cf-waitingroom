// SPDX-License-Identifier: Apache-2.0
//
// Worker entry point: the edge fetch handler and the Coordinator Durable Object
// class live in one script. Deploying it restarts the Durable Object (state is
// reloaded from SQLite, see docs/runbook.md): avoid it during traffic events.

export { default } from "./edge/index.js";
export { Coordinator } from "./coordinator/index.js";
