import { afterEach, describe, expect, it } from "vitest";

import { buildAuthenticatedFileUrl, buildFileUrl } from "@/api/files";
import { TOKEN_KEY } from "@/lib/constants";

afterEach(() => {
  localStorage.removeItem(TOKEN_KEY);
});

describe("buildFileUrl", () => {
  it("includes session context for workspace-relative upload paths", () => {
    expect(
      buildFileUrl("uploads/video-1782874133859.webm", {
        sessionId: "web-1782873684428-f5emdc",
      }),
    ).toBe(
      "/api/files?path=uploads%2Fvideo-1782874133859.webm&session=web-1782873684428-f5emdc",
    );
  });

  it("keeps legacy file paths on the path endpoint", () => {
    expect(
      buildFileUrl("skill-output/report.md", {
        sessionId: "web-1782873684428-f5emdc",
      }),
    ).toBe("/api/files/skill-output%2Freport.md");
  });

  it("includes session context for opaque workspace handles", () => {
    expect(
      buildFileUrl("ws/cXVpei5tZA/quiz.md", { sessionId: "web-abc" }),
    ).toBe(
      "/api/files?path=ws%2FcXVpei5tZA%2Fquiz.md&session=web-abc",
    );
  });

  it("uses the query endpoint for absolute workspace artifact paths", () => {
    expect(
      buildFileUrl(
        "/Users/alan0x/.octos/profiles/alan0x/data/users/web-abc/workspace/notebook-outputs/study/quiz/quiz.md",
        { sessionId: "web-abc" },
      ),
    ).toBe("/api/files?path=%2FUsers%2Falan0x%2F.octos%2Fprofiles%2Falan0x%2Fdata%2Fusers%2Fweb-abc%2Fworkspace%2Fnotebook-outputs%2Fstudy%2Fquiz%2Fquiz.md&session=web-abc");
  });

  it("appends auth tokens after existing session query parameters", () => {
    localStorage.setItem(TOKEN_KEY, "abc 123");

    expect(
      buildAuthenticatedFileUrl("uploads/video.webm", {
        sessionId: "web-1",
      }),
    ).toBe("/api/files?path=uploads%2Fvideo.webm&session=web-1&token=abc%20123");
  });
});
