/**
 * Reply-voice (TTS timbre) selection API.
 *
 * `GET /api/voices` lists the voices the engine can synthesize plus the
 * caller's current choice; `PUT /api/my/voice` sets the user's sticky default.
 * Both are per-tenant on the backend (see octos `api/voices.rs`).
 */
import { request } from "./client";

export interface VoiceInfo {
  id: string;
  aliases: string[];
}

export interface VoicesResponse {
  voices: VoiceInfo[];
  current: string;
}

export interface SetVoiceResponse {
  ok: boolean;
  voice: string;
}

/** List synthesizable voices and the caller's current reply voice. */
export async function getVoices(): Promise<VoicesResponse> {
  return request<VoicesResponse>("/api/voices");
}

/** Set the caller's sticky reply voice. Resolves to the canonical id. */
export async function setVoice(voice: string): Promise<SetVoiceResponse> {
  return request<SetVoiceResponse>("/api/my/voice", {
    method: "PUT",
    body: JSON.stringify({ voice }),
  });
}
