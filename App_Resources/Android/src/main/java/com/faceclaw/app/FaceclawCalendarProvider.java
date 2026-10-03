package com.faceclaw.app;

import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reads upcoming events from the Android Calendar provider for the Calendar
 * app. Queries the Instances table (rather than Events) so that recurring
 * events are expanded into concrete occurrences within the requested window.
 * Requires the READ_CALENDAR runtime permission; without it the content
 * resolver throws SecurityException and this returns an empty array.
 */
public final class FaceclawCalendarProvider {
    private static final String TAG = "FaceclawCalendar";

    private static final String[] PROJECTION = {
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
    };

    // PROJECTION plus the columns Cue needs to pick and describe a meeting:
    // Events and Calendars columns that Instances documents. The sync columns
    // (_SYNC_ID, ACCOUNT_NAME) come from the Events and Calendars tables,
    // which document them; Samsung's provider also exposes them on Instances,
    // but that isn't promised.
    private static final String[] DETAIL_PROJECTION = {
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
            CalendarContract.Instances.DESCRIPTION,
            CalendarContract.Instances.ORGANIZER,
            CalendarContract.Instances.SELF_ATTENDEE_STATUS,
            CalendarContract.Instances.STATUS,
            CalendarContract.Instances.RRULE,
            CalendarContract.Instances.ORIGINAL_ID,
            CalendarContract.Instances.ORIGINAL_SYNC_ID,
            CalendarContract.Instances.ORIGINAL_INSTANCE_TIME,
            CalendarContract.Instances.CALENDAR_ID,
            CalendarContract.Instances.OWNER_ACCOUNT,
    };

    // Teams invites carry long join boilerplate; Cue needs the agenda at the top.
    private static final int MAX_DESCRIPTION_CHARS = 4000;

    private FaceclawCalendarProvider() {
    }

