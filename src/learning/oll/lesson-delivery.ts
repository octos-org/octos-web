export interface IncrementalLessonDeliveryState {
  completed: boolean;
  waiting: boolean;
}

/**
 * An incremental classroom remains open so future turns can append lessons.
 * `waiting` means the current delivery is caught up only after every known
 * Canonical event has been handed to the Runtime; `completed` is reserved for
 * a permanently closed classroom.
 */
export function isLessonDeliverySettled(
  lesson: IncrementalLessonDeliveryState,
  hasUndeliveredEvents: boolean,
): boolean {
  return lesson.completed || (lesson.waiting && !hasUndeliveredEvents);
}
