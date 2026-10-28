package com.kfnote.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;
import java.util.regex.Pattern;

public final class PhotoProvider extends ContentProvider {
    private static final Pattern CAMERA_FILE = Pattern.compile("[A-Za-z0-9_-]+\\.(?:jpg|mp4)");

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) {
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 2 || !"camera".equals(parts.get(0)) || !CAMERA_FILE.matcher(parts.get(1)).matches()) return null;
        return parts.get(1).endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) && !"w".equals(mode) && !"wt".equals(mode) && !"rw".equals(mode) && !"rwt".equals(mode)) {
            throw new FileNotFoundException("camera file unavailable");
        }
        if (getContext() == null) throw new FileNotFoundException("camera file unavailable");
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 2 || !"camera".equals(parts.get(0)) || !CAMERA_FILE.matcher(parts.get(1)).matches()) {
            throw new FileNotFoundException("camera file unavailable");
        }
        File directory = new File(getContext().getCacheDir(), "camera");
        File candidate = new File(directory, parts.get(1));
        try {
            if (!candidate.getCanonicalPath().startsWith(directory.getCanonicalPath() + File.separator) || !candidate.isFile()) {
                throw new FileNotFoundException("camera file unavailable");
            }
            int flags = ParcelFileDescriptor.parseMode(mode);
            return ParcelFileDescriptor.open(candidate, flags);
        } catch (IOException e) {
            throw new FileNotFoundException("camera file unavailable");
        }
    }
}
