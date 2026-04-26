import type { Message } from "../message-store";
import type { CreateMessageId, Now } from "./shared";
import { withRuntime } from "./shared";

export interface CreateUserMessageEvent {
  type: "create_user_message";
  message: Omit<Message, "id" | "timestamp"> & { role: "user" };
  createId: CreateMessageId;
  now?: Now;
}

export function createLocalMessage(
  msg: Omit<Message, "id" | "timestamp">,
  createId: CreateMessageId,
  now: Now = Date.now,
): Message {
  return withRuntime({ ...msg, id: createId(), timestamp: now() }, {}, now);
}

export function reduceCreateUserMessageEvent(event: CreateUserMessageEvent): Message {
  return createLocalMessage(event.message, event.createId, event.now);
}
