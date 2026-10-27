// SPDX-License-Identifier: Apache-2.0
//
// Log line shape shared by the edge and the coordinator. Workers Logs shows
// `message` in its event list: without it, structured lines look empty.

export type LogLevel = "info" | "warn" | "error";

/** Builds `{ message, event, level, ...fields }`, `message` summarising the scalar fields. */
export function logLine(level: LogLevel, event: string, fields: Record<string, unknown>): Record<string, unknown> {
  const parts = [event];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) parts.push(`${k}=${v.join(",")}`);
    else if (typeof v !== "object") parts.push(`${k}=${String(v)}`);
  }
  return { message: parts.join(" "), event, level, ...fields };
}

/** Writes a log line on the console method matching its level. */
export function writeLog(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const line = logLine(level, event, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
