// Typed wrapper around the net_fetch tauri command (src-tauri/src/net.rs).
// Body crosses IPC as base64 for JSON safety; convenience helpers decode to
// ArrayBuffer / string with charset hint from content-type.

import { invoke } from "@tauri-apps/api/core";

export interface FetchRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "PATCH";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface RawFetchResponse {
  status: number;
  headers: [string, string][];
  finalUrl: string;
  bodyBase64: string;
}

export interface BytesResponse {
  status: number;
  headers: [string, string][];
  finalUrl: string;
  body: ArrayBuffer;
}

export interface TextResponse {
  status: number;
  headers: [string, string][];
  finalUrl: string;
  contentType: string | null;
  body: string;
}

function findHeader(headers: [string, string][], key: string): string | null {
  const lower = key.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  if (!b64) return new ArrayBuffer(0);
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

export const net = {
  fetch: (input: FetchRequest) =>
    invoke<RawFetchResponse>("net_fetch", { input }),

  async fetchBytes(input: FetchRequest): Promise<BytesResponse> {
    const resp = await this.fetch(input);
    return {
      status: resp.status,
      headers: resp.headers,
      finalUrl: resp.finalUrl,
      body: base64ToArrayBuffer(resp.bodyBase64),
    };
  },

  async fetchText(input: FetchRequest): Promise<TextResponse> {
    const resp = await this.fetchBytes(input);
    const contentType = findHeader(resp.headers, "content-type");
    const charsetMatch = contentType?.match(/charset=([^;\s]+)/i);
    const charset = charsetMatch ? charsetMatch[1] : "utf-8";
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset, { fatal: false });
    } catch {
      decoder = new TextDecoder("utf-8", { fatal: false });
    }
    return {
      status: resp.status,
      headers: resp.headers,
      finalUrl: resp.finalUrl,
      contentType,
      body: decoder.decode(resp.body),
    };
  },
};
