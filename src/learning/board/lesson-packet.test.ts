import { describe, expect, it } from "vitest";
import { QUADRATIC_DEMO_PACKET } from "./quadratic-demo";
import { parseLessonPacket } from "./lesson-packet";

describe("LessonPacketV1", () => {
  it("accepts the quadratic teaching fixture", () => {
    const result = parseLessonPacket(QUADRATIC_DEMO_PACKET);
    expect(result.errors).toEqual([]);
    expect(result.packet?.segments).toHaveLength(6);
  });

  it("rejects unknown actions and executable formula markup", () => {
    const unknown = structuredClone(QUADRATIC_DEMO_PACKET) as unknown as {
      segments: Array<{ actions: unknown[] }>;
    };
    unknown.segments[0].actions = [
      { id: "bad", type: "run_script", source: "alert(1)" },
    ];
    expect(parseLessonPacket(unknown).packet).toBeNull();

    const markup = structuredClone(QUADRATIC_DEMO_PACKET) as unknown as {
      segments: Array<{ actions: unknown[] }>;
    };
    markup.segments[0].actions = [
      {
        id: "bad-formula",
        type: "write_formula",
        latex: "<img src=x onerror=alert(1)>",
        at: { x: 0, y: 0 },
      },
    ];
    expect(parseLessonPacket(markup).packet).toBeNull();
  });

  it("rejects duplicate action ids", () => {
    const packet = structuredClone(QUADRATIC_DEMO_PACKET);
    packet.segments[1].actions[0].id =
      packet.segments[0].actions[0].id;
    expect(parseLessonPacket(packet).errors).toContain(
      `duplicate action id: ${packet.segments[0].actions[0].id}`,
    );
  });
});