    /**
     * JSON array of upcoming events starting from now through now+windowMs,
     * ordered by start time, capped at maxEvents. Each element carries id,
     * title, startMs, endMs, allDay, location, and calendarName.
     */
    public static String getUpcomingEventsJson(Context context, int maxEvents, long windowMs) {
        if (context == null || maxEvents <= 0) {
            return "[]";
        }
        long now = System.currentTimeMillis();
        long end = now + Math.max(0L, windowMs);
        int limit = Math.min(200, maxEvents);

        JSONArray out = new JSONArray();
        Cursor cursor = null;
        try {
            cursor = queryInstances(context, now, end, PROJECTION);
            if (cursor != null) {
                while (cursor.moveToNext() && out.length() < limit) {
                    try {
                        out.put(buildEventJson(cursor));
                    } catch (JSONException e) {
                        Log.w(TAG, "failed to serialize calendar event", e);
                    }
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "calendar access denied while reading events", e);
            return "[]";
        } catch (Throwable t) {
            Log.w(TAG, "failed to read calendar events", t);
            return "[]";
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return out.toString();
    }

    /**
     * JSON array of event occurrences overlapping [startMs, endMs], ordered by
     * start time, capped at maxEvents, for Cue. Each element carries the
     * fields of getUpcomingEventsJson plus description, organizer, selfStatus
     * and status, recurring, originalId, originalSyncId and originalInstanceMs
     * (set on an occurrence that was moved or edited on its own), syncId (the
     * sync adapter's id, Google's event id for a Google calendar), the
     * calendar's calendarId, accountName (the account it syncs through) and
     * ownerAccount, and attendees [{name, email, type, role, status}]. Which
     * attendee is you is left to the caller: a phone can sync several
     * people's accounts. Pass startMs == endMs for "what is on now". The
     * detail columns and the attendees are read best-effort: if the provider
     * rejects them, the basic fields still come back.
     */
    public static String getEventDetailsJson(Context context, long startMs, long endMs, int maxEvents) {
        if (context == null || maxEvents <= 0 || endMs < startMs) {
            return "[]";
        }
        int limit = Math.min(200, maxEvents);

        List<JSONObject> events = new ArrayList<>();
        Cursor cursor = null;
        try {
            boolean detailed = true;
            try {
                cursor = queryInstances(context, startMs, endMs, DETAIL_PROJECTION);
            } catch (IllegalArgumentException e) {
                // A provider build without one of the detail columns.
                Log.w(TAG, "calendar provider rejected detail columns; reading basic fields", e);
                detailed = false;
                cursor = queryInstances(context, startMs, endMs, PROJECTION);
            }
            if (cursor != null) {
                while (cursor.moveToNext() && events.size() < limit) {
                    try {
                        JSONObject event = buildEventJson(cursor);
                        if (detailed) {
                            addEventDetails(event, cursor);
                        }
                        events.add(event);
                    } catch (JSONException e) {
                        Log.w(TAG, "failed to serialize calendar event", e);
                    }
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "calendar access denied while reading events", e);
            return "[]";
        } catch (Throwable t) {
            Log.w(TAG, "failed to read calendar events", t);
            return "[]";
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }

        Set<Long> eventIds = new LinkedHashSet<>();
        Set<Long> calendarIds = new LinkedHashSet<>();
        for (JSONObject event : events) {
            eventIds.add(event.optLong("id"));
            if (event.has("calendarId")) {
                calendarIds.add(event.optLong("calendarId"));
            }
        }
        Map<Long, String> syncIds = readStrings(context, CalendarContract.Events.CONTENT_URI,
                CalendarContract.Events._ID, CalendarContract.Events._SYNC_ID, eventIds);
        Map<Long, String> accountNames = readStrings(context, CalendarContract.Calendars.CONTENT_URI,
                CalendarContract.Calendars._ID, CalendarContract.Calendars.ACCOUNT_NAME, calendarIds);
        Map<Long, JSONArray> attendees = readAttendees(context, eventIds);

        JSONArray out = new JSONArray();
        for (JSONObject event : events) {
            long id = event.optLong("id");
            try {
                String syncId = syncIds.get(id);
                event.put("syncId", syncId == null ? "" : syncId);
                String accountName = accountNames.get(event.optLong("calendarId"));
                event.put("accountName", accountName == null ? "" : accountName);
                JSONArray eventAttendees = attendees.get(id);
                event.put("attendees", eventAttendees == null ? new JSONArray() : eventAttendees);
            } catch (JSONException e) {
                Log.w(TAG, "failed to add calendar event details", e);
            }
            out.put(event);
        }
        return out.toString();
    }

    /**
     * JSON array of calendars: id, name (display name), accountName,
     * accountType, ownerAccount, accessLevel, visible. For finding the one
     * Cue writes work meetings into.
     */
    public static String getCalendarsJson(Context context) {
        if (context == null) {
            return "[]";
        }
        String[] projection = {
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_NAME,
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.Calendars.OWNER_ACCOUNT,
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                CalendarContract.Calendars.VISIBLE,
        };
        JSONArray out = new JSONArray();
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, projection, null, null, null);
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    JSONObject calendar = new JSONObject();
                    calendar.put("id", cursor.getLong(0));
                    calendar.put("name", stringAt(cursor, 1));
                    calendar.put("accountName", stringAt(cursor, 2));
                    calendar.put("accountType", stringAt(cursor, 3));
                    calendar.put("ownerAccount", stringAt(cursor, 4));
                    calendar.put("accessLevel", cursor.isNull(5) ? 0 : cursor.getInt(5));
                    calendar.put("visible", !cursor.isNull(6) && cursor.getInt(6) != 0);
                    out.put(calendar);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to read calendars", t);
            return "[]";
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return out.toString();
    }

    /**
     * Adds an event to a calendar; the calendar's sync adapter (Google's)
     * uploads it. Needs WRITE_CALENDAR. Returns the new event id, or -1.
     */
    public static long insertEvent(Context context, long calendarId, String title, long startMs, long endMs,
                                   String location, String description, String timeZone) {
        if (context == null) {
            return -1L;
        }
        try {
            ContentValues values = new ContentValues();
            values.put(CalendarContract.Events.CALENDAR_ID, calendarId);
            values.put(CalendarContract.Events.TITLE, title);
            values.put(CalendarContract.Events.DTSTART, startMs);
            values.put(CalendarContract.Events.DTEND, endMs);
            values.put(CalendarContract.Events.EVENT_TIMEZONE, timeZone);
            values.put(CalendarContract.Events.EVENT_LOCATION, location == null ? "" : location);
            values.put(CalendarContract.Events.DESCRIPTION, description == null ? "" : description);
            Uri uri = context.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, values);
            return uri == null ? -1L : ContentUris.parseId(uri);
        } catch (Throwable t) {
            Log.w(TAG, "failed to add calendar event", t);
            return -1L;
        }
    }

    /** Moves an event (a rescheduled meeting) and refreshes its title and location. Returns whether it changed. */
    public static boolean updateEvent(Context context, long eventId, String title, long startMs, long endMs, String location) {
        if (context == null) {
            return false;
        }
        try {
            ContentValues values = new ContentValues();
            values.put(CalendarContract.Events.TITLE, title);
            values.put(CalendarContract.Events.DTSTART, startMs);
            values.put(CalendarContract.Events.DTEND, endMs);
            values.put(CalendarContract.Events.EVENT_LOCATION, location == null ? "" : location);
            Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId);
            return context.getContentResolver().update(uri, values, null, null) > 0;
        } catch (Throwable t) {
            Log.w(TAG, "failed to update calendar event", t);
            return false;
        }
    }

