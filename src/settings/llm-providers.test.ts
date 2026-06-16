import { describe, it, expect } from "vitest";
import {
  buildCredentialEnvPatch,
  findProvider,
  usesJsonCredential,
} from "./llm-providers";

describe("vertex provider entry", () => {
  it("is registered and uses a JSON credential", () => {
    const vertex = findProvider("vertex");
    expect(vertex).toBeDefined();
    expect(vertex?.envKey).toBe("VERTEX_SA_JSON");
    expect(usesJsonCredential(vertex)).toBe(true);
  });

  it("treats normal providers as single-line API keys", () => {
    expect(usesJsonCredential(findProvider("openai"))).toBe(false);
    expect(usesJsonCredential(findProvider("google"))).toBe(false);
  });
});

describe("buildCredentialEnvPatch", () => {
  const vertex = findProvider("vertex");
  const openai = findProvider("openai");

  it("overlays the JSON onto existing env vars", () => {
    const patch = buildCredentialEnvPatch(
      vertex,
      { OPENAI_API_KEY: "abcd***xyz" },
      '{"project_id":"p"}',
    );
    expect(patch).toEqual({
      OPENAI_API_KEY: "abcd***xyz",
      VERTEX_SA_JSON: '{"project_id":"p"}',
    });
  });

  it("returns undefined for a blank input (keep what's stored)", () => {
    expect(buildCredentialEnvPatch(vertex, {}, "   ")).toBeUndefined();
  });

  it("returns undefined for non-JSON providers", () => {
    expect(buildCredentialEnvPatch(openai, {}, '{"x":1}')).toBeUndefined();
  });
});
