import { fetchWithUserAgent } from "../util/http";

declare const com: any;

/**
 * Soniox's async API, for re-transcribing a whole recording with speaker
 * diarization: upload through the Files API, create a transcription, poll
 * it, fetch its tokens, then delete both (Soniox holds at most 300 minutes
 * of audio, 10 GB and 1,000 files). Each step is its own call so a caller
 * can keep the ids and pick up where it left off after a restart.
 */

const BASE = "https://api.soniox.com";
export const SONIOX_ASYNC_MODEL = "stt-async-v5";

/** One token of a finished transcript: times are ms into the file. */
export type SonioxAsyncToken = { text: string; start_ms?: number; end_ms?: number; speaker?: string; confidence?: number };

export type SonioxAsyncStatus = { status: "queued" | "processing" | "completed" | "error"; error: string };

export type UploadResult = { status: number; body: string };

/**
 * Sends a file from disk as a request body (OkHttp streams it, so it never
 * passes through JS memory); multipartField sends it as that form field.
 */
export function uploadFile(method: "PUT" | "POST", url: string, authorization: string, path: string, contentType: string, multipartField = ""): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    com.faceclaw.app.FaceclawFileUpload.send(method, url, authorization, path, contentType, multipartField, new com.faceclaw.app.FaceclawFileUpload.Listener({
      onDone: (status: number, body: string) => resolve({ status: Number(status), body: String(body ?? "") }),
      onError: (message: string) => reject(new Error(String(message))),
    }));
  });
}

/** Uploads a recording; returns its file id. */
export async function sonioxUpload(apiKey: string, path: string, contentType: string): Promise<string> {
  const result = await uploadFile("POST", `${BASE}/v1/files`, `Bearer ${apiKey}`, path, contentType, "file");
  if (result.status >= 300) throw new Error(`Soniox upload: HTTP ${result.status} ${result.body.slice(0, 200)}`);
  return String(JSON.parse(result.body).id);
}

/** Starts transcribing an uploaded file with speaker labels; returns the transcription's id. */
export async function sonioxCreate(apiKey: string, fileId: string): Promise<string> {
  const created = await call(apiKey, "POST", "/v1/transcriptions", { model: SONIOX_ASYNC_MODEL, file_id: fileId, enable_speaker_diarization: true });
  return String(created.id);
}

export async function sonioxStatus(apiKey: string, transcriptionId: string): Promise<SonioxAsyncStatus> {
  const body = await call(apiKey, "GET", `/v1/transcriptions/${transcriptionId}`);
  const status = ["queued", "processing", "completed", "error"].includes(body.status) ? body.status : "processing";
  return { status, error: String(body.error_message ?? "") };
}

export async function sonioxTranscript(apiKey: string, transcriptionId: string): Promise<SonioxAsyncToken[]> {
  const body = await call(apiKey, "GET", `/v1/transcriptions/${transcriptionId}/transcript`);
  return Array.isArray(body.tokens) ? body.tokens : [];
}

/** Deletes a transcription and its file; already gone counts as done. */
export async function sonioxDelete(apiKey: string, transcriptionId: string, fileId: string): Promise<void> {
  for (const path of [transcriptionId && `/v1/transcriptions/${transcriptionId}`, fileId && `/v1/files/${fileId}`]) {
    if (!path) continue;
    const response = await fetchWithUserAgent(`${BASE}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok && response.status !== 404) throw new Error(`Soniox delete ${path}: HTTP ${response.status}`);
  }
}

async function call(apiKey: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetchWithUserAgent(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Soniox ${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
