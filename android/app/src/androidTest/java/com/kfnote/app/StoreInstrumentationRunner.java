package com.kfnote.app;

import android.app.Instrumentation;
import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.database.DatabaseErrorHandler;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Insets;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;

public final class StoreInstrumentationRunner extends Instrumentation {
    private boolean uiOnly;
    private int[] insetFrame;
    private String insetFrameDetails;
    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        uiOnly = arguments != null && "ui".equals(arguments.getString("case"));
        start();
    }

    @Override
    public void onStart() {
        Bundle result = new Bundle();
        try {
            if (!uiOnly) {
            File testRoot = new File(getTargetContext().getCacheDir(), "store-instrumentation");
            deleteTree(testRoot);
            JournalStore store = new JournalStore(new StoreTestContext(getTargetContext(), testRoot));
            testSaveReload(store);
            testPhotoRoundTrip(store);
            testPickedVideoMedia(store);
            testCopyPhotos(store);
            testThumbnailReplacement(store);
            testSnapshotRetainsPhoto(store);
            testImportRollback(store);
            testImportCommit(store);
            testAmapNavigationIntent();
            store.close();
            deleteTree(testRoot);
            }
            testWebViewUiAndBridge();
            result.putString("result", "PASS");
        } catch (Throwable e) {
            result.putString("result", "FAIL");
            result.putString("error", e.toString());
        }
        finish("PASS".equals(result.getString("result")) ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
    }

    private static void testSaveReload(JournalStore store) throws Exception {
        char[] largeChars = new char[2_300_000];
        java.util.Arrays.fill(largeChars, 'x');
        JSONObject state = new JSONObject().put("version", 1).put("large", new String(largeChars))
                .put("houses", new JSONArray().put(new JSONObject().put("id", "h1")))
                .put("photos", new JSONArray());
        store.execute(new JSONObject().put("action", "saveState").put("state", state));
        JSONObject loaded = store.execute(new JSONObject().put("action", "loadState"));
        require(loaded != null && loaded.getJSONArray("houses").getJSONObject(0).getString("id").equals("h1")
                && loaded.getString("large").length() == largeChars.length, "save/reload large state chunks");
    }

    private static void testPhotoRoundTrip(JournalStore store) throws Exception {
        byte[] bytes = "photo-bytes".getBytes(StandardCharsets.UTF_8);
        JSONObject state = stateWithPhoto("photo1", bytes, "image/jpeg");
        store.execute(photoRequest("putPhoto", "photo1", bytes, "image/jpeg").put("state", state));
        JSONObject result = store.execute(new JSONObject().put("action", "getPhoto").put("id", "photo1"));
        require(result != null && "image/jpeg".equals(result.getString("type"))
                && java.util.Arrays.equals(bytes, Base64.decode(result.getString("base64"), Base64.DEFAULT)), "photo round trip");
    }

    private static void testPickedVideoMedia(JournalStore store) throws Exception {
        byte[] bytes = "0123456789abcdef".getBytes(StandardCharsets.UTF_8);
        JSONObject descriptor = store.stagePickedMedia(new ByteArrayInputStream(bytes), "video/mp4", "看房视频.mp4");
        String token = descriptor.getString("token");
        String filename = descriptor.getString("name");
        require("video/mp4".equals(descriptor.getString("type")) && descriptor.getLong("size") == bytes.length,
                "picked media descriptor has MIME and size");
        JSONObject videoMetadata = metadata("picked-video", bytes, "video/mp4").put("filename", filename)
                .put("visitId", JSONObject.NULL).put("sectionKey", "environment");
        JSONObject state = new JSONObject().put("version", 1).put("photos", new JSONArray().put(videoMetadata));
        store.execute(new JSONObject().put("action", "putPickedMedia").put("state", state)
                .put("metadata", videoMetadata).put("token", token));
        JSONObject photo = store.execute(new JSONObject().put("action", "getPhoto").put("id", "picked-video"));
        require(photo != null && "video/mp4".equals(photo.getString("type"))
                        && java.util.Arrays.equals(bytes, Base64.decode(photo.getString("base64"), Base64.DEFAULT)),
                "picked video is committed and remains ZIP-readable");
        require(store.execute(new JSONObject().put("action", "getPhoto").put("id", "picked-video").put("thumbnail", true)) == null,
                "video thumbnail is omitted");

        requireRange(store.openMedia("picked-video", null), 200, "", bytes, 0, bytes.length, "full media stream");
        JournalStore.MediaResource bounded = store.openMedia("picked-video", "bytes=3-7");
        requireRange(bounded, 206, "bytes 3-7/16", bytes, 3, 5, "bounded byte range");
        requireRange(store.openMedia("picked-video", "bytes=10-"), 206, "bytes 10-15/16", bytes, 10, 6, "open-ended byte range");
        requireRange(store.openMedia("picked-video", "bytes=-4"), 206, "bytes 12-15/16", bytes, 12, 4, "suffix byte range");
        JournalStore.MediaResource webViewRange = store.openMediaForWebView("picked-video", "bytes=12-");
        require(webViewRange.status == 206 && webViewRange.length == 4
                        && "bytes 12-15/16".equals(webViewRange.contentRange), "WebView partial response metadata");
        try (InputStream stream = webViewRange.stream) {
            require(stream.available() == 16 && stream.skip(12) == 12 && stream.available() == 4,
                    "WebView seeks once from the full file stream");
            require(java.util.Arrays.equals(readBytes(stream), java.util.Arrays.copyOfRange(bytes, 12, 16)),
                    "WebView nonzero range delivers correct tail bytes");
        }
        try (InputStream stream = store.openMedia("picked-video", "bytes=3-7").stream) {
            require(stream.available() == 5 && stream.skip(100) == 5 && stream.available() == 0 && stream.read() == -1,
                    "bounded stream available and skip cannot pass its range");
        }
        JournalStore.MediaResource invalid = store.openMedia("picked-video", "bytes=99-");
        require(invalid.status == 416 && invalid.length == 0 && "bytes */16".equals(invalid.contentRange),
                "unsatisfiable byte range reports 416");
        require(readBytes(invalid.stream).length == 0, "unsatisfiable range body is empty");

        JSONObject copiedMetadata = metadata("picked-video-copy", bytes, "video/mp4").put("filename", filename)
                .put("visitId", JSONObject.NULL).put("sectionKey", "environment");
        JSONObject copiedState = new JSONObject().put("version", 1).put("photos", new JSONArray().put(videoMetadata).put(copiedMetadata));
        store.execute(new JSONObject().put("action", "copyPhotos").put("state", copiedState)
                .put("pairs", new JSONArray().put(new JSONObject().put("from", "picked-video").put("to", "picked-video-copy"))));
        store.execute(new JSONObject().put("action", "deletePhotos")
                .put("state", new JSONObject().put("version", 1).put("photos", new JSONArray().put(copiedMetadata)))
                .put("ids", new JSONArray().put("picked-video")));
        require(store.execute(new JSONObject().put("action", "getPhoto").put("id", "picked-video")) == null,
                "deleting the picked video removes its original ID");
        JSONObject retained = store.execute(new JSONObject().put("action", "getPhoto").put("id", "picked-video-copy"));
        require(retained != null && java.util.Arrays.equals(bytes, Base64.decode(retained.getString("base64"), Base64.DEFAULT)),
                "copied picked video retains shared file after original deletion");
        JournalStore.MediaResource deleted = store.openMedia("picked-video", null);
        require(deleted == null, "deleted video URL no longer resolves");

        store.execute(new JSONObject().put("action", "saveState").put("state", new JSONObject().put("version", 1).put("marker", "before media rollback")));
        JSONObject rollbackStage = store.stagePickedMedia(new ByteArrayInputStream(bytes), "video/mp4", filename);
        JSONObject duplicateId = new JSONObject(copiedMetadata.toString());
        JSONObject duplicateState = new JSONObject().put("version", 1).put("marker", "must roll back").put("photos", new JSONArray().put(duplicateId));
        boolean rejected = false;
        try {
            store.execute(new JSONObject().put("action", "putPickedMedia").put("state", duplicateState)
                    .put("metadata", duplicateId).put("token", rollbackStage.getString("token")));
        } catch (Exception expected) { rejected = true; }
        require(rejected, "duplicate media index rejects commit");
        require("before media rollback".equals(store.execute(new JSONObject().put("action", "loadState")).getString("marker")),
                "failed picked media commit rolls back state");
        store.execute(new JSONObject().put("action", "discardPickedMedia")
                .put("tokens", new JSONArray().put(rollbackStage.getString("token"))));
        boolean discarded = false;
        try {
            store.execute(new JSONObject().put("action", "putPickedMedia").put("state", duplicateState)
                    .put("metadata", duplicateId).put("token", rollbackStage.getString("token")));
        } catch (Exception expected) { discarded = true; }
        require(discarded, "discarded picker token cannot be committed");
    }

    private static void requireRange(JournalStore.MediaResource resource, int status, String contentRange,
                                     byte[] source, int offset, int length, String label) throws Exception {
        require(resource != null && resource.status == status && resource.length == length,
                label + " status and length");
        require(contentRange.equals(resource.contentRange == null ? "" : resource.contentRange), label + " Content-Range");
        byte[] result = readBytes(resource.stream);
        require(java.util.Arrays.equals(result, java.util.Arrays.copyOfRange(source, offset, offset + length)),
                label + " byte contents");
    }

    private static byte[] readBytes(InputStream input) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return out.toByteArray();
        }
    }

    private static void testCopyPhotos(JournalStore store) throws Exception {
        byte[] firstBytes = "copy-source-one".getBytes(StandardCharsets.UTF_8);
        byte[] secondBytes = "copy-source-two".getBytes(StandardCharsets.UTF_8);
        JSONObject first = metadata("copy-source-one", firstBytes, "image/png");
        JSONObject second = metadata("copy-source-two", secondBytes, "image/png");
        store.execute(photoRequest("putPhoto", "copy-source-one", firstBytes, "image/png")
                .put("state", new JSONObject().put("version", 1).put("photos", new JSONArray().put(first).put(second))));
        store.execute(photoRequest("putPhoto", "copy-source-two", secondBytes, "image/png")
                .put("state", new JSONObject().put("version", 1).put("photos", new JSONArray().put(first).put(second))));

        JSONObject firstCopy = metadata("copy-one", firstBytes, "image/png");
        JSONObject secondCopy = metadata("copy-two", secondBytes, "image/png");
        JSONArray copiedPhotos = new JSONArray().put(first).put(second).put(firstCopy).put(secondCopy);
        store.execute(new JSONObject().put("action", "copyPhotos")
                .put("state", new JSONObject().put("version", 1).put("photos", copiedPhotos))
                .put("pairs", new JSONArray()
                        .put(new JSONObject().put("from", "copy-source-one").put("to", "copy-one"))
                        .put(new JSONObject().put("from", "copy-source-two").put("to", "copy-two"))));

        store.execute(new JSONObject().put("action", "deletePhotos")
                .put("state", new JSONObject().put("version", 1).put("photos", new JSONArray().put(second).put(firstCopy).put(secondCopy)))
                .put("ids", new JSONArray().put("copy-source-one")));
        require(store.execute(new JSONObject().put("action", "getPhoto").put("id", "copy-source-one")) == null,
                "deleting original removes its photo index");
        JSONObject retained = store.execute(new JSONObject().put("action", "getPhoto").put("id", "copy-one"));
        require(retained != null && java.util.Arrays.equals(firstBytes, Base64.decode(retained.getString("base64"), Base64.DEFAULT)),
                "copied photo path survives deleting original index");

        store.execute(new JSONObject().put("action", "saveState").put("state", new JSONObject().put("version", 1).put("marker", "before rollback")));
        JSONArray rollbackPhotos = new JSONArray().put(second).put(secondCopy)
                .put(metadata("rollback-one", secondBytes, "image/png"))
                .put(metadata("missing-source", secondBytes, "image/png"))
                .put(metadata("rollback-two", secondBytes, "image/png"));
        boolean rejected = false;
        try {
            store.execute(new JSONObject().put("action", "copyPhotos")
                    .put("state", new JSONObject().put("version", 1).put("marker", "must roll back").put("photos", rollbackPhotos))
                    .put("pairs", new JSONArray()
                            .put(new JSONObject().put("from", "copy-source-two").put("to", "rollback-one"))
                            .put(new JSONObject().put("from", "missing-source").put("to", "rollback-two"))));
        } catch (Exception expected) { rejected = true; }
        require(rejected, "copy with a missing source rejects");
        require("before rollback".equals(store.execute(new JSONObject().put("action", "loadState")).getString("marker")),
                "failed photo copy rolls back state");
        require(store.execute(new JSONObject().put("action", "getPhoto").put("id", "rollback-one")) == null,
                "failed photo copy rolls back earlier photo indexes");
    }

    private static void testSnapshotRetainsPhoto(JournalStore store) throws Exception {
        byte[] bytes = "snapshot-bytes".getBytes(StandardCharsets.UTF_8);
        store.execute(photoRequest("putPhoto", "snap1", bytes, "image/png").put("state", stateWithPhoto("snap1", bytes, "image/png")));
        JSONObject snapshot = store.execute(new JSONObject().put("action", "openSnapshot"));
        store.execute(new JSONObject().put("action", "deletePhotos").put("state", emptyState()).put("ids", new JSONArray().put("snap1")));
        JSONObject photo = store.execute(new JSONObject().put("action", "snapshotPhoto").put("token", snapshot.getString("token")).put("id", "snap1"));
        require(java.util.Arrays.equals(bytes, Base64.decode(photo.getString("base64"), Base64.DEFAULT)), "snapshot lease");
        store.execute(new JSONObject().put("action", "closeSnapshot").put("token", snapshot.getString("token")));
        require(store.execute(new JSONObject().put("action", "getPhoto").put("id", "snap1")) == null, "delete after snapshot close");
    }

    private static void testThumbnailReplacement(JournalStore store) throws Exception {
        byte[] large = bitmapBytes(1280, 800);
        store.execute(photoRequest("putPhoto", "thumb1", large, "image/jpeg")
                .put("state", stateWithPhoto("thumb1", large, "image/jpeg")));
        JSONObject first = store.execute(new JSONObject().put("action", "getPhoto").put("id", "thumb1").put("thumbnail", true));
        byte[] firstBytes = Base64.decode(first.getString("base64"), Base64.DEFAULT);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(firstBytes, 0, firstBytes.length, bounds);
        require(Math.max(bounds.outWidth, bounds.outHeight) <= 640, "thumbnail is bounded");

        byte[] replacement = bitmapBytes(320, 200);
        store.execute(photoRequest("putPhoto", "thumb1", replacement, "image/jpeg")
                .put("state", stateWithPhoto("thumb1", replacement, "image/jpeg")));
        JSONObject second = store.execute(new JSONObject().put("action", "getPhoto").put("id", "thumb1").put("thumbnail", true));
        byte[] secondBytes = Base64.decode(second.getString("base64"), Base64.DEFAULT);
        BitmapFactory.decodeByteArray(secondBytes, 0, secondBytes.length, bounds);
        require(bounds.outWidth == 320 && bounds.outHeight == 200, "replacement invalidates cached thumbnail");
    }

    private static byte[] bitmapBytes(int width, int height) throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565);
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)) throw new AssertionError("bitmap encode");
            return out.toByteArray();
        } finally { bitmap.recycle(); }
    }

    private static void testImportRollback(JournalStore store) throws Exception {
        JSONObject original = new JSONObject().put("version", 1).put("marker", "old").put("photos", new JSONArray());
        store.execute(new JSONObject().put("action", "saveState").put("state", original));
        JSONObject session = store.execute(new JSONObject().put("action", "beginImport"));
        boolean rejected = false;
        try {
            store.execute(new JSONObject().put("action", "commitImport").put("token", session.getString("token"))
                    .put("state", stateWithPhoto("missing", new byte[]{1}, "image/jpeg")));
        } catch (Exception expected) { rejected = true; }
        require(rejected, "import mismatch rejected");
        require("old".equals(store.execute(new JSONObject().put("action", "loadState")).getString("marker")), "import rollback preserves prior state");
        store.execute(new JSONObject().put("action", "abortImport").put("token", session.getString("token")));
    }

    private static void testImportCommit(JournalStore store) throws Exception {
        byte[] bytes = "imported".getBytes(StandardCharsets.UTF_8);
        JSONObject session = store.execute(new JSONObject().put("action", "beginImport"));
        JSONObject metadata = metadata("imp1", bytes, "image/webp");
        store.execute(new JSONObject().put("action", "stagePhoto").put("token", session.getString("token"))
                .put("metadata", metadata).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)));
        store.execute(new JSONObject().put("action", "commitImport").put("token", session.getString("token"))
                .put("state", stateWithPhoto("imp1", bytes, "image/webp")));
        JSONObject result = store.execute(new JSONObject().put("action", "getPhoto").put("id", "imp1"));
        require("image/webp".equals(result.getString("type")), "import commit");
    }

    private static void testAmapNavigationIntent() throws Exception {
        String name = "测试房源 A&B=1";
        Intent intent = MainActivity.buildAmapNavigationIntent(new JSONObject()
                .put("latitude", 31.2304).put("longitude", 121.4737).put("name", name));
        Uri uri = intent.getData();
        require(Intent.ACTION_VIEW.equals(intent.getAction())
                        && intent.hasCategory(Intent.CATEGORY_DEFAULT)
                        && "com.autonavi.minimap".equals(intent.getPackage()), "explicit Amap navigation intent");
        require(uri != null && "androidamap".equals(uri.getScheme()) && "navi".equals(uri.getAuthority())
                        && "看房日记".equals(uri.getQueryParameter("sourceApplication"))
                        && name.equals(uri.getQueryParameter("poiname"))
                        && "31.2304".equals(uri.getQueryParameter("lat"))
                        && "121.4737".equals(uri.getQueryParameter("lon"))
                        && "1".equals(uri.getQueryParameter("dev"))
                        && "2".equals(uri.getQueryParameter("style"))
                        && uri.getQueryParameter("evil") == null,
                "Amap navigation URI parameters and encoding");
        requireInvalidAmap(new JSONObject().put("latitude", "NaN").put("longitude", 1));
        requireInvalidAmap(new JSONObject().put("latitude", 91).put("longitude", 1));
        requireInvalidAmap(new JSONObject().put("latitude", 1).put("longitude", -181));
    }

    private static void requireInvalidAmap(JSONObject request) {
        boolean rejected = false;
        try { MainActivity.buildAmapNavigationIntent(request); }
        catch (IllegalArgumentException expected) { rejected = true; }
        require(rejected, "invalid Amap coordinates rejected");
    }

    private void testAmapPlatformBridge(Activity activity, WebView webView) throws Exception {
        AtomicReference<Intent> capturedIntent = new AtomicReference<>();
        ActivityMonitor monitor = new ActivityMonitor() {
            @Override
            public ActivityResult onStartActivity(Intent intent) {
                if (Intent.ACTION_VIEW.equals(intent.getAction())
                        && "com.autonavi.minimap".equals(intent.getPackage())) {
                    capturedIntent.set(new Intent(intent));
                    return new ActivityResult(Activity.RESULT_OK, null);
                }
                return null;
            }
        };
        addMonitor(monitor);
        try {
            for (int attempt = 1; attempt <= 2; attempt++) {
                String id = "amap-smoke-" + attempt;
                JSONObject request = new JSONObject().put("id", id).put("action", "amapNavigate")
                        .put("latitude", 31.2304).put("longitude", 121.4737).put("name", "桥接验证 A&B");
                String script = "(function(){window.__amapPlatformReply=null;var previous=window.KFNativeReply;"
                        + "window.KFNativeReply=function(replyId,result){if(replyId===" + JSONObject.quote(id)
                        + ")window.__amapPlatformReply=JSON.stringify({id:replyId,result:result});"
                        + "if(previous)previous(replyId,result);};window.KFNative.platform("
                        + JSONObject.quote(request.toString()) + ");})()";
                evaluate(activity, webView, script);
                JSONObject reply = null;
                long deadline = SystemClock.uptimeMillis() + 5_000;
                while (SystemClock.uptimeMillis() < deadline) {
                    String encoded = evaluate(activity, webView, "window.__amapPlatformReply || ''");
                    Object parsed = new org.json.JSONTokener(encoded).nextValue();
                    if (parsed instanceof String && !((String) parsed).isEmpty()) {
                        reply = new JSONObject((String) parsed);
                        break;
                    }
                    SystemClock.sleep(100);
                }
                require(reply != null && id.equals(reply.getString("id")), "Amap bridge reply received");
                JSONObject result = reply.getJSONObject("result");
                require(result.optBoolean("ok") && result.getJSONObject("value").optBoolean("opened"),
                        "Amap bridge returns opened: " + result);
                require(monitor.getHits() == attempt, "Amap intent intercepted without launching external app");
                Intent actual = capturedIntent.get();
                Uri actualUri = actual == null ? null : actual.getData();
                require(actual != null && Intent.ACTION_VIEW.equals(actual.getAction())
                                && actual.hasCategory(Intent.CATEGORY_DEFAULT)
                                && "com.autonavi.minimap".equals(actual.getPackage())
                                && actualUri != null && "androidamap".equals(actualUri.getScheme())
                                && "navi".equals(actualUri.getAuthority())
                                && "桥接验证 A&B".equals(actualUri.getQueryParameter("poiname"))
                                && "1".equals(actualUri.getQueryParameter("dev")),
                        "Amap intent fields observed through native bridge");
            }
        } finally {
            removeMonitor(monitor);
            evaluate(activity, webView, "window.__amapPlatformReply=null");
        }
    }

    private static JSONObject photoRequest(String action, String id, byte[] bytes, String mime) throws Exception {
        return new JSONObject().put("action", action).put("metadata", metadata(id, bytes, mime))
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
    }

    private void testCopyTextPlatformBridge(Activity activity, WebView webView) throws Exception {
        String id = "copy-text-smoke";
        String text = "分享介绍：A&B=1";
        JSONObject request = new JSONObject().put("id", id).put("action", "copyText").put("text", text);
        String script = "(function(){window.__copyTextReply=null;var previous=window.KFNativeReply;"
                + "window.KFNativeReply=function(replyId,result){if(replyId===" + JSONObject.quote(id)
                + ")window.__copyTextReply=JSON.stringify({id:replyId,result:result});"
                + "if(previous)previous(replyId,result);};window.KFNative.platform(" + JSONObject.quote(request.toString()) + ");})()";
        evaluate(activity, webView, script);
        JSONObject reply = null;
        long deadline = SystemClock.uptimeMillis() + 5_000;
        while (SystemClock.uptimeMillis() < deadline) {
            String encoded = evaluate(activity, webView, "window.__copyTextReply || ''");
            Object parsed = new org.json.JSONTokener(encoded).nextValue();
            if (parsed instanceof String && !((String)parsed).isEmpty()) { reply = new JSONObject((String)parsed); break; }
            SystemClock.sleep(100);
        }
        require(reply != null && reply.getJSONObject("result").optBoolean("ok")
                        && reply.getJSONObject("result").getJSONObject("value").optBoolean("copied"),
                "copyText platform bridge success reply");
        android.content.ClipboardManager clipboard = (android.content.ClipboardManager)activity.getSystemService(Activity.CLIPBOARD_SERVICE);
        require(clipboard != null && clipboard.hasPrimaryClip()
                        && text.contentEquals(clipboard.getPrimaryClip().getItemAt(0).coerceToText(activity)),
                "copyText stores exact clipboard text");
        evaluate(activity, webView, "window.__copyTextReply=null");
    }

    private void testTakeVideoPlatformBridge(Activity activity, WebView webView) throws Exception {
        byte[] videoBytes = "mock-mp4-video-stream".getBytes(StandardCharsets.UTF_8);
        require("image/jpeg".equals(activity.getContentResolver().getType(
                        Uri.parse("content://com.kfnote.app.photos/camera/photo-check.jpg")))
                        && activity.getContentResolver().getType(
                        Uri.parse("content://com.kfnote.app.photos/camera/photo-check.png")) == null,
                "PhotoProvider keeps JPEG support and rejects other extensions");
        AtomicReference<Intent> captured = new AtomicReference<>();
        ActivityMonitor success = videoMonitor(activity, captured, videoBytes, Activity.RESULT_OK, null);
        addMonitor(success);
        JSONObject successReply;
        try { successReply = takeVideoReply(activity, webView, "take-video-success"); }
        finally { removeMonitor(success); }

        Intent capture = captured.get();
        require(capture != null && MediaStore.ACTION_VIDEO_CAPTURE.equals(capture.getAction()),
                "takeVideo launches ACTION_VIDEO_CAPTURE");
        Uri output = capture.getParcelableExtra(MediaStore.EXTRA_OUTPUT);
        require(output != null && "video/mp4".equals(activity.getContentResolver().getType(output)),
                "output uses private MP4 PhotoProvider URI and MIME");
        require((capture.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
                        == (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                        && capture.getClipData() != null && output.equals(capture.getClipData().getItemAt(0).getUri()),
                "camera receives output URI read/write grants");
        JSONObject successResult = successReply.getJSONObject("result");
        JSONObject descriptor = successResult.getJSONObject("value");
        require(successResult.optBoolean("ok") && "video/mp4".equals(descriptor.getString("type"))
                        && descriptor.getLong("size") == videoBytes.length && !descriptor.getString("token").isEmpty(),
                "takeVideo returns staged-media descriptor");
        require(!cameraFileFor(activity, output).exists(), "private output is removed after staging");
        JSONObject metadata = new JSONObject().put("id", "take-video-committed")
                .put("type", descriptor.getString("type")).put("size", descriptor.getLong("size"))
                .put("filename", descriptor.getString("name")).put("visitId", JSONObject.NULL)
                .put("sectionKey", "environment");
        JSONObject state = new JSONObject().put("version", 1).put("photos", new JSONArray().put(metadata));
        JSONObject committed = bridgeCall(activity, webView, new JSONObject().put("action", "putPickedMedia")
                .put("state", state).put("metadata", metadata).put("token", descriptor.getString("token")));
        require(committed.optBoolean("ok"), "captured video commits through existing storage action");
        JSONObject loaded = bridgeCall(activity, webView,
                new JSONObject().put("action", "getPhoto").put("id", "take-video-committed"));
        JSONObject loadedVideo = loaded.getJSONObject("value");
        require(loaded.optBoolean("ok") && "video/mp4".equals(loadedVideo.getString("type"))
                        && java.util.Arrays.equals(videoBytes, Base64.decode(loadedVideo.getString("base64"), Base64.DEFAULT)),
                "captured video survives staged-media persistence");

        AtomicReference<Intent> cancelledIntent = new AtomicReference<>();
        ActivityMonitor cancelled = videoMonitor(activity, cancelledIntent, null, Activity.RESULT_CANCELED, null);
        addMonitor(cancelled);
        JSONObject cancelReply;
        try { cancelReply = takeVideoReply(activity, webView, "take-video-cancel"); }
        finally { removeMonitor(cancelled); }
        Uri cancelOutput = cancelledIntent.get().getParcelableExtra(MediaStore.EXTRA_OUTPUT);
        JSONObject cancelResult = cancelReply.getJSONObject("result");
        require(cancelResult.optBoolean("ok") && cancelResult.isNull("value")
                        && !cameraFileFor(activity, cancelOutput).exists(),
                "cancel returns null and removes temporary output");

        AtomicReference<Intent> emptyIntent = new AtomicReference<>();
        ActivityMonitor empty = videoMonitor(activity, emptyIntent, null, Activity.RESULT_OK, null);
        addMonitor(empty);
        JSONObject emptyReply;
        try { emptyReply = takeVideoReply(activity, webView, "take-video-empty"); }
        finally { removeMonitor(empty); }
        Uri emptyOutput = emptyIntent.get().getParcelableExtra(MediaStore.EXTRA_OUTPUT);
        require(!emptyReply.getJSONObject("result").optBoolean("ok")
                        && !cameraFileFor(activity, emptyOutput).exists(),
                "empty successful result reports error and removes temporary output");

        File fallbackFile = new File(new File(activity.getCacheDir(), "camera"), UUID.randomUUID() + ".mp4");
        require(fallbackFile.createNewFile(), "create fallback provider file");
        Uri fallbackUri = Uri.parse("content://com.kfnote.app.photos/camera/" + fallbackFile.getName());
        try (java.io.OutputStream out = activity.getContentResolver().openOutputStream(fallbackUri, "wt")) {
            require(out != null, "open fallback provider file");
            out.write(videoBytes);
        }
        AtomicReference<Intent> fallbackIntent = new AtomicReference<>();
        ActivityMonitor fallback = videoMonitor(activity, fallbackIntent, null, Activity.RESULT_OK, fallbackUri);
        addMonitor(fallback);
        JSONObject fallbackReply;
        try { fallbackReply = takeVideoReply(activity, webView, "take-video-data-fallback"); }
        finally { removeMonitor(fallback); fallbackFile.delete(); }
        JSONObject fallbackResult = fallbackReply.getJSONObject("result");
        JSONObject fallbackDescriptor = fallbackResult.getJSONObject("value");
        require(fallbackResult.optBoolean("ok") && fallbackFile.getName().equals(fallbackDescriptor.getString("name"))
                        && "video/mp4".equals(fallbackDescriptor.getString("type"))
                        && fallbackDescriptor.getLong("size") == videoBytes.length,
                "returned data URI is used when private output is empty");
    }

    private ActivityMonitor videoMonitor(Activity activity, AtomicReference<Intent> captured, byte[] bytes,
                                         int resultCode, Uri returnedData) {
        return new ActivityMonitor() {
            @Override public ActivityResult onStartActivity(Intent intent) {
                if (!MediaStore.ACTION_VIDEO_CAPTURE.equals(intent.getAction())) return null;
                captured.set(new Intent(intent));
                Uri outputUri = intent.getParcelableExtra(MediaStore.EXTRA_OUTPUT);
                if (bytes != null) {
                    try (java.io.OutputStream out = activity.getContentResolver().openOutputStream(outputUri, "wt")) {
                        if (out == null) throw new IOException("camera output unavailable");
                        out.write(bytes);
                    } catch (Exception e) { throw new AssertionError(e); }
                    try (InputStream in = activity.getContentResolver().openInputStream(outputUri)) {
                        require(in != null && java.util.Arrays.equals(bytes, readAll(in)), "provider reads captured MP4 bytes before staging");
                    } catch (Exception e) { throw new AssertionError(e); }
                }
                Intent result = returnedData == null ? null : new Intent().setData(returnedData);
                return new ActivityResult(resultCode, result);
            }
        };
    }

    private JSONObject takeVideoReply(Activity activity, WebView webView, String id) throws Exception {
        JSONObject request = new JSONObject().put("id", id).put("action", "takeVideo");
        String script = "(function(){window.__takeVideoReply=null;var previous=window.KFNativeReply;"
                + "window.KFNativeReply=function(replyId,result){if(replyId===" + JSONObject.quote(id)
                + ")window.__takeVideoReply=JSON.stringify({id:replyId,result:result});"
                + "if(previous)previous(replyId,result);};window.KFNative.platform("
                + JSONObject.quote(request.toString()) + ");})()";
        evaluate(activity, webView, script);
        long deadline = SystemClock.uptimeMillis() + 8_000;
        while (SystemClock.uptimeMillis() < deadline) {
            String encoded = evaluate(activity, webView, "window.__takeVideoReply || ''");
            Object parsed = new org.json.JSONTokener(encoded).nextValue();
            if (parsed instanceof String && !((String) parsed).isEmpty()) {
                JSONObject reply = new JSONObject((String) parsed);
                evaluate(activity, webView, "window.__takeVideoReply=null");
                return reply;
            }
            SystemClock.sleep(100);
        }
        throw new AssertionError("takeVideo bridge reply timed out: " + id);
    }

    private static File cameraFileFor(Activity activity, Uri uri) {
        return new File(new File(activity.getCacheDir(), "camera"), uri.getLastPathSegment());
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        return out.toByteArray();
    }

    private static JSONObject metadata(String id, byte[] bytes, String mime) throws Exception {
        return new JSONObject().put("id", id).put("type", mime).put("size", bytes.length);
    }

    private static JSONObject stateWithPhoto(String id, byte[] bytes, String mime) throws Exception {
        return new JSONObject().put("version", 1).put("photos", new JSONArray().put(metadata(id, bytes, mime)));
    }

    private static JSONObject emptyState() throws Exception {
        return new JSONObject().put("version", 1).put("photos", new JSONArray());
    }

    private void testWebViewUiAndBridge() throws Exception {
        File testRoot = new File(getTargetContext().getCacheDir(), "webview-bridge-instrumentation");
        deleteTree(testRoot);
        MainActivity.instrumentationStoreContext = new StoreTestContext(getTargetContext(), testRoot);
        Activity activity = null;
        try {
            Intent intent = new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(intent);
            View content = activity.findViewById(android.R.id.content);
            WebView webView = findWebView(content);
            require(webView != null, "bundled WebView present");
            String readyScript = "Boolean(window.KFAndroidBack&&window.KFNative&&document.body&&document.body.innerText.includes('买房')&&document.body.innerText.includes('租房'))";
            long deadline = SystemClock.uptimeMillis() + 20_000;
            boolean ready = false;
            while (SystemClock.uptimeMillis() < deadline) {
                if ("true".equals(evaluate(activity, webView, readyScript))) { ready = true; break; }
                SystemClock.sleep(250);
            }
            require(ready, "bundled WebView UI and bridge ready");
            testWindowInsetsGeometry(activity, content, webView);
            testAmapPlatformBridge(activity, webView);
            testCopyTextPlatformBridge(activity, webView);
            testTakeVideoPlatformBridge(activity, webView);

            JSONObject smokeState = new JSONObject().put("version", 1).put("marker", "webview-bridge-smoke")
                    .put("photos", new JSONArray()).put("houses", new JSONArray());
            JSONObject saved = bridgeCall(activity, webView, new JSONObject().put("action", "saveState").put("state", smokeState));
            require(saved.optBoolean("ok"), "WebView bridge save");
            JSONObject loaded = bridgeCall(activity, webView, new JSONObject().put("action", "loadState"));
            require(loaded.optBoolean("ok") && "webview-bridge-smoke".equals(loaded.getJSONObject("value").getString("marker")), "WebView bridge load");
        } finally {
            if (activity != null) runOnMainSync(activity::finish);
            MainActivity.instrumentationStoreContext = null;
            deleteTree(testRoot);
        }
    }

    private void testWindowInsetsGeometry(Activity activity, View content, WebView webView) throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 30) return;
        int left = 23;
        int top = 47;
        int right = 31;
        int bottom = 28;
        WindowInsets normal = testInsets(0);
        dispatchInsetsAndWait(activity, content, normal);
        assertWebViewFrame(activity, webView, left, top, right, bottom, "system bars and cutout");

        int imeBottom = 280;
        dispatchInsetsAndWait(activity, content, testInsets(imeBottom));
        assertWebViewFrame(activity, webView, left, top, right, imeBottom, "IME");

        dispatchInsetsAndWait(activity, content, normal);
        assertWebViewFrame(activity, webView, left, top, right, bottom, "restored insets");
    }

    private static WindowInsets testInsets(int imeBottom) {
        return new WindowInsets.Builder()
                .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, 24, 0, 0))
                .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, 28))
                .setInsets(WindowInsets.Type.displayCutout(), Insets.of(23, 47, 31, 0))
                .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, imeBottom))
                .setVisible(WindowInsets.Type.ime(), imeBottom > 0)
                .build();
    }

    private void dispatchInsetsAndWait(Activity activity, View content, WindowInsets insets) throws Exception {
        runOnMainSync(() -> {
            content.dispatchApplyWindowInsets(insets);
            // ATD has no system bars: a later frame reapplies its real zero insets.
            // Measure the real hierarchy under our injected insets in this same UI turn.
            content.measure(View.MeasureSpec.makeMeasureSpec(content.getWidth(), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(content.getHeight(), View.MeasureSpec.EXACTLY));
            content.layout(content.getLeft(), content.getTop(), content.getRight(), content.getBottom());
            View decor = activity.getWindow().getDecorView();
            WebView child = findWebView(content);
            int[] decorLocation = new int[2], childLocation = new int[2];
            decor.getLocationOnScreen(decorLocation);
            child.getLocationOnScreen(childLocation);
            insetFrame = new int[]{decorLocation[0], decorLocation[1], decor.getWidth(), decor.getHeight(),
                    childLocation[0], childLocation[1], child.getWidth(), child.getHeight()};
            insetFrameDetails = " decor=" + viewState(decor) + " content=" + viewState(content)
                    + " container=" + viewState((View) child.getParent()) + " webView=" + viewState(child);
        });
        waitForIdleSync();
    }

    private void assertWebViewFrame(Activity activity, WebView webView,
                                    int left, int top, int right, int bottom, String phase) throws Exception {
        int expectedLeft = insetFrame[0] + left;
        int expectedTop = insetFrame[1] + top;
        int expectedRight = insetFrame[0] + insetFrame[2] - right;
        int expectedBottom = insetFrame[1] + insetFrame[3] - bottom;
        int actualRight = insetFrame[4] + insetFrame[6];
        int actualBottom = insetFrame[5] + insetFrame[7];
        require(Math.abs(insetFrame[4] - expectedLeft) <= 1
                        && Math.abs(insetFrame[5] - expectedTop) <= 1
                        && Math.abs(actualRight - expectedRight) <= 1
                        && Math.abs(actualBottom - expectedBottom) <= 1,
                "WebView frame avoids insets during " + phase + " expectedLTRB=["
                        + expectedLeft + "," + expectedTop + "," + expectedRight + "," + expectedBottom
                        + "] actualLTRB=[" + insetFrame[4] + "," + insetFrame[5] + ","
                        + actualRight + "," + actualBottom + "]" + insetFrameDetails);
    }

    private static String viewState(View view) {
        int[] location = new int[2];
        view.getLocationOnScreen(location);
        return "[x=" + location[0] + ",y=" + location[1] + ",w=" + view.getWidth()
                + ",h=" + view.getHeight() + ",padding=" + view.getPaddingLeft() + "/"
                + view.getPaddingTop() + "/" + view.getPaddingRight() + "/" + view.getPaddingBottom() + "]";
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private static JSONObject bridgeCall(Activity activity, WebView webView, JSONObject request) throws Exception {
        String response = evaluate(activity, webView, "window.KFNative.storage(" + JSONObject.quote(request.toString()) + ")");
        Object parsed = new org.json.JSONTokener(response).nextValue();
        if (!(parsed instanceof String)) throw new AssertionError("bridge did not return JSON text");
        return new JSONObject((String) parsed);
    }

    private static String evaluate(Activity activity, WebView webView, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        String[] result = new String[1];
        activity.runOnUiThread(() -> webView.evaluateJavascript(script, value -> { result[0] = value; latch.countDown(); }));
        if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("WebView evaluation timed out");
        return result[0];
    }

    private static void deleteTree(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("unable to list test directory");
            for (File child : children) deleteTree(child);
        }
        if (!file.delete()) throw new IOException("unable to delete test file");
    }

    private static final class StoreTestContext extends ContextWrapper {
        private final File root;
        StoreTestContext(Context base, File root) { super(base); this.root = root; }
        @Override public Context getApplicationContext() { return this; }
        @Override public File getFilesDir() { return new File(root, "files"); }
        @Override public File getDatabasePath(String name) {
            File directory = new File(root, "databases");
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IllegalStateException("cannot create test database directory");
            }
            return new File(directory, name);
        }
        @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode, SQLiteDatabase.CursorFactory factory) {
            return openDatabase(name, factory, null);
        }
        @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode, SQLiteDatabase.CursorFactory factory, DatabaseErrorHandler errorHandler) {
            return openDatabase(name, factory, errorHandler);
        }
        private SQLiteDatabase openDatabase(String name, SQLiteDatabase.CursorFactory factory, DatabaseErrorHandler errorHandler) {
            File file = getDatabasePath(name);
            File parent = file.getParentFile();
            if (!parent.isDirectory() && !parent.mkdirs()) throw new IllegalStateException("cannot create test database directory");
            return SQLiteDatabase.openDatabase(file.getPath(), factory, SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.CREATE_IF_NECESSARY, errorHandler);
        }
    }

    private static void require(boolean condition, String name) {
        if (!condition) throw new AssertionError(name);
    }
}
