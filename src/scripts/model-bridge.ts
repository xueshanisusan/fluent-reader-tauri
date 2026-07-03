// Typed wrappers around the Rust local-model commands (Phase 2a). These manage
// the app-owned translation runtime: a curated GGUF download + a llama.cpp
// `server` process the app spawns itself. The model config is non-secret and the
// runtime endpoint is ephemeral (random port per session), so nothing here
// touches the settings store beyond the provider choice.
import { Channel, invoke } from "@tauri-apps/api/core"

export type ModelError =
  | { kind: "notFound"; message: string }
  | { kind: "disk"; message: string }
  | { kind: "download"; message: string }
  | { kind: "verify"; message: string }
  | { kind: "io"; message: string }

export type RuntimeError =
  | { kind: "notInstalled"; message: string }
  | { kind: "spawn"; message: string }
  | { kind: "health"; message: string }
  | { kind: "port"; message: string }

// Mirrors src-tauri/src/llm/catalog.rs::CuratedModel.
export interface CuratedModel {
  id: string
  name: string
  url: string
  file: string
  sizeBytes: number
  quant: string
  license: string
  sha256?: string
}

// Mirrors src-tauri/src/llm/manifest.rs::InstalledModel.
export interface InstalledModel {
  id: string
  name: string
  file: string
  sizeBytes: number
  sha256?: string
  source: string
}

// Mirrors src-tauri/src/llm/mod.rs::ModelStatus.
export interface ModelStatus {
  installed: InstalledModel | null
  running: boolean
  endpoint: string | null
  defaultModelId: string
}

// Mirrors src-tauri/src/llm/download.rs::DownloadProgress.
export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
  phase: "downloading" | "verifying"
}

export const model = {
  catalog(): Promise<CuratedModel[]> {
    return invoke<CuratedModel[]>("model_catalog")
  },

  status(): Promise<ModelStatus> {
    return invoke<ModelStatus>("model_status")
  },

  /**
   * Download a curated model by id, reporting progress via `onProgress`.
   * Resolves when the file is downloaded, verified, and recorded.
   */
  download(id: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
    const channel = new Channel<DownloadProgress>()
    channel.onmessage = onProgress
    return invoke<void>("model_download", { id, onProgress: channel })
  },

  /** Import a local .gguf the user already has. */
  import(path: string): Promise<InstalledModel> {
    return invoke<InstalledModel>("model_import", { path })
  },

  /** Ensure the sidecar is up; returns the local OpenAI-compatible endpoint. */
  runtimeStart(): Promise<string> {
    return invoke<string>("runtime_start")
  },

  runtimeStop(): Promise<void> {
    return invoke<void>("runtime_stop")
  },
}

/** Best-effort human-readable message from a rejected model/runtime command. */
export function describeModelError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message)
  }
  return String(e)
}
