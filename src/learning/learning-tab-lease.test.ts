import { beforeEach, describe, expect, it } from "vitest";
import {
  LEARNING_LEASE_TTL_MS,
  acquireLearningTabLease,
  getLearningTabOwner,
  releaseLearningTabLease,
  renewLearningTabLease,
} from "./learning-tab-lease";

describe("learning tab lease", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("allows only one live tab to own learning audio", () => {
    expect(acquireLearningTabLease("tab-a", 100)).toBe(true);
    expect(acquireLearningTabLease("tab-b", 101)).toBe(false);
    expect(renewLearningTabLease("tab-a", 200)).toBe(true);
    releaseLearningTabLease("tab-a");
    expect(acquireLearningTabLease("tab-b", 201)).toBe(true);
  });

  it("allows takeover after an abandoned lease expires", () => {
    acquireLearningTabLease("tab-a", 100);
    expect(
      acquireLearningTabLease("tab-b", 100 + LEARNING_LEASE_TTL_MS + 1),
    ).toBe(true);
  });

  it("keeps the lease owner stable across a browser refresh", () => {
    const first = getLearningTabOwner();
    const refreshed = getLearningTabOwner();

    expect(refreshed).toBe(first);
  });
});
