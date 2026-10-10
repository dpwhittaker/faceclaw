package com.faceclaw.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Every notification worth a look, as JSON, the moment it's posted: what
 * Cue triages and turns into calendar events. Unlike the key lookups the
 * glasses' notification pop-ups use, this carries notifications from the
 * work profile too (Outlook, Teams), whose keys the listener can't look up
 * later. Ongoing notifications and group summaries are left out. While no
 * listener is registered (the app's UI hasn't started yet), the latest
 * BUFFERED notifications wait and go to the first listener.
 *
 * Each notification's actions are kept until it's removed, so the glasses
 * can answer it later (responses, respond): Cue offers them on the
 * notification's pop-up.
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
    private static final int HELD = 300;
    // The latest notifications' actions by key, least recently posted dropped first.
    private static final LinkedHashMap<String, Notification.Action[]> held = new LinkedHashMap<String, Notification.Action[]>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Notification.Action[]> eldest) {
            return size() > HELD;
        }
    };
    private static Context appContext;

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
        appContext = context.getApplicationContext();
        synchronized (held) {
            held.remove(statusBarNotification.getKey());
            if (notification.actions != null && notification.actions.length > 0) {
                held.put(statusBarNotification.getKey(), notification.actions);
            }
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

    /** The notification is gone: so are its responses. */
    static void removed(String key) {
        synchronized (held) {
            held.remove(key);
        }
    }

    /**
     * What the glasses can send back for a notification, as a JSON array of
     * {title, action, reply}: its buttons that act without opening an app
     * (reply null), the canned answers of its reply fields, and, for its
     * first free-form reply field, a {title, action, freeForm: true} for
     * replies Cue suggests followed by Android's suggested replies
     * (suggested: true). Empty once the notification is gone.
     */
    public static String responses(String key) {
        Notification.Action[] actions;
        synchronized (held) {
            actions = held.get(key);
        }
        JSONArray out = new JSONArray();
        if (actions == null) {
            return out.toString();
        }
        boolean freeFormSeen = false;
        try {
            for (int index = 0; index < actions.length; index++) {
                Notification.Action action = actions[index];
                if (action == null || action.actionIntent == null || action.title == null) {
                    continue;
                }
                String title = action.title.toString().trim();
                RemoteInput[] inputs = action.getRemoteInputs();
                if (inputs != null && inputs.length > 0) {
                    CharSequence[] choices = inputs[0].getChoices();
                    if (choices != null) {
                        for (CharSequence choice : choices) {
                            putResponse(out, title, index, choice).put("canned", true);
                        }
                    }
                    if (inputs[0].getAllowFreeFormInput() && !freeFormSeen) {
                        freeFormSeen = true;
                        putResponse(out, title, index, null).put("freeForm", true);
                        for (CharSequence reply : FaceclawMediaNotificationListenerService.smartReplies(key)) {
                            putResponse(out, title, index, reply).put("suggested", true);
                        }
                    }
                    continue;
                }
                // One that opens an app can't be done from the glasses.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && action.actionIntent.isActivity()) {
                    continue;
                }
                putResponse(out, title, index, null);
            }
        } catch (JSONException e) {
            Log.w(TAG, "failed to list notification responses", e);
        }
        return out.toString();
    }

    /** The action's reply field that takes typed text, if any. */
    private static RemoteInput freeFormInput(Notification.Action action) {
        RemoteInput[] inputs = action.getRemoteInputs();
        if (inputs == null) {
            return null;
        }
        for (RemoteInput input : inputs) {
            if (input != null && input.getAllowFreeFormInput()) {
                return input;
            }
        }
        return null;
    }

    private static JSONObject putResponse(JSONArray out, String title, int index, CharSequence reply) throws JSONException {
        JSONObject response = new JSONObject();
        response.put("title", title);
        response.put("action", index);
        response.put("reply", reply == null ? JSONObject.NULL : reply.toString());
        out.put(response);
        return response;
    }

    /**
     * Sends one of a notification's responses: its action, with the reply
     * text in its reply field (the first for one of its choices, the
     * free-form one for typed text). False when the notification is gone
     * or its app canceled the action.
     */
    public static boolean respond(String key, int index, String reply) {
        Notification.Action[] actions;
        synchronized (held) {
            actions = held.get(key);
        }
        Context context = appContext;
        if (actions == null || context == null || index < 0 || index >= actions.length || actions[index] == null || actions[index].actionIntent == null) {
            return false;
        }
        Notification.Action action = actions[index];
        try {
            if (reply == null || reply.isEmpty()) {
                action.actionIntent.send();
                return true;
            }
            RemoteInput[] inputs = action.getRemoteInputs();
            if (inputs == null || inputs.length == 0) {
                return false;
            }
            // One of the app's answers or Android's suggestions is a choice; anything else (Cue's) is typed.
            boolean choice = contains(inputs[0].getChoices(), reply)
                    || contains(FaceclawMediaNotificationListenerService.smartReplies(key).toArray(new CharSequence[0]), reply);
            RemoteInput input = choice ? inputs[0] : freeFormInput(action);
            if (input == null) {
                return false;
            }
            Intent fillIn = new Intent();
            Bundle results = new Bundle();
            results.putCharSequence(input.getResultKey(), reply);
            RemoteInput.addResultsToIntent(new RemoteInput[] { input }, fillIn, results);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                RemoteInput.setResultsSource(fillIn, choice ? RemoteInput.SOURCE_CHOICE : RemoteInput.SOURCE_FREE_FORM_INPUT);
            }
            action.actionIntent.send(context, 0, fillIn);
            return true;
        } catch (PendingIntent.CanceledException e) {
            Log.w(TAG, "notification response was canceled", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to send notification response", t);
            return false;
        }
    }

    private static boolean contains(CharSequence[] choices, String reply) {
        if (choices == null) {
            return false;
        }
        for (CharSequence choice : choices) {
            if (choice != null && reply.contentEquals(choice)) {
                return true;
            }
        }
        return false;
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
        boolean replyable = false;
        if (notification.actions != null) {
            for (Notification.Action action : notification.actions) {
                if (action != null && action.title != null) {
                    actions.put(action.title.toString());
                    replyable |= freeFormInput(action) != null;
                }
            }
        }
        out.put("actions", actions);
        // It can be answered by typing: Cue has Claude suggest replies.
        out.put("replyable", replyable);
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
