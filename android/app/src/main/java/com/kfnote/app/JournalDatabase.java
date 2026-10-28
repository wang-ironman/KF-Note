package com.kfnote.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

final class JournalDatabase extends SQLiteOpenHelper {
    JournalDatabase(Context context) {
        super(context, "journal.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE journal_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), json TEXT NOT NULL)");
        db.execSQL("CREATE TABLE photo_files (id TEXT PRIMARY KEY, mime TEXT NOT NULL, path TEXT NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("不支持的本地数据版本");
    }
}