    private static Cursor queryInstances(Context context, long startMs, long endMs, String[] projection) {
        Uri.Builder builder = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(builder, startMs);
        ContentUris.appendId(builder, endMs);
        return context.getContentResolver().query(
                builder.build(),
                projection,
                null,
                null,
                CalendarContract.Instances.BEGIN + " ASC");
    }

    private static JSONObject buildEventJson(Cursor cursor) throws JSONException {
        JSONObject event = new JSONObject();
        event.put("id", cursor.getLong(0));
        event.put("title", cursor.isNull(1) ? "" : cursor.getString(1));
        event.put("startMs", cursor.getLong(2));
        event.put("endMs", cursor.getLong(3));
        event.put("allDay", cursor.getInt(4) != 0);
        event.put("location", cursor.isNull(5) ? "" : cursor.getString(5));
        event.put("calendarName", cursor.isNull(6) ? "" : cursor.getString(6));
        return event;
    }

    /** Reads DETAIL_PROJECTION's columns past the basic seven. */
    private static void addEventDetails(JSONObject event, Cursor cursor) throws JSONException {
        String description = stringAt(cursor, 7);
        if (description.length() > MAX_DESCRIPTION_CHARS) {
            description = description.substring(0, MAX_DESCRIPTION_CHARS);
        }
        event.put("description", description);
        event.put("organizer", stringAt(cursor, 8));
        event.put("selfStatus", cursor.isNull(9) ? "none" : attendeeStatusName(cursor.getInt(9)));
        event.put("status", cursor.isNull(10) ? "confirmed" : eventStatusName(cursor.getInt(10)));
        long originalId = cursor.isNull(12) ? 0L : cursor.getLong(12);
        event.put("recurring", !stringAt(cursor, 11).isEmpty() || originalId != 0L);
        event.put("originalId", originalId);
        event.put("originalSyncId", stringAt(cursor, 13));
        event.put("originalInstanceMs", cursor.isNull(14) ? 0L : cursor.getLong(14));
        event.put("calendarId", cursor.isNull(15) ? 0L : cursor.getLong(15));
        event.put("ownerAccount", stringAt(cursor, 16));
    }

    /** One string column by row id, for the given ids; empty on failure. */
    private static Map<Long, String> readStrings(Context context, Uri uri, String idColumn, String column, Set<Long> ids) {
        Map<Long, String> out = new HashMap<>();
        if (ids.isEmpty()) {
            return out;
        }
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    uri,
                    new String[] {idColumn, column},
                    inSelection(idColumn, ids.size()),
                    inArgs(ids),
                    null);
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    if (!cursor.isNull(1)) {
                        out.put(cursor.getLong(0), cursor.getString(1));
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to read " + column + " from " + uri, t);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return out;
    }

