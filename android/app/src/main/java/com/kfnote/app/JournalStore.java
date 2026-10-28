package com.kfnote.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.StatFs;
import android.util.Base64;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

final class JournalStore {
    private static final Pattern ID_PATTERN = Pattern.compile("[A-Za-z0-9_-]+");
    private static final int MAX_STATE_BYTES = 8 * 1024 * 1024;
    private static final int STATE_READ_CHUNK_CHARS = 256 * 1024;
    private final Context context;
    private final JournalDatabase helper;
    private final File photosRoot;
    private final File finalPhotos;
    private final File stagingRoot;
    private final File thumbnailsRoot;
    private final Map<String, Snapshot> snapshots = new HashMap<>();
    private final Map<String, ImportSession> imports = new HashMap<>();
    private final Map<String, StagedPhoto> pickedMedia = new HashMap<>();

    JournalStore(Context context) throws Exception {
        this.context = context.getApplicationContext();
        helper = new JournalDatabase(this.context);
        photosRoot = new File(this.context.getFilesDir(), "photos");
        finalPhotos = new File(photosRoot, "files");
        stagingRoot = new File(photosRoot, "staging");
        thumbnailsRoot = new File(photosRoot, "thumbnails");
        ensureDirectory(finalPhotos);
        ensureDirectory(stagingRoot);
        ensureDirectory(thumbnailsRoot);
        cleanupDeadStaging();
        garbageCollectFinalPhotos();
    }

    synchronized void close() {
        helper.close();
    }

    synchronized JSONObject execute(JSONObject request) throws Exception {
        String action = request.optString("action", "");
        switch (action) {
            case "loadState": return loadState();
            case "saveState": saveState(request.getJSONObject("state")); return null;
            case "putPhoto": putPhoto(request); return null;
            case "putPickedMedia": putPickedMedia(request); return null;
            case "discardPickedMedia": discardPickedMedia(request.getJSONArray("tokens")); return null;
            case "copyPhotos": copyPhotos(request); return null;
            case "getPhoto": return getPhoto(request.getString("id"), request.optBoolean("thumbnail", false));
            case "deletePhotos": deletePhotos(request); return null;
            case "openSnapshot": return openSnapshot();
            case "snapshotPhoto": return snapshotPhoto(request.getString("token"), request.getString("id"));
            case "closeSnapshot": closeSnapshot(request.getString("token")); return null;
            case "beginImport": return beginImport();
            case "stagePhoto": stagePhoto(request); return null;
            case "commitImport": commitImport(request); return null;
            case "abortImport": abortImport(request.getString("token")); return null;
            case "estimateStorage": return estimateStorage();
            default: throw new IOException("不支持的本地存储操作");
        }
    }

    private JSONObject loadState() throws Exception {
        SQLiteDatabase db = helper.getReadableDatabase();
        String json = readStateJson(db);
        return json == null ? null : new JSONObject(json);
    }

