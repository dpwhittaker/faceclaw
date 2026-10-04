package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Sends a file from disk as an HTTP request body, streamed by OkHttp so a
 * long recording never passes through JS memory: either the whole body
 * (PUT to Cue's backend) or one multipart/form-data field (Soniox's Files
 * API). The result comes back on the main thread.
 */
public final class FaceclawFileUpload {
    public interface Listener {
        /** Any HTTP status, with the response body as text. */
        void onDone(int status, String body);

        /** The request never got a response (no file, no network). */
        void onError(String message);
    }

    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static volatile OkHttpClient sharedClient;

    private FaceclawFileUpload() {
    }

    /**
     * method is PUT or POST; authorization is the whole header value ("Bearer ...")
     * or empty; multipartField empty sends the file as the body itself.
     */
    public static void send(String method, String url, String authorization, String filePath, String contentType,
                            String multipartField, Listener listener) {
        File file = new File(filePath);
        if (!file.isFile()) {
            mainHandler.post(() -> listener.onError("no file " + filePath));
            return;
        }
        RequestBody fileBody = RequestBody.create(file, MediaType.parse(contentType));
        RequestBody body = multipartField == null || multipartField.isEmpty()
            ? fileBody
            : new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart(multipartField, file.getName(), fileBody)
                .build();
        Request.Builder builder = new Request.Builder().url(url).method(method, body);
        if (authorization != null && !authorization.isEmpty()) {
            builder.header("Authorization", authorization);
        }
        Call call;
        try {
            call = client().newCall(builder.build());
        } catch (Throwable t) {
            mainHandler.post(() -> listener.onError(String.valueOf(t.getMessage())));
            return;
        }
        call.enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                mainHandler.post(() -> listener.onError(String.valueOf(e.getMessage())));
            }

            @Override
            public void onResponse(Call call, Response response) {
                int status = response.code();
                String text = "";
                try (ResponseBody responseBody = response.body()) {
                    if (responseBody != null) {
                        text = responseBody.string();
                    }
                } catch (IOException e) {
                    // The status is what matters.
                }
                String result = text;
                mainHandler.post(() -> listener.onDone(status, result));
            }
        });
    }

    private static OkHttpClient client() {
        OkHttpClient client = sharedClient;
        if (client == null) {
            synchronized (FaceclawFileUpload.class) {
                if (sharedClient == null) {
                    // An hour of audio is ~15 MB; a slow uplink needs minutes.
                    sharedClient = new OkHttpClient.Builder()
                        .connectTimeout(20, TimeUnit.SECONDS)
                        .writeTimeout(10, TimeUnit.MINUTES)
                        .readTimeout(2, TimeUnit.MINUTES)
                        .addInterceptor(FaceclawHttp.userAgentInterceptor())
                        .build();
                }
                client = sharedClient;
            }
        }
        return client;
    }
}