    /** Attendee rows by event id; empty on failure. */
    private static Map<Long, JSONArray> readAttendees(Context context, Set<Long> eventIds) {
        Map<Long, JSONArray> out = new HashMap<>();
        if (eventIds.isEmpty()) {
            return out;
        }
        String[] projection = {
                CalendarContract.Attendees.EVENT_ID,
                CalendarContract.Attendees.ATTENDEE_NAME,
                CalendarContract.Attendees.ATTENDEE_EMAIL,
                CalendarContract.Attendees.ATTENDEE_TYPE,
                CalendarContract.Attendees.ATTENDEE_RELATIONSHIP,
                CalendarContract.Attendees.ATTENDEE_STATUS,
        };
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    CalendarContract.Attendees.CONTENT_URI,
                    projection,
                    inSelection(CalendarContract.Attendees.EVENT_ID, eventIds.size()),
                    inArgs(eventIds),
                    null);
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    JSONObject attendee = new JSONObject();
                    attendee.put("name", stringAt(cursor, 1));
                    attendee.put("email", stringAt(cursor, 2));
                    attendee.put("type", cursor.isNull(3) ? "none" : attendeeTypeName(cursor.getInt(3)));
                    attendee.put("role", cursor.isNull(4) ? "none" : relationshipName(cursor.getInt(4)));
                    attendee.put("status", cursor.isNull(5) ? "none" : attendeeStatusName(cursor.getInt(5)));
                    long eventId = cursor.getLong(0);
                    JSONArray list = out.get(eventId);
                    if (list == null) {
                        list = new JSONArray();
                        out.put(eventId, list);
                    }
                    list.put(attendee);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to read calendar attendees", t);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return out;
    }

    private static String inSelection(String column, int count) {
        StringBuilder selection = new StringBuilder(column).append(" IN (");
        for (int i = 0; i < count; i++) {
            selection.append(i == 0 ? "?" : ",?");
        }
        return selection.append(')').toString();
    }

    private static String[] inArgs(Set<Long> ids) {
        String[] args = new String[ids.size()];
        int i = 0;
        for (Long id : ids) {
            args[i++] = String.valueOf(id);
        }
        return args;
    }

    private static String stringAt(Cursor cursor, int index) {
        return cursor.isNull(index) ? "" : cursor.getString(index);
    }

    private static String attendeeStatusName(int status) {
        switch (status) {
            case CalendarContract.Attendees.ATTENDEE_STATUS_ACCEPTED:
                return "accepted";
            case CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED:
                return "declined";
            case CalendarContract.Attendees.ATTENDEE_STATUS_INVITED:
                return "invited";
            case CalendarContract.Attendees.ATTENDEE_STATUS_TENTATIVE:
                return "tentative";
            default:
                return "none";
        }
    }

    private static String attendeeTypeName(int type) {
        switch (type) {
            case CalendarContract.Attendees.TYPE_REQUIRED:
                return "required";
            case CalendarContract.Attendees.TYPE_OPTIONAL:
                return "optional";
            case CalendarContract.Attendees.TYPE_RESOURCE:
                return "resource";
            default:
                return "none";
        }
    }

    private static String relationshipName(int relationship) {
        switch (relationship) {
            case CalendarContract.Attendees.RELATIONSHIP_ATTENDEE:
                return "attendee";
            case CalendarContract.Attendees.RELATIONSHIP_ORGANIZER:
                return "organizer";
            case CalendarContract.Attendees.RELATIONSHIP_PERFORMER:
                return "performer";
            case CalendarContract.Attendees.RELATIONSHIP_SPEAKER:
                return "speaker";
            default:
                return "none";
        }
    }

    private static String eventStatusName(int status) {
        switch (status) {
            case CalendarContract.Events.STATUS_TENTATIVE:
                return "tentative";
            case CalendarContract.Events.STATUS_CANCELED:
                return "canceled";
            default:
                return "confirmed";
        }
    }
}