    private void saveState(JSONObject state) throws Exception {
        String json = checkedStateJson(state);
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            writeState(db, json);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private void putPhoto(JSONObject request) throws Exception {
        JSONObject state = request.getJSONObject("state");
        JSONObject metadata = request.getJSONObject("metadata");
        String stateJson = checkedStateJson(state);
        String id = checkedId(metadata.getString("id"));
        String mime = checkedMime(metadata.getString("type"));
        byte[] bytes = decodeBase64(request.getString("base64"));
        checkSize(metadata, bytes);
        File path = writeFinalPhoto(bytes, mime);
        SQLiteDatabase db = helper.getWritableDatabase();
        try {
            db.beginTransaction();
            try {
                writeState(db, stateJson);
                ContentValues values = new ContentValues();
                values.put("id", id);
                values.put("mime", mime);
                values.put("path", relativePhotoPath(path));
                if (db.insertWithOnConflict("photo_files", null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0) {
                    throw new android.database.SQLException("无法保存照片索引");
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        } catch (Exception e) {
            try { deleteCreatedFile(path); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
        cleanAfterCommit("保存照片后清理缓存失败", () -> clearThumbnail(id));
        cleanAfterCommit("保存照片后清理孤立文件失败", this::garbageCollectFinalPhotos);
    }

    synchronized JSONObject stagePickedMedia(InputStream input, String mimeValue, String nameValue) throws Exception {
        String mime = checkedMime(mimeValue);
        String token = UUID.randomUUID().toString();
        File file = new File(stagingRoot, token + ".stage");
        long size = 0;
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                size += count;
                out.write(buffer, 0, count);
            }
            out.getFD().sync();
            if (size <= 0) throw new IOException("所选媒体文件为空");
        } catch (Exception e) {
            try { deleteCreatedFile(file); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
        String name = nameValue == null ? "" : new File(nameValue.replace('\\', '/')).getName().trim();
        if (name.isEmpty()) name = mime.startsWith("video/") ? "视频" : "照片";
        pickedMedia.put(token, new StagedPhoto(mime, file, size));
        return new JSONObject().put("token", token).put("name", name).put("type", mime).put("size", size);
    }

    private void putPickedMedia(JSONObject request) throws Exception {
        JSONObject state = request.getJSONObject("state");
        String stateJson = checkedStateJson(state);
        JSONObject metadata = request.getJSONObject("metadata");
        String id = checkedId(metadata.getString("id"));
        String token = checkedId(request.getString("token"));
        String mime = checkedMime(metadata.getString("type"));
        StagedPhoto staged = pickedMedia.get(token);
        if (staged == null) throw new IOException("媒体暂存已失效，请重新选择");
        JSONObject stored = findPhotoMetadata(state.getJSONArray("photos"), id);
        if (stored == null || !mime.equals(staged.mime) || !mime.equals(stored.getString("type"))
                || staged.size != metadata.getLong("size") || staged.size != stored.getLong("size")
                || !metadata.getString("filename").equals(stored.getString("filename"))) {
            throw new IOException("媒体文件与记录信息不匹配");
        }
        File finalPath = copyToNewFinal(staged.file, mime);
        try {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                writeState(db, stateJson);
                ContentValues values = new ContentValues();
                values.put("id", id);
                values.put("mime", mime);
                values.put("path", relativePhotoPath(finalPath));
                db.insertOrThrow("photo_files", null, values);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        } catch (Exception e) {
            try { deleteCreatedFile(finalPath); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
        pickedMedia.remove(token);
        cleanAfterCommit("保存媒体后清理暂存文件失败", () -> deleteCreatedFile(staged.file));
        cleanAfterCommit("保存媒体后清理缩略图失败", () -> clearThumbnail(id));
    }

    private void discardPickedMedia(JSONArray tokens) throws Exception {
        for (int i = 0; i < tokens.length(); i++) {
            String token = checkedId(tokens.getString(i));
            StagedPhoto staged = pickedMedia.remove(token);
            if (staged != null) deleteCreatedFile(staged.file);
        }
    }

    private JSONObject getPhoto(String idValue, boolean thumbnail) throws Exception {
        String id = checkedId(idValue);
        Photo photo = findPhoto(id);
        if (photo == null) return null;
        return thumbnail ? requestThumbnail(id, photo) : encodePhoto(photo);
    }

    private void copyPhotos(JSONObject request) throws Exception {
        JSONObject state = request.getJSONObject("state");
        String stateJson = checkedStateJson(state);
        JSONArray pairs = request.getJSONArray("pairs");
        SQLiteDatabase db = helper.getWritableDatabase();
        Set<String> destinations = new HashSet<>();
        db.beginTransaction();
        try {
            for (int i = 0; i < pairs.length(); i++) {
                JSONObject pair = pairs.getJSONObject(i);
                String from = checkedId(pair.getString("from"));
                String to = checkedId(pair.getString("to"));
                if (from.equals(to) || !destinations.add(to)) throw new IOException("照片复制映射无效");
                JSONObject sourceMetadata = findPhotoMetadata(state.getJSONArray("photos"), from);
                JSONObject targetMetadata = findPhotoMetadata(state.getJSONArray("photos"), to);
                if (sourceMetadata == null || targetMetadata == null
                        || !checkedMime(sourceMetadata.getString("type")).equals(checkedMime(targetMetadata.getString("type")))
                        || sourceMetadata.getLong("size") != targetMetadata.getLong("size")) {
                    throw new IOException("房源副本的照片元数据无效");
                }
                try (Cursor cursor = db.rawQuery("SELECT mime, path FROM photo_files WHERE id = ?", new String[]{from})) {
                    if (!cursor.moveToFirst()) throw new IOException("原照片文件缺失，无法复制：" + from);
                    String mime = cursor.getString(0);
                    String relativePath = cursor.getString(1);
                    File photoPath = resolvePhotoPath(relativePath);
                    if (!photoPath.isFile() || !mime.equals(sourceMetadata.getString("type"))) {
                        throw new IOException("原照片文件缺失或格式不符，无法复制：" + from);
                    }
                    ContentValues values = new ContentValues();
                    values.put("id", to);
                    values.put("mime", mime);
                    values.put("path", relativePath);
                    db.insertOrThrow("photo_files", null, values);
                }
            }
            writeState(db, stateJson);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private JSONObject findPhotoMetadata(JSONArray photos, String id) throws Exception {
        JSONObject result = null;
        for (int i = 0; i < photos.length(); i++) {
            JSONObject photo = photos.getJSONObject(i);
            if (id.equals(checkedId(photo.getString("id")))) {
                if (result != null) throw new IOException("照片元数据 ID 重复");
                result = photo;
            }
        }
        return result;
    }

    private void deletePhotos(JSONObject request) throws Exception {
        String stateJson = checkedStateJson(request.getJSONObject("state"));
        JSONArray ids = request.getJSONArray("ids");
        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            writeState(db, stateJson);
            for (int i = 0; i < ids.length(); i++) {
                db.delete("photo_files", "id = ?", new String[]{checkedId(ids.getString(i))});
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        for (int i = 0; i < ids.length(); i++) {
            String id = checkedId(ids.getString(i));
            cleanAfterCommit("删除照片后清理缩略图失败", () -> clearThumbnail(id));
        }
        cleanAfterCommit("删除照片后清理孤立文件失败", this::garbageCollectFinalPhotos);
    }

    private JSONObject requestThumbnail(String id, Photo photo) throws Exception {
        if (photo.mime.startsWith("video/")) return null;
        File thumbnail = thumbnailFile(id, photo);
        if (!thumbnail.isFile()) createThumbnail(photo.path, thumbnail);
        return new JSONObject().put("base64", Base64.encodeToString(readAll(thumbnail), Base64.NO_WRAP))
                .put("type", "image/jpeg");
    }

    private JSONObject openSnapshot() throws Exception {
        SQLiteDatabase db = helper.getReadableDatabase();
        db.beginTransaction();
        String stateJson = null;
        Map<String, Photo> photos = new HashMap<>();
        try {
            stateJson = readStateJson(db);
            try (Cursor cursor = db.rawQuery("SELECT id, mime, path FROM photo_files", null)) {
                while (cursor.moveToNext()) {
                    photos.put(cursor.getString(0), new Photo(cursor.getString(1), resolvePhotoPath(cursor.getString(2))));
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        String token = UUID.randomUUID().toString();
        Snapshot snapshot = new Snapshot(stateJson == null ? null : new JSONObject(stateJson), photos);
        snapshots.put(token, snapshot);
        for (Photo photo : photos.values()) snapshotLeases.merge(photo.path.getCanonicalPath(), 1, Integer::sum);
        return new JSONObject().put("token", token).put("state", snapshot.state == null ? JSONObject.NULL : snapshot.state);
    }

    private JSONObject snapshotPhoto(String token, String idValue) throws Exception {
        Snapshot snapshot = snapshots.get(token);
        if (snapshot == null) throw new IOException("备份快照已失效");
        Photo photo = snapshot.photos.get(checkedId(idValue));
        return photo == null ? null : encodePhoto(photo);
    }

    private final Map<String, Integer> snapshotLeases = new HashMap<>();

    private void closeSnapshot(String token) throws Exception {
        Snapshot snapshot = snapshots.remove(token);
        if (snapshot == null) return;
        for (Photo photo : snapshot.photos.values()) {
            String path = photo.path.getCanonicalPath();
            int count = snapshotLeases.getOrDefault(path, 0) - 1;
            if (count <= 0) snapshotLeases.remove(path); else snapshotLeases.put(path, count);
        }
        cleanAfterCommit("关闭备份快照后清理孤立文件失败", this::garbageCollectFinalPhotos);
    }

    private JSONObject beginImport() throws Exception {
        String token = UUID.randomUUID().toString();
        File directory = new File(stagingRoot, token);
        ensureDirectory(directory);
        imports.put(token, new ImportSession(directory));
        return new JSONObject().put("token", token);
    }

    private void stagePhoto(JSONObject request) throws Exception {
        String token = request.getString("token");
        ImportSession session = imports.get(token);
        if (session == null) throw new IOException("导入任务已失效");
        JSONObject metadata = request.getJSONObject("metadata");
        String id = checkedId(metadata.getString("id"));
        String mime = checkedMime(metadata.getString("type"));
        if (session.photos.containsKey(id)) throw new IOException("导入照片编号重复");
        byte[] bytes = decodeBase64(request.getString("base64"));
        checkSize(metadata, bytes);
        File file = new File(session.directory, UUID.randomUUID() + extension(mime));
        writeNewFile(file, bytes);
        session.photos.put(id, new StagedPhoto(mime, file, bytes.length));
    }

    private void commitImport(JSONObject request) throws Exception {
        String token = request.getString("token");
        ImportSession session = imports.get(token);
        if (session == null) throw new IOException("导入任务已失效");
        JSONObject state = request.getJSONObject("state");
        String stateJson = checkedStateJson(state);
        Map<String, StagedPhoto> chosen = photosRequiredByState(state, session);
        Map<String, File> finalPaths = new HashMap<>();
        try {
            for (Map.Entry<String, StagedPhoto> entry : chosen.entrySet()) {
                finalPaths.put(entry.getKey(), copyToNewFinal(entry.getValue().file, entry.getValue().mime));
            }
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                writeState(db, stateJson);
                db.delete("photo_files", null, null);
                for (Map.Entry<String, StagedPhoto> entry : chosen.entrySet()) {
                    ContentValues values = new ContentValues();
                    values.put("id", entry.getKey());
                    values.put("mime", entry.getValue().mime);
                    values.put("path", relativePhotoPath(finalPaths.get(entry.getKey())));
                    db.insertOrThrow("photo_files", null, values);
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        } catch (Exception e) {
            for (File file : finalPaths.values()) {
                try { deleteCreatedFile(file); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            }
            throw e;
        }
        if (cleanAfterCommit("导入完成后清理暂存文件失败", () -> deleteTree(session.directory))) imports.remove(token);
        cleanAfterCommit("导入完成后清理缩略图失败", this::clearAllThumbnails);
        cleanAfterCommit("导入完成后清理孤立文件失败", this::garbageCollectFinalPhotos);
    }

    private Map<String, StagedPhoto> photosRequiredByState(JSONObject state, ImportSession session) throws Exception {
        JSONArray list = state.optJSONArray("photos");
        Map<String, StagedPhoto> chosen = new HashMap<>();
        if (list == null) throw new IOException("备份缺少照片清单");
        for (int i = 0; i < list.length(); i++) {
            JSONObject metadata = list.getJSONObject(i);
            String id = checkedId(metadata.getString("id"));
            String mime = checkedMime(metadata.getString("type"));
            StagedPhoto staged = session.photos.get(id);
            if (staged == null || !staged.mime.equals(mime) || staged.size != metadata.getLong("size")) {
                throw new IOException("导入照片与清单不匹配");
            }
            chosen.put(id, staged);
        }
        return chosen;
    }

    private void abortImport(String token) throws Exception {
        ImportSession session = imports.get(token);
        if (session != null) {
            deleteTree(session.directory);
            imports.remove(token);
        }
    }

    private JSONObject estimateStorage() throws Exception {
        long usage = directorySize(context.getFilesDir()) + directorySize(context.getDatabasePath("journal.db").getParentFile());
        StatFs stat = new StatFs(context.getFilesDir().getAbsolutePath());
        return new JSONObject().put("usage", usage).put("quota", stat.getTotalBytes());
    }

    private Photo findPhoto(String id) throws Exception {
        SQLiteDatabase db = helper.getReadableDatabase();
        try (Cursor cursor = db.rawQuery("SELECT mime, path FROM photo_files WHERE id = ?", new String[]{id})) {
            return cursor.moveToFirst() ? new Photo(cursor.getString(0), resolvePhotoPath(cursor.getString(1))) : null;
        }
    }

    MediaResource openMedia(String idValue, String rangeValue) throws Exception {
        return openMedia(idValue, rangeValue, true);
    }

    MediaResource openMediaForWebView(String idValue, String rangeValue) throws Exception {
        // WebView applies the request's Range to the supplied InputStream itself.
        // Keep the stream at byte zero while describing the requested response range.
        return openMedia(idValue, rangeValue, false);
    }

    private MediaResource openMedia(String idValue, String rangeValue, boolean positionStream) throws Exception {
        Photo photo = findPhoto(checkedId(idValue));
        if (photo == null || !photo.path.isFile()) return null;
        long size = photo.path.length();
        long start = 0;
        long end = size - 1;
        boolean partial = false;
        if (rangeValue != null && !rangeValue.trim().isEmpty()) {
            partial = true;
            java.util.regex.Matcher matcher = Pattern.compile("(?i)^bytes=(\\d*)-(\\d*)$").matcher(rangeValue.trim());
            if (!matcher.matches() || size == 0) return rangeNotSatisfiable(photo.mime, size);
            try {
                String startText = matcher.group(1);
                String endText = matcher.group(2);
                if (startText.isEmpty()) {
                    long suffix = Long.parseLong(endText);
                    if (suffix <= 0) return rangeNotSatisfiable(photo.mime, size);
                    start = Math.max(0, size - suffix);
                } else {
                    start = Long.parseLong(startText);
                    if (!endText.isEmpty()) end = Math.min(size - 1, Long.parseLong(endText));
                }
            } catch (NumberFormatException e) { return rangeNotSatisfiable(photo.mime, size); }
            if (start < 0 || start >= size || end < start) return rangeNotSatisfiable(photo.mime, size);
        }
        long length = end - start + 1;
        FileInputStream input = new FileInputStream(photo.path);
        try {
            long skipped = 0;
            while (positionStream && skipped < start) {
                long step = input.skip(start - skipped);
                if (step <= 0) {
                    if (input.read() < 0) throw new IOException("无法读取媒体范围");
                    step = 1;
                }
                skipped += step;
            }
            String contentRange = partial ? "bytes " + start + "-" + end + "/" + size : null;
            return new MediaResource(photo.mime, partial ? 206 : 200, partial ? "Partial Content" : "OK",
                    length, contentRange, new LimitedInputStream(input, positionStream ? length : size));
        } catch (Exception e) {
            try { input.close(); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
    }

    private static MediaResource rangeNotSatisfiable(String mime, long size) {
        return new MediaResource(mime, 416, "Range Not Satisfiable", 0, "bytes */" + size,
                new java.io.ByteArrayInputStream(new byte[0]));
    }

    private JSONObject encodePhoto(Photo photo) throws Exception {
        byte[] bytes = readAll(photo.path);
        return new JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("type", photo.mime);
    }

    private String checkedStateJson(JSONObject state) throws Exception {
        String json = state.toString();
        if (json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_STATE_BYTES) throw new IOException("本地记录内容过大");
        return json;
    }

    private String checkedId(String id) throws IOException {
        if (id == null || !ID_PATTERN.matcher(id).matches()) throw new IOException("照片编号格式无效");
        return id;
    }

    static String checkedMime(String mime) throws IOException {
        if (!"image/jpeg".equals(mime) && !"image/png".equals(mime) && !"image/webp".equals(mime)
                && !"image/gif".equals(mime) && !"image/avif".equals(mime)
                && !"video/mp4".equals(mime) && !"video/webm".equals(mime) && !"video/3gpp".equals(mime)) {
            throw new IOException("不支持的媒体格式");
        }
        return mime;
    }

    private byte[] decodeBase64(String encoded) throws IOException {
        try {
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            if (bytes.length == 0) throw new IOException("照片数据为空");
            return bytes;
        } catch (IllegalArgumentException e) {
            throw new IOException("照片数据格式无效", e);
        }
    }

    private void checkSize(JSONObject metadata, byte[] bytes) throws Exception {
        if (metadata.getLong("size") != bytes.length) throw new IOException("照片大小与清单不一致");
    }

    private void writeState(SQLiteDatabase db, String json) {
        ContentValues values = new ContentValues();
        values.put("singleton", 1);
        values.put("json", json);
        if (db.insertWithOnConflict("journal_state", null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0) {
            throw new android.database.SQLException("无法保存本地记录");
        }
    }

    private static String readStateJson(SQLiteDatabase db) throws IOException {
        int length;
        try (Cursor cursor = db.rawQuery("SELECT length(json) FROM journal_state WHERE singleton = 1", null)) {
            if (!cursor.moveToFirst()) return null;
            length = cursor.getInt(0);
        }
        StringBuilder json = new StringBuilder(length);
        for (int offset = 1; offset <= length; offset += STATE_READ_CHUNK_CHARS) {
            try (Cursor cursor = db.rawQuery("SELECT substr(json, ?, ?) FROM journal_state WHERE singleton = 1",
                    new String[]{Integer.toString(offset), Integer.toString(STATE_READ_CHUNK_CHARS)})) {
                if (!cursor.moveToFirst()) throw new IOException("本地记录读取不完整");
                json.append(cursor.getString(0));
            }
        }
        return json.toString();
    }

    private File writeFinalPhoto(byte[] bytes, String mime) throws IOException {
        File file = new File(finalPhotos, UUID.randomUUID() + extension(mime));
        writeNewFile(file, bytes);
        return file;
    }

    private File copyToNewFinal(File source, String mime) throws IOException {
        File target = new File(finalPhotos, UUID.randomUUID() + extension(mime));
        try {
            Files.copy(source.toPath(), target.toPath());
            return target;
        } catch (IOException e) {
            try { deleteCreatedFile(target); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
    }

    private String relativePhotoPath(File file) throws IOException {
        String root = photosRoot.getCanonicalPath() + File.separator;
        String path = file.getCanonicalPath();
        if (!path.startsWith(root)) throw new IOException("照片路径无效");
        return photosRoot.getCanonicalFile().toPath().relativize(file.getCanonicalFile().toPath()).toString();
    }

    private File resolvePhotoPath(String relative) throws IOException {
        File file = new File(photosRoot, relative);
        String root = finalPhotos.getCanonicalPath() + File.separator;
        String path = file.getCanonicalPath();
        if (!path.startsWith(root)) throw new IOException("照片路径超出本地目录");
        return file;
    }

    private static String extension(String mime) {
        switch (mime) {
            case "image/jpeg": return ".jpg";
            case "image/png": return ".png";
            case "image/webp": return ".webp";
            case "image/gif": return ".gif";
            case "image/avif": return ".avif";
            case "video/mp4": return ".mp4";
            case "video/webm": return ".webm";
            case "video/3gpp": return ".3gp";
            default: throw new IllegalArgumentException("unsupported mime");
        }
    }

    private void garbageCollectFinalPhotos() throws Exception {
        Set<String> retained = new HashSet<>(snapshotLeases.keySet());
        SQLiteDatabase db = helper.getReadableDatabase();
        try (Cursor cursor = db.rawQuery("SELECT path FROM photo_files", null)) {
            while (cursor.moveToNext()) retained.add(resolvePhotoPath(cursor.getString(0)).getCanonicalPath());
        }
        File[] files = finalPhotos.listFiles();
        if (files == null) throw new IOException("无法读取本地照片目录");
        for (File file : files) {
            if (file.isFile() && !retained.contains(file.getCanonicalPath()) && !file.delete()) {
                throw new IOException("无法清理未引用的照片文件");
            }
        }
    }

    private File thumbnailFile(String id, Photo photo) {
        return new File(thumbnailsRoot, id + "_" + photo.path.getName() + ".jpg");
    }

    private void clearThumbnail(String id) throws IOException {
        File[] files = thumbnailsRoot.listFiles((directory, name) -> name.startsWith(id + "_"));
        if (files == null) throw new IOException("无法读取照片缩略图目录");
        for (File file : files) if (file.isFile() && !file.delete()) throw new IOException("无法更新照片缩略图");
    }

    private void clearAllThumbnails() throws IOException {
        File[] files = thumbnailsRoot.listFiles();
        if (files == null) throw new IOException("无法读取照片缩略图目录");
        for (File file : files) {
            if (file.isFile() && !file.delete()) throw new IOException("无法更新照片缩略图");
        }
    }

    private void createThumbnail(File source, File destination) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(source.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("无法读取照片尺寸");
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / sample > 640) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeFile(source.getAbsolutePath(), options);
        if (bitmap == null) throw new IOException("无法生成照片缩略图");
        Bitmap oriented = null;
        File temporary = new File(thumbnailsRoot, UUID.randomUUID() + ".tmp");
        try {
            int orientation = ExifInterface.ORIENTATION_NORMAL;
            try {
                ExifInterface exif = new ExifInterface(source.getAbsolutePath());
                orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            } catch (IOException ignored) { }
            Matrix transform = orientationTransform(orientation);
            if (!transform.isIdentity()) {
                oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), transform, true);
            }
            writeBitmap(temporary, oriented == null ? bitmap : oriented);
            Files.move(temporary.toPath(), destination.toPath());
        } catch (IOException e) {
            try { if (temporary.exists() && !temporary.delete()) throw new IOException("无法清理未完成的缩略图"); }
            catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        } finally {
            if (oriented != null && oriented != bitmap) oriented.recycle();
            bitmap.recycle();
        }
    }

    private static Matrix orientationTransform(int orientation) {
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                matrix.setRotate(90);
                matrix.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                matrix.setRotate(-90);
                matrix.postScale(-1, 1);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(270); break;
            default: break;
        }
        return matrix;
    }

    private static void writeBitmap(File destination, Bitmap bitmap) throws IOException {
        try (FileOutputStream out = new FileOutputStream(destination, false)) {
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)) throw new IOException("无法保存照片缩略图");
            out.getFD().sync();
        }
    }

    private void cleanupDeadStaging() throws IOException {
        File[] entries = stagingRoot.listFiles();
        if (entries == null) throw new IOException("无法读取导入暂存目录");
        for (File entry : entries) deleteTree(entry);
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建本地存储目录");
    }

    private static void writeNewFile(File file, byte[] bytes) throws IOException {
        if (!file.createNewFile()) throw new IOException("本地文件已存在，无法安全写入");
        try {
            try (FileOutputStream out = new FileOutputStream(file, false)) {
                out.write(bytes);
                out.getFD().sync();
            }
        } catch (IOException e) {
            try { if (!file.delete()) throw new IOException("无法清理未完成的本地文件"); }
            catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
    }

    private static byte[] readAll(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return out.toByteArray();
        }
    }

    private static long directorySize(File file) throws IOException {
        if (file == null || !file.exists()) return 0;
        if (file.isFile()) return file.length();
        File[] children = file.listFiles();
        if (children == null) throw new IOException("无法读取应用存储用量");
        long size = 0;
        for (File child : children) size += directorySize(child);
        return size;
    }

    private static void deleteTree(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取导入暂存目录");
            for (File child : children) deleteTree(child);
        }
        if (!file.delete()) throw new IOException("无法删除本地暂存文件");
    }

    private static void deleteCreatedFile(File file) throws IOException {
        if (file != null && file.exists() && !file.delete()) throw new IOException("无法清理未完成的本地照片文件");
    }

    private static boolean cleanAfterCommit(String label, Cleanup cleanup) {
        try { cleanup.run(); return true; }
        catch (Exception e) { Log.e("KFNoteStore", label, e); return false; }
    }

    private static final class Photo {
        final String mime;
        final File path;
        Photo(String mime, File path) { this.mime = mime; this.path = path; }
    }

    static final class MediaResource {
        final String mime;
        final int status;
        final String reason;
        final long length;
        final String contentRange;
        final InputStream stream;
        MediaResource(String mime, int status, String reason, long length, String contentRange, InputStream stream) {
            this.mime = mime;
            this.status = status;
            this.reason = reason;
            this.length = length;
            this.contentRange = contentRange;
            this.stream = stream;
        }
    }

    private static final class LimitedInputStream extends FilterInputStream {
        private long remaining;
        LimitedInputStream(InputStream input, long length) { super(input); remaining = length; }
        @Override public int read() throws IOException {
            if (remaining <= 0) return -1;
            int value = in.read();
            if (value >= 0) remaining--;
            return value;
        }
        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining <= 0) return -1;
            int count = in.read(buffer, offset, (int)Math.min(length, remaining));
            if (count > 0) remaining -= count;
            return count;
        }
        @Override public int available() throws IOException {
            return (int)Math.min(remaining, in.available());
        }
        @Override public long skip(long count) throws IOException {
            if (count <= 0 || remaining <= 0) return 0;
            long skipped = in.skip(Math.min(count, remaining));
            remaining -= skipped;
            return skipped;
        }
    }

    private static final class Snapshot {
        final JSONObject state;
        final Map<String, Photo> photos;
        Snapshot(JSONObject state, Map<String, Photo> photos) { this.state = state; this.photos = photos; }
    }

    private static final class StagedPhoto {
        final String mime;
        final File file;
        final long size;
        StagedPhoto(String mime, File file, long size) { this.mime = mime; this.file = file; this.size = size; }
    }

    private static final class ImportSession {
        final File directory;
        final Map<String, StagedPhoto> photos = new HashMap<>();
        ImportSession(File directory) { this.directory = directory; }
    }

    private interface Cleanup { void run() throws Exception; }
}
