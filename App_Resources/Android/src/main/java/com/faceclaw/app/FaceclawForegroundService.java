package com.faceclaw.app;

import android.Manifest;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.tns.NativeScriptActivity;

public class FaceclawForegroundService extends Service {
    public static final String ACTION_START = "com.faceclaw.app.action.START";
    public static final String ACTION_UPDATE = "com.faceclaw.app.action.UPDATE";
    public static final String ACTION_STOP = "com.faceclaw.app.action.STOP";
    public static final String EXTRA_TEXT = "text";

    // Channel id was bumped from "faceclaw-dashboard" when the badge setting
    // changed: Android freezes a channel's showBadge flag at creation, so the
    // old channel (which let Samsung's launcher count the pinned notification
    // as a red "1" badge) is deleted on upgrade rather than reused.
    private static final String LEGACY_CHANNEL_ID = "faceclaw-dashboard";
    private static final String CHANNEL_ID = "faceclaw-connection";
    private static final int NOTIFICATION_ID = 4201;
    private static final String TAG = "FaceclawForeground";

    /** The types the service holds; just connectedDevice after a start from the background. */
    private int activeTypes = 0;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;

        if (ACTION_STOP.equals(action)) {
            activeTypes = 0;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        Notification notification = buildNotification(
                text != null && !text.trim().isEmpty() ? text : "Connected to glasses"
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForegroundAllowed(notification);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (ACTION_UPDATE.equals(action)) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_STICKY;
    }

    /**
     * Microphone and location are while-in-use permissions: Android 14+
     * refuses a foreground service those types unless the app is on screen
     * when it starts. The glasses reconnecting with the phone in a pocket
     * restarts this service, and the refusal used to crash Faceclaw, then
     * again on each relaunch. So ask for every type, and when that's refused
     * keep connectedDevice, which holds the glasses link; the next start or
     * update made while the app is on screen claims the rest. (G2 audio
     * comes over Bluetooth and needs no microphone type; the phone's own
     * mic does.)
     */
    private void startForegroundAllowed(Notification notification) {
        int wanted = foregroundServiceType();
        if (wanted != activeTypes && (activeTypes == 0 || onScreen())) {
            try {
                startForeground(NOTIFICATION_ID, notification, wanted);
                activeTypes = wanted;
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "foreground service types " + wanted + " refused, holding the glasses connection only: " + e.getMessage());
            }
        }
        int types = activeTypes != 0 ? activeTypes : ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        startForeground(NOTIFICATION_ID, notification, types);
        activeTypes = types;
    }

    private static boolean onScreen() {
        ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(info);
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Glasses connection",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps Faceclaw connected to the glasses.");
        // The pinned status notification must not count toward the launcher
        // icon's notification badge.
        channel.setShowBadge(false);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
            manager.deleteNotificationChannel(LEGACY_CHANNEL_ID);
        }
    }

    private Notification buildNotification(String text) {
        Intent launchIntent = new Intent(this, NativeScriptActivity.class);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("Faceclaw")
                .setContentText(text)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private int foregroundServiceType() {
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        // TODO: Make this depend on which audio path (G2 vs phone) is selected
        if (hasRecordAudioPermission()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        // The location type keeps while-in-use location flowing to the
        // Navigate app when the phone screen locks. Only claimed once the
        // permission exists: on API 34+ claiming it without the permission
        // makes startForeground throw.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasFineLocationPermission()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        return type;
    }

    private boolean hasRecordAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasFineLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }
}
