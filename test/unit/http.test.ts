// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { privateCacheControl } from "../../src/edge/http.js";

describe("privateCacheControl", () => {
  it("keeps browser caching but forbids shared caches", () => {
    expect(privateCacheControl("public, max-age=60")).toBe("private, max-age=60");
    expect(privateCacheControl("max-age=60, s-maxage=3600, proxy-revalidate")).toBe("private, max-age=60");
    expect(privateCacheControl(null)).toBe("private");
    expect(privateCacheControl("")).toBe("private");
    expect(privateCacheControl("no-store")).toBe("no-store");
    expect(privateCacheControl("Private, max-age=0")).toBe("Private, max-age=0");
    expect(privateCacheControl('private="Set-Cookie", max-age=60')).toBe('private, private="Set-Cookie", max-age=60');
  });
});
