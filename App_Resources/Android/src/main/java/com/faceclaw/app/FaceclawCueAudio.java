package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.RandomAccessFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Cue's audio work, off the main thread: voice-prints of pooled live speech
 * or of ranges of a recorded 16 kHz mono WAV, with the speaker-embedding
 * model Microphones downloads (FaceclawSpeakerId, WeSpeaker CAM++), and
 * repairing a recording's header after a crash. One worker thread, the
 * model loaded once; results come back on the main thread.
 */
public final class FaceclawCueAudio {
    private static final String TAG = "FaceclawCueAudio";
    private static final int SAMPLE_RATE = 16000;
    private static final int WAV_HEADER_BYTES = 44;
    /** Longer audio adds little to an embedding and costs time. */
    private static final int MAX_EMBED_BYTES = SAMPLE_RATE * 2 * 20;

    public interface Listener {
        /** embedding is null when the audio was too short or the model failed. */
        void onEmbedding(String id, float[] embedding);
    }

    public interface RangesListener {
        /** One embedding per range, in order; null entries for ranges that failed. */
        void onEmbeddings(String id, float[][] embeddings);
    }

    private static final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "FaceclawCueAudio");
        thread.setDaemon(true);
        thread.setPriority(Thread.MIN_PRIORITY);
        return thread;
    });
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static FaceclawSpeakerId speakerId;
    private static String loadedPath;

    private FaceclawCueAudio() {
    }

    /**
     * pcm16le is a JS ArrayBuffer marshalled as a ByteBuffer over JS memory:
     * it is copied here, on the caller's thread, before the worker runs.
     */
    public static void embed(String modelPath, String id, java.nio.ByteBuffer pcm, Listener listener) {
        byte[] pcm16le = new byte[pcm.remaining()];
        pcm.get(pcm16le);
        worker.execute(() -> {
            float[] embedding = embedNow(modelPath, pcm16le);
            mainHandler.post(() -> listener.onEmbedding(id, embedding));
        });
    }

    /** Embeds each [startMs[i], endMs[i]) of a WAV written by FaceclawWavRecorder (16 kHz mono, 44-byte header). */
    public static void embedRanges(String modelPath, String id, String wavPath, long[] startMs, long[] endMs, RangesListener listener) {
        worker.execute(() -> {
            float[][] out = new float[startMs.length][];
            try (RandomAccessFile file = new RandomAccessFile(wavPath, "r")) {
                long dataBytes = file.length() - WAV_HEADER_BYTES;
                for (int i = 0; i < startMs.length; i++) {
                    long from = Math.max(0, startMs[i]) * SAMPLE_RATE / 1000 * 2;
                    long to = Math.min(dataBytes, endMs[i] * SAMPLE_RATE / 1000 * 2);
                    if (to - from < SAMPLE_RATE) {
                        continue;
                    }
                    byte[] pcm = new byte[(int) Math.min(to - from, MAX_EMBED_BYTES)];
                    file.seek(WAV_HEADER_BYTES + from);
                    file.readFully(pcm);
                    out[i] = embedNow(modelPath, pcm);
                }
            } catch (Throwable t) {
                Log.w(TAG, "failed to read " + wavPath, t);
            }
            mainHandler.post(() -> listener.onEmbeddings(id, out));
        });
    }

    /**
     * A WAV FaceclawWavRecorder never finished (the app died mid-conversation)
     * still says it holds no audio: rewrite its header from the file's length.
     * Returns the audio's length in ms.
     */
    public static long repairWav(String wavPath) {
        try (RandomAccessFile file = new RandomAccessFile(wavPath, "rw")) {
            long dataBytes = Math.max(0, file.length() - WAV_HEADER_BYTES);
            dataBytes -= dataBytes % 2;
            file.seek(0);
            file.write(BinaryEncoding.wavHeader((int) Math.min(dataBytes, Integer.MAX_VALUE), SAMPLE_RATE, 1));
            return dataBytes * 1000 / (SAMPLE_RATE * 2);
        } catch (Throwable t) {
            Log.w(TAG, "couldn't repair " + wavPath, t);
            return 0;
        }
    }

    private static float[] embedNow(String modelPath, byte[] pcm16le) {
        try {
            if (speakerId == null || !modelPath.equals(loadedPath)) {
                if (speakerId != null) {
                    speakerId.close();
                }
                speakerId = new FaceclawSpeakerId(modelPath);
                loadedPath = modelPath;
            }
            if (!speakerId.ensureLoaded()) {
                return null;
            }
            byte[] pcm = pcm16le.length > MAX_EMBED_BYTES ? java.util.Arrays.copyOf(pcm16le, MAX_EMBED_BYTES) : pcm16le;
            return speakerId.embed(pcm, SAMPLE_RATE);
        } catch (Throwable t) {
            Log.w(TAG, "embedding failed", t);
            return null;
        }
    }
}
