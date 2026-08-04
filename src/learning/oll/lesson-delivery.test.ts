import { describe, expect, it } from "vitest";
import { isLessonDeliverySettled } from "./lesson-delivery";

describe("incremental lesson delivery", () => {
  it("settles only after a waiting classroom has received every known event", () => {
    expect(
      isLessonDeliverySettled(
        { completed: false, waiting: true },
        true,
      ),
    ).toBe(false);
    expect(
      isLessonDeliverySettled(
        { completed: false, waiting: true },
        false,
      ),
    ).toBe(true);
  });

  it("keeps active playback owned and treats a closed classroom as settled", () => {
    expect(
      isLessonDeliverySettled(
        { completed: false, waiting: false },
        false,
      ),
    ).toBe(false);
    expect(
      isLessonDeliverySettled(
        { completed: true, waiting: false },
        true,
      ),
    ).toBe(true);
  });
});
