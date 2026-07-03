// Typed wrapper around the Rust translate command. The provider config
// (endpoint/model/targetLang) is non-secret and lives in the settings store;
// the local OpenAI-compatible provider (Ollama) needs no key.
import { Channel, invoke } from "@tauri-apps/api/core";

export type TranslationError =
  | { kind: "network"; message: string }
  | { kind: "parse"; message: string }
  | { kind: "config"; message: string };

// Progress ticks streamed from the backend as batches complete.
export interface TranslateProgress {
  done: number;
  total: number;
}

export const translate = {
  /**
   * Translate a flat list of text segments into `targetLang` via an
   * OpenAI-compatible chat endpoint. Resolves to a list the SAME length/order as
   * `texts` (untranslatable segments come back as their original text). Rejects
   * with a TranslationError on a transport/config failure. `onProgress` (if
   * given) fires after each batch with the running done/total segment count.
   */
  segments(
    endpoint: string,
    model: string,
    targetLang: string,
    texts: string[],
    onProgress?: (p: TranslateProgress) => void
  ): Promise<string[]> {
    const channel = new Channel<TranslateProgress>();
    if (onProgress) channel.onmessage = onProgress;
    return invoke<string[]>("translate_segments", {
      endpoint,
      model,
      targetLang,
      texts,
      onProgress: channel,
    });
  },
};

/** Best-effort human-readable message from a rejected translate command. */
export function describeTranslationError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
