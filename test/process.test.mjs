import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHttpCaller } from "../lib/process.mjs";

describe("createHttpCaller", () => {
  it("returns a function", () => {
    const caller = createHttpCaller({
      baseUrl: "http://localhost:9999/v1",
      model: "test-model",
      apiKey: "test-key",
    });
    assert.equal(typeof caller, "function");
  });

  it("rejects on connection error", async () => {
    const caller = createHttpCaller({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      apiKey: "test-key",
      timeoutMs: 2000,
      log: () => {},
    });

    await assert.rejects(
      () => caller("test system prompt", "test user prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});
