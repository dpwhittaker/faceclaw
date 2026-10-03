package com.faceclaw.app;

import android.app.Notification;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Every notification worth a look, as JSON, the moment it's posted: what
 * Cue triages and turns into calendar events. Unlike the key lookups the
 * glasses' notification pop-ups use, this carries notifications from the
 * work profile too (Outlook, Teams), whose keys the listener can't look up
 * later. Ongoing notifications and group summaries are left out. While no
 * listener is registered (the app's UI hasn't started yet), the latest
 * BUFFERED notifications wait and go to the first listener.
 */
public final class FaceclawNotificationFeed {
    private static final String TAG = "FaceclawNotifyFeed";
    private static final int BUFFERED = 200;
    private static final int MAX_TEXT_CHARS = 8000;

    public interface Listener {
        void onNotification(String json);
    }

    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final CopyOnWriteArraySet<Listener> listeners = new CopyOnWriteArraySet<>();
    private static final ArrayDeque<String> pending = new ArrayDeque<>();

    private FaceclawNotificationFeed() {
    }

    public static void addListener(Listener listener) {
        if (listener == null) {
            return;
        }
        listeners.add(listener);
        String[] waiting;
        synchronized (pending) {
            waiting = pending.toArray(new String[0]);
            pending.clear();
        }
        for (String json : waiting) {
            deliver(listener, json);
        }
    }

    public static void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    static void posted(Context context, StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        if (notification == null) {
            return;
        }
        int skip = Notification.FLAG_ONGOING_EVENT | Notification.FLAG_NO_CLEAR | Notification.FLAG_GROUP_SUMMARY;
        if ((notification.flags & skip) != 0) {
            return;
        }
        String json;
        try {
            json = toJson(context, statusBarNotification).toString();
        } catch (Throwable t) {
            Log.w(TAG, "failed to serialize notification", t);
            return;
        }
        if (listeners.isEmpty()) {
            synchronized (pending) {
                pending.addLast(json);
                while (pending.size() > BUFFERED) {
                    pending.removeFirst();
                }
            }
            return;
        }
        for (Listener listener : listeners) {
            deliver(listener, json);
        }
    }

    private static void deliver(Listener listener, String json) {
        mainHandler.post(() -> {
            try {
                listener.onNotification(json);
            } catch (Throwable t) {
                Log.w(TAG, "notification feed listener failed", t);
            }
        });
    }

    private static JSONObject toJson(Context context, StatusBarNotification statusBarNotification) throws JSONException {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        JSONObject out = new JSONObject();
        out.put("key", statusBarNotification.getKey());
        // UserHandle.hashCode() is its user id: 0 for the personal profile.
        out.put("profile", statusBarNotification.getUser() == null ? 0 : statusBarNotification.getUser().hashCode());
        out.put("package", statusBarNotification.getPackageName());
        out.put("app", appLabel(context, statusBarNotification));
        out.put("postTime", statusBarNotification.getPostTime());
        out.put("when", notification.when);
        out.put("category", notification.category == null ? "" : notification.category);
        out.put("channelId", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notification.getChannelId() != null ? notification.getChannelId() : "");
        out.put("onlyAlertOnce", (notification.flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0);
        if (extras != null) {
            CharSequence bigTitle = extras.getCharSequence(Notification.EXTRA_TITLE_BIG);
            out.put("title", text(bigTitle != null && bigTitle.length() > 0 ? bigTitle : extras.getCharSequence(Notification.EXTRA_TITLE)));
            out.put("text", text(extras.getCharSequence(Notification.EXTRA_TEXT)));
            out.put("bigText", text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)));
            out.put("subText", text(extras.getCharSequence(Notification.EXTRA_SUB_TEXT)));
            out.put("conversationTitle", text(extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)));
            JSONArray lines = new JSONArray();
            CharSequence[] textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (textLines != null) {
                for (CharSequence line : textLines) {
                    String value = text(line);
                    if (!value.isEmpty()) {
                        lines.put(value);
                    }
                }
            }
            out.put("lines", lines);
            out.put("messages", messages(extras.getParcelableArray(Notification.EXTRA_MESSAGES)));
        }
        JSONArray actions = new JSONArray();
        if (notification.actions != null) {
            for (Notification.Action action : notification.actions) {
                if (action != null && action.title != null) {
                    actions.put(action.title.toString());
                }
            }
        }
        out.put("actions", actions);
        return out;
    }

    private static JSONArray messages(Parcelable[] parcelables) throws JSONException {
        JSONArray out = new JSONArray();
        if (parcelables == null) {
            return out;
        }
        for (Parcelable parcelable : parcelables) {
            if (!(parcelable instanceof Bundle)) {
                continue;
            }
            Bundle bundle = (Bundle) parcelable;
            CharSequence sender = bundle.getCharSequence("sender");
            if (sender == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Object person = bundle.get("sender_person");
                if (person instanceof android.app.Person) {
                    sender = ((android.app.Person) person).getName();
                }
            }
            JSONObject message = new JSONObject();
            message.put("sender", text(sender));
            message.put("text", text(bundle.getCharSequence("text")));
            message.put("time", bundle.getLong("time"));
            out.put(message);
        }
        return out;
    }

    private static String appLabel(Context context, StatusBarNotification statusBarNotification) {
        Bundle extras = statusBarNotification.getNotification().extras;
        String substitute = extras == null ? "" : text(extras.getCharSequence("android.substName"));
        if (!substitute.isEmpty()) {
            return substitute;
        }
        try {
            return text(context.getPackageManager().getApplicationLabel(
                    context.getPackageManager().getApplicationInfo(statusBarNotification.getPackageName(), 0)));
        } catch (Throwable t) {
            return statusBarNotification.getPackageName();
        }
    }

    private static String text(CharSequence value) {
        if (value == null) {
            return "";
        }
        String text = value.toString();
        return text.length() > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    }
}
