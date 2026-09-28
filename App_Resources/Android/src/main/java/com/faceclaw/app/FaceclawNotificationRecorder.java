package com.faceclaw.app;

import android.app.Notification;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Records every Outlook and Teams notification the listener sees, for Cue's
 * notification exploration: what work notifications carry (sender, subject,
 * preview, meeting reminders) and which profile posts them. One JSON object
 * per line, one file per day, in getExternalFilesDir()/cue-notifications/,
 * retrievable via
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/cue-notifications
 * Files older than RETAIN_DAYS are deleted. Every extra with a text or number
 * value is kept, so fields nobody knew to ask for still show up.
 */
final class FaceclawNotificationRecorder {
    private static final String TAG = "FaceclawNotifyRec";
    private static final String DIR = "cue-notifications";
    private static final int RETAIN_DAYS = 14;
    private static final int MAX_VALUE_CHARS = 2000;

    private static final ExecutorService writer = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "FaceclawNotifyRec");
        thread.setDaemon(true);
        return thread;
    });
    private static String lastPrunedDay = "";

    private FaceclawNotificationRecorder() {
    }

    static boolean shouldRecord(String packageName) {
        return packageName != null && packageName.startsWith("com.microsoft.");
    }

    /** Serializes on the caller's thread (the notification can change later) and writes on a worker. */
    static void record(Context context, StatusBarNotification statusBarNotification, String event) {
        if (context == null || statusBarNotification == null || !shouldRecord(statusBarNotification.getPackageName())) {
            return;
        }
        File dir = context.getExternalFilesDir(DIR);
        if (dir == null) {
            return;
        }
        String line;
        try {
            line = toJson(statusBarNotification, event).toString();
        } catch (Throwable t) {
            Log.w(TAG, "failed to serialize notification", t);
            return;
        }
        writer.execute(() -> append(dir, line));
    }

    private static void append(File dir, String line) {
        String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        if (!day.equals(lastPrunedDay)) {
            lastPrunedDay = day;
            prune(dir);
        }
        File file = new File(dir, day + ".jsonl");
        try (Writer out = new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8)) {
            out.write(line);
            out.write('\n');
        } catch (Throwable t) {
            Log.w(TAG, "failed to append " + file, t);
        }
    }

    private static void prune(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - RETAIN_DAYS * 24L * 60 * 60 * 1000;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < cutoff && !file.delete()) {
                Log.w(TAG, "failed to delete " + file);
            }
        }
    }

    private static JSONObject toJson(StatusBarNotification statusBarNotification, String event) throws JSONException {
        Notification notification = statusBarNotification.getNotification();
        JSONObject out = new JSONObject();
        out.put("event", event);
        out.put("recordedMs", System.currentTimeMillis());
        out.put("postTime", statusBarNotification.getPostTime());
        out.put("package", statusBarNotification.getPackageName());
        // UserHandle{0} is the personal profile; the work profile is another id.
        out.put("user", String.valueOf(statusBarNotification.getUser()));
        out.put("key", statusBarNotification.getKey());
        out.put("id", statusBarNotification.getId());
        out.put("tag", String.valueOf(statusBarNotification.getTag()));
        out.put("groupKey", String.valueOf(statusBarNotification.getGroupKey()));
        // A removal only needs to say which notification went away, and when.
        if (notification == null || "removed".equals(event)) {
            return out;
        }
        out.put("when", notification.when);
        out.put("category", String.valueOf(notification.category));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            out.put("channelId", String.valueOf(notification.getChannelId()));
        }
        out.put("flags", notification.flags);
        out.put("groupSummary", (notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0);
        out.put("visibility", notification.visibility);
        out.put("hasPublicVersion", notification.publicVersion != null);

        Bundle extras = notification.extras;
        if (extras != null) {
            out.put("extras", extrasToJson(extras));
        }

        JSONArray actions = new JSONArray();
        if (notification.actions != null) {
            for (Notification.Action action : notification.actions) {
                if (action != null) {
                    actions.put(truncate(String.valueOf(action.title)));
                }
            }
        }
        out.put("actions", actions);
        return out;
    }

    /** Text, number and boolean extras as is; MessagingStyle messages and text lines unpacked; the rest by type. */
    private static JSONObject extrasToJson(Bundle extras) throws JSONException {
        JSONObject out = new JSONObject();
        for (String key : extras.keySet()) {
            Object value;
            try {
                value = extras.get(key);
            } catch (Throwable t) {
                out.put(key, "<unreadable>");
                continue;
            }
            if (value == null) {
                continue;
            }
            if (Notification.EXTRA_MESSAGES.equals(key) || Notification.EXTRA_HISTORIC_MESSAGES.equals(key)) {
                out.put(key, messagesToJson(value));
            } else if (value instanceof CharSequence) {
                out.put(key, truncate(value.toString()));
            } else if (value instanceof CharSequence[]) {
                JSONArray lines = new JSONArray();
                for (CharSequence line : (CharSequence[]) value) {
                    lines.put(truncate(String.valueOf(line)));
                }
                out.put(key, lines);
            } else if (value instanceof Number || value instanceof Boolean) {
                out.put(key, value);
            } else {
                out.put(key, "<" + value.getClass().getSimpleName() + ">");
            }
        }
        return out;
    }

    private static JSONArray messagesToJson(Object value) throws JSONException {
        JSONArray out = new JSONArray();
        if (!(value instanceof Parcelable[])) {
            return out;
        }
        for (Parcelable parcelable : (Parcelable[]) value) {
            if (!(parcelable instanceof Bundle)) {
                continue;
            }
            Bundle bundle = (Bundle) parcelable;
            JSONObject message = new JSONObject();
            message.put("text", truncate(String.valueOf(bundle.getCharSequence("text"))));
            message.put("time", bundle.getLong("time"));
            CharSequence sender = bundle.getCharSequence("sender");
            if (sender == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Object person = bundle.get("sender_person");
                if (person instanceof android.app.Person) {
                    sender = ((android.app.Person) person).getName();
                }
            }
            message.put("sender", String.valueOf(sender));
            out.put(message);
        }
        return out;
    }

    private static String truncate(String value) {
        return value.length() > MAX_VALUE_CHARS ? value.substring(0, MAX_VALUE_CHARS) : value;
    }
}
