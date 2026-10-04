declare const com: any;

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
