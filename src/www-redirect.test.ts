import { describe, expect, it } from "vitest";
import worker from "./www-redirect";

describe("www redirect", () => {
  it("preserves path and query while redirecting to the canonical host", () => {
    const response = worker.fetch(new Request("https://www.fanmap42.com/map/area?x=1&y=2"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://fanmap42.com/map/area?x=1&y=2");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});
