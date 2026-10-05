package com.faceclaw.app;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * Read-only SQLite databases that arrive as files (the Bible app's text,
 * notes and lexicons, built off the phone and pushed into the app's files
 * directory). One query crosses the JS bridge as one call: arguments go in
 * as a JSON array, and the rows come back as a JSON array of arrays, so a
 * page of results doesn't cost a bridge call per cell.
 */
public final class FaceclawReadOnlyDatabase {
    private static final String TAG = "FaceclawReadOnlyDb";
    private static final Map<String, SQLiteDatabase> open = new HashMap<>();

    private FaceclawReadOnlyDatabase() {}

    /** Whether a database file is present and readable at this path. */
    public static boolean exists(String path) {
        File file = new File(path);
        return file.isFile() && file.canRead();
    }

    /**
     * Run a query and return its rows as JSON ([[col, col, ...], ...]).
     * Integers come back as numbers, text as strings, NULL as null; blobs
     * are not supported. Returns null if the database can't be opened or
     * the query fails (the error goes to logcat).
     */
    public static synchronized String query(String path, String sql, String argsJson) {
        SQLiteDatabase db = database(path);
        if (db == null) return null;
        Cursor cursor = null;
        try {
            String[] args = null;
            if (argsJson != null && !argsJson.isEmpty()) {
                JSONArray parsed = new JSONArray(argsJson);
                args = new String[parsed.length()];
                for (int i = 0; i < parsed.length(); i++) args[i] = parsed.isNull(i) ? null : parsed.get(i).toString();
            }
            cursor = db.rawQuery(sql, args);
            int columns = cursor.getColumnCount();
            JSONArray rows = new JSONArray();
            while (cursor.moveToNext()) {
                JSONArray row = new JSONArray();
                for (int column = 0; column < columns; column++) {
                    switch (cursor.getType(column)) {
                        case Cursor.FIELD_TYPE_NULL:
                            row.put(JSONObject.NULL);
                            break;
                        case Cursor.FIELD_TYPE_INTEGER:
                            row.put(cursor.getLong(column));
                            break;
                        case Cursor.FIELD_TYPE_FLOAT:
                            row.put(cursor.getDouble(column));
                            break;
                        default:
                            row.put(cursor.getString(column));
                            break;
                    }
                }
                rows.put(row);
            }
            return rows.toString();
        } catch (JSONException | RuntimeException e) {
            Log.w(TAG, "query failed on " + path + ": " + sql, e);
            return null;
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    /** Close a database (before the file is replaced). */
    public static synchronized void close(String path) {
        SQLiteDatabase db = open.remove(path);
        if (db != null) db.close();
    }

    private static SQLiteDatabase database(String path) {
        SQLiteDatabase db = open.get(path);
        if (db != null && db.isOpen()) return db;
        if (!exists(path)) return null;
        try {
            db = SQLiteDatabase.openDatabase(path, null,
                    SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            open.put(path, db);
            return db;
        } catch (RuntimeException e) {
            Log.w(TAG, "open failed: " + path, e);
            return null;
        }
    }
}
