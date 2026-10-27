// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { logLine } from "../../src/shared/log.js";

describe("logLine", () => {
  it("summarises scalar and array fields in message", () => {
    const l = logLine("info", "admit", { room: "main", path: "lease", ticketNo: undefined });
    expect(l).toEqual({ message: "admit room=main path=lease", event: "admit", level: "info", room: "main", path: "lease", ticketNo: undefined });
    expect(logLine("info", "admin_request", { keys: ["mode", "rate"], nested: { a: 1 } }).message).toBe("admin_request keys=mode,rate");
  });
});
