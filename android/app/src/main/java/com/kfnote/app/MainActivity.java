package com.kfnote.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.FrameLayout;
import android.webkit.JsResult;
import android.webkit.JsPromptResult;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://app.kfnote.local";
    static volatile Context instrumentationStoreContext;
    private static final int REQ_PICK_PHOTOS = 2101;
    private static final int REQ_TAKE_PHOTO = 2102;
    private static final int REQ_LOCATION_PERMISSION = 2103;
    private static final int REQ_EXPORT_BACKUP = 2104;
    private static final int REQ_IMPORT_BACKUP = 2105;
    private static final int REQ_PICK_MEDIA = 2106;
    private static final int REQ_TAKE_VIDEO = 2107;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Object pendingLock = new Object();
    private WebView webView;
    private FrameLayout appContainer;
    private JournalStore journalStore;
    private String pendingId;
    private String pendingAction;
    private String pendingExportBase64;
    private File cameraFile;
    private File cameraVideoFile;
    private LocationManager locationManager;
    private LocationListener locationListener;
    private Runnable locationTimeout;
    private boolean backCheckPending;
    private volatile boolean trustedPage;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            Context storeContext = BuildConfig.DEBUG && instrumentationStoreContext != null
                    ? instrumentationStoreContext : getApplicationContext();
            journalStore = new JournalStore(storeContext);
        } catch (Exception e) {
            showFatal("无法打开本地记录：" + message(e));
            return;
        }
        buildWebView();
        setContentView(appContainer);
        configureSystemBars();
        appContainer.requestApplyInsets();
        webView.loadUrl(ORIGIN + "/index.html");
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        if (Build.VERSION.SDK_INT < 30) window.setStatusBarColor(Color.rgb(48, 114, 246));
        window.setNavigationBarColor(Color.rgb(247, 248, 250));
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            window.getInsetsController().setSystemBarsAppearance(
                    WindowInsetsControllerAppearance.LIGHT_STATUS_BARS | WindowInsetsControllerAppearance.LIGHT_NAVIGATION_BARS,
                    WindowInsetsControllerAppearance.LIGHT_STATUS_BARS | WindowInsetsControllerAppearance.LIGHT_NAVIGATION_BARS);
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(247, 248, 250));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        appContainer = new FrameLayout(this);
        appContainer.setBackgroundColor(Color.rgb(247, 248, 250));
        appContainer.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        appContainer.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                left = bars.left;
                top = bars.top;
                right = bars.right;
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28) {
                    android.view.DisplayCutout cutout = insets.getDisplayCutout();
                    if (cutout != null) {
                        left = Math.max(left, cutout.getSafeInsetLeft());
                        top = Math.max(top, cutout.getSafeInsetTop());
                        right = Math.max(right, cutout.getSafeInsetRight());
                        bottom = Math.max(bottom, cutout.getSafeInsetBottom());
                    }
                }
            }
            view.setPadding(left, top, right, bottom);
            if (Build.VERSION.SDK_INT >= 30) return WindowInsets.CONSUMED;
            WindowInsets consumed = insets.consumeSystemWindowInsets().consumeStableInsets();
            if (Build.VERSION.SDK_INT >= 28) consumed = consumed.consumeDisplayCutout();
            return consumed;
        });
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new NativeBridge(), "KFNative");
        webView.setWebViewClient(new LocalWebViewClient());
        webView.setWebChromeClient(new DialogChromeClient());
    }

    private boolean isTrustedPage() {
        return trustedPage;
    }

    private final class NativeBridge {
        @JavascriptInterface
        public String storage(String json) {
            if (!isTrustedPage()) return failure("本地页面来源无效");
            try {
                JSONObject request = new JSONObject(json);
                JSONObject value = journalStore.execute(request);
                return success(value);
            } catch (Exception e) {
                return failure(message(e));
            }
        }

        @JavascriptInterface
        public void platform(String json) {
            if (!isTrustedPage()) return;
            final JSONObject request;
            try {
                request = new JSONObject(json);
            } catch (Exception e) {
                return;
            }
            mainHandler.post(() -> startPlatformAction(request));
        }
    }

    private final class LocalWebViewClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            trustedPage = isLocalUri(Uri.parse(url));
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            trustedPage = isLocalUri(Uri.parse(url));
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isLocalUri(uri)) return response(403, "Forbidden", "text/plain", new byte[0]);
            if (!"GET".equalsIgnoreCase(request.getMethod())) return response(405, "Method Not Allowed", "text/plain", new byte[0]);
            String path = uri.getPath();
            if (path == null || path.contains("\\") || path.contains("\u0000")) return response(400, "Bad Request", "text/plain", new byte[0]);
            for (String segment : path.split("/")) if ("..".equals(segment)) return response(400, "Bad Request", "text/plain", new byte[0]);
            if (path.startsWith("/media/")) return mediaResponse(request, path);
            if ("/".equals(path)) path = "/index.html";
            String asset = "public" + path;
            try (InputStream input = getAssets().open(asset)) {
                return response(200, "OK", mimeType(path), readStream(input, 5 * 1024 * 1024));
            } catch (IOException e) {
                return response(404, "Not Found", "text/plain", new byte[0]);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isLocalUri(uri)) return false;
            if ("tel".equals(uri.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_DIAL, uri));
                } catch (Exception ignored) {
                    showToast("无法打开拨号界面");
                }
            }
            return true;
        }

        private WebResourceResponse mediaResponse(WebResourceRequest request, String path) {
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("^/media/([A-Za-z0-9_-]+)$").matcher(path);
            if (!matcher.matches()) return response(404, "Not Found", "text/plain", new byte[0]);
            String range = null;
            for (java.util.Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
                if ("range".equalsIgnoreCase(header.getKey())) { range = header.getValue(); break; }
            }
            try {
                JournalStore.MediaResource media = journalStore.openMediaForWebView(matcher.group(1), range);
                if (media == null) return response(404, "Not Found", "text/plain", new byte[0]);
                java.util.Map<String, String> headers = new java.util.HashMap<>();
                headers.put("Accept-Ranges", "bytes");
                headers.put("Content-Length", Long.toString(media.length));
                headers.put("X-Content-Type-Options", "nosniff");
                headers.put("Content-Security-Policy", contentSecurityPolicy());
                if (media.contentRange != null) headers.put("Content-Range", media.contentRange);
                return new WebResourceResponse(media.mime, null, media.status, media.reason, headers, media.stream);
            } catch (Exception e) {
                return response(404, "Not Found", "text/plain", new byte[0]);
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
        }
    }

    private static boolean isLocalUri(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "app.kfnote.local".equals(uri.getHost())
                && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    private static WebResourceResponse response(int status, String reason, String mime, byte[] data) {
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Content-Security-Policy", contentSecurityPolicy());
        return new WebResourceResponse(mime, "UTF-8", status, reason, headers, new java.io.ByteArrayInputStream(data));
    }

    private static String contentSecurityPolicy() {
        return "default-src 'self' data: blob:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    }

    private static String mimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js")) return "text/javascript";
        if (lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".avif")) return "image/avif";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private final class DialogChromeClient extends WebChromeClient {
        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            if (!isTrustedPage()) { result.cancel(); return true; }
            new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定", (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel()).show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            if (!isTrustedPage()) { result.cancel(); return true; }
            new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton("确定", (dialog, which) -> result.confirm())
                    .setNegativeButton("取消", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel()).show();
            return true;
        }
    }

    private void startPlatformAction(JSONObject request) {
        if (!isTrustedPage()) return;
        String id = request.optString("id", "");
        String action = request.optString("action", "");
        if (id.isEmpty()) return;
        synchronized (pendingLock) {
            if (pendingId != null) {
                reply(id, failureObject("另一个系统操作正在进行"));
                return;
            }
            pendingId = id;
            pendingAction = action;
        }
        try {
            switch (action) {
                case "pickPhotos": launchPhotoPicker(); break;
                case "pickMedia": launchMediaPicker(); break;
                case "takePhoto": launchCamera(); break;
                case "takeVideo": launchVideoCamera(); break;
                case "location": requestLocation(); break;
                case "appSettings": openAppSettings(); break;
                case "amapNavigate": launchAmapNavigation(request); break;
                case "copyText": copyText(request.optString("text", "")); break;
                case "exportBackup": launchExport(request.optString("base64", ""), request.optString("name", "看房日记备份.zip")); break;
                case "importBackup": launchImport(); break;
                default: finishPlatformError("不支持的系统操作");
            }
        } catch (Exception e) {
            finishPlatformError(message(e));
        }
    }

    private void launchPhotoPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, REQ_PICK_PHOTOS);
    }

    private void launchMediaPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, REQ_PICK_MEDIA);
    }

    private void copyText(String text) throws Exception {
        ClipboardManager clipboard = (ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
        if (clipboard == null) throw new IOException("无法使用剪贴板");
        clipboard.setPrimaryClip(ClipData.newPlainText("看房日记", text));
        finishPlatformValue(new JSONObject().put("copied", true));
    }

    private void openAppSettings() throws Exception {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null));
        startActivity(intent);
        finishPlatformValue(new JSONObject().put("opened", true));
    }

    private void launchAmapNavigation(JSONObject request) throws Exception {
        try {
            startActivity(buildAmapNavigationIntent(request));
            finishPlatformValue(new JSONObject().put("opened", true));
        } catch (android.content.ActivityNotFoundException e) {
            finishPlatformError("未安装高德地图，请安装后重试");
        }
    }

    static Intent buildAmapNavigationIntent(JSONObject request) {
        final double latitude;
        final double longitude;
        try {
            latitude = request.getDouble("latitude");
            longitude = request.getDouble("longitude");
        } catch (Exception e) {
            throw new IllegalArgumentException("坐标无效", e);
        }
        if (!Double.isFinite(latitude) || !Double.isFinite(longitude)
                || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            throw new IllegalArgumentException("坐标超出有效范围");
        }
        Uri uri = new Uri.Builder().scheme("androidamap").authority("navi")
                .appendQueryParameter("sourceApplication", "看房日记")
                .appendQueryParameter("poiname", request.optString("name", ""))
                .appendQueryParameter("lat", Double.toString(latitude))
                .appendQueryParameter("lon", Double.toString(longitude))
                .appendQueryParameter("dev", "1")
                .appendQueryParameter("style", "2")
                .build();
        return new Intent(Intent.ACTION_VIEW, uri)
                .addCategory(Intent.CATEGORY_DEFAULT)
                .setPackage("com.autonavi.minimap");
    }

    private void launchCamera() throws IOException {
        File directory = new File(getCacheDir(), "camera");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建拍照暂存目录");
        cameraFile = new File(directory, UUID.randomUUID() + ".jpg");
        if (!cameraFile.createNewFile()) throw new IOException("无法创建拍照暂存文件");
        Uri uri = Uri.parse("content://com.kfnote.app.photos/camera/" + cameraFile.getName());
        Intent intent = new Intent("android.media.action.IMAGE_CAPTURE");
        intent.putExtra("output", uri);
        intent.setClipData(ClipData.newRawUri("相机照片", uri));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(intent, REQ_TAKE_PHOTO);
    }

    private void launchVideoCamera() throws IOException {
        File directory = new File(getCacheDir(), "camera");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建录像暂存目录");
        cameraVideoFile = new File(directory, UUID.randomUUID() + ".mp4");
        if (!cameraVideoFile.createNewFile()) {
            cameraVideoFile = null;
            throw new IOException("无法创建录像暂存文件");
        }
        Uri uri = Uri.parse("content://com.kfnote.app.photos/camera/" + cameraVideoFile.getName());
        Intent intent = new Intent(MediaStore.ACTION_VIDEO_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
        intent.setClipData(ClipData.newRawUri("现场录像", uri));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            startActivityForResult(intent, REQ_TAKE_VIDEO);
        } catch (RuntimeException e) {
            try { cleanupCameraVideoFile(); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
            throw e;
        }
    }

    private void launchExport(String base64, String name) {
        pendingExportBase64 = base64;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, safeBackupName(name));
        startActivityForResult(intent, REQ_EXPORT_BACKUP);
    }

    private void launchImport() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        startActivityForResult(intent, REQ_IMPORT_BACKUP);
    }

    private static String safeBackupName(String name) {
        String safe = name.replaceAll("[^A-Za-z0-9_().\u4e00-\u9fff-]", "_");
        if (!safe.toLowerCase(Locale.ROOT).endsWith(".zip")) safe += ".zip";
        return safe.length() > 100 ? safe.substring(safe.length() - 100) : safe;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_PHOTOS) {
            if (resultCode != RESULT_OK || data == null) { finishPlatformValue(null); return; }
            List<Uri> uris = selectedUris(data);
            ioExecutor.execute(() -> {
                try {
                    JSONArray photos = new JSONArray();
                    for (Uri uri : uris) photos.put(readSelectedPhoto(uri));
                    finishPlatformValue(photos);
                } catch (Exception e) { finishPlatformError(message(e)); }
            });
        } else if (requestCode == REQ_PICK_MEDIA) {
            if (resultCode != RESULT_OK || data == null) { finishPlatformValue(null); return; }
            List<Uri> uris = selectedUris(data);
            if (uris.isEmpty()) { finishPlatformValue(null); return; }
            ioExecutor.execute(() -> {
                JSONArray descriptors = new JSONArray();
                JSONArray tokens = new JSONArray();
                try {
                    for (Uri uri : uris) {
                        try (InputStream in = getContentResolver().openInputStream(uri)) {
                            if (in == null) throw new IOException("无法读取所选媒体");
                            String mime = normalizeMediaMime(getContentResolver().getType(uri));
                            JSONObject descriptor = journalStore.stagePickedMedia(in, mime, displayName(uri));
                            descriptors.put(descriptor);
                            tokens.put(descriptor.getString("token"));
                        }
                    }
                    finishPlatformValue(descriptors);
                } catch (Exception e) {
                    try { journalStore.execute(new JSONObject().put("action", "discardPickedMedia").put("tokens", tokens)); }
                    catch (Exception cleanup) { e.addSuppressed(cleanup); }
                    finishPlatformError(message(e));
                }
            });
        } else if (requestCode == REQ_TAKE_PHOTO) {
            if (resultCode != RESULT_OK || cameraFile == null || !cameraFile.isFile()) {
                try { cleanupCameraFile(); finishPlatformValue(null); }
                catch (IOException e) { finishPlatformError(message(e)); }
                return;
            }
            File photo = cameraFile;
            ioExecutor.execute(() -> {
                try {
                    byte[] bytes = readFileLimited(photo, Long.MAX_VALUE);
                    JSONObject result = new JSONObject().put("name", photo.getName()).put("type", "image/jpeg")
                            .put("size", bytes.length).put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                    deleteFile(photo);
                    mainHandler.post(() -> { if (cameraFile == photo) cameraFile = null; });
                    finishPlatformValue(result);
                } catch (Exception e) {
                    try { deleteFile(photo); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
                    finishPlatformError(message(e));
                }
            });
        } else if (requestCode == REQ_TAKE_VIDEO) {
            if (resultCode != RESULT_OK) {
                try { cleanupCameraVideoFile(); finishPlatformValue(null); }
                catch (IOException e) { finishPlatformError(message(e)); }
                return;
            }
            File video = cameraVideoFile;
            Uri returnedUri = data == null ? null : data.getData();
            ioExecutor.execute(() -> {
                try {
                    JSONObject descriptor;
                    if (video != null && video.isFile() && video.length() > 0) {
                        try (InputStream in = new FileInputStream(video)) {
                            descriptor = journalStore.stagePickedMedia(in, "video/mp4", video.getName());
                        }
                    } else if (returnedUri != null) {
                        String mime = normalizeMediaMime(getContentResolver().getType(returnedUri));
                        String name = displayName(returnedUri);
                        if (name == null || name.trim().isEmpty()) name = "现场录像.mp4";
                        try (InputStream in = getContentResolver().openInputStream(returnedUri)) {
                            if (in == null) throw new IOException("无法读取录像文件");
                            descriptor = journalStore.stagePickedMedia(in, mime, name);
                        }
                    } else {
                        throw new IOException("录像文件为空");
                    }
                    if (video != null) deleteFile(video);
                    mainHandler.post(() -> { if (cameraVideoFile == video) cameraVideoFile = null; });
                    finishPlatformValue(descriptor);
                } catch (Exception e) {
                    if (video != null) {
                        try { deleteFile(video); } catch (IOException cleanup) { e.addSuppressed(cleanup); }
                    }
                    mainHandler.post(() -> { if (cameraVideoFile == video) cameraVideoFile = null; });
                    finishPlatformError(message(e));
                }
            });
        } else if (requestCode == REQ_EXPORT_BACKUP) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) { finishPlatformValue(null); return; }
            Uri uri = data.getData();
            String base64 = pendingExportBase64;
            ioExecutor.execute(() -> {
                try {
                    byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                    try (OutputStream out = getContentResolver().openOutputStream(uri, "w")) {
                        if (out == null) throw new IOException("无法写入所选备份文件");
                        out.write(bytes);
                        out.flush();
                    }
                    finishPlatformValue(new JSONObject().put("saved", true));
                } catch (Exception e) { finishPlatformError(message(e)); }
                finally { pendingExportBase64 = null; }
            });
        } else if (requestCode == REQ_IMPORT_BACKUP) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) { finishPlatformValue(null); return; }
            Uri uri = data.getData();
            ioExecutor.execute(() -> {
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    if (in == null) throw new IOException("无法读取所选备份文件");
                    byte[] bytes = readStream(in, Long.MAX_VALUE);
                    JSONObject result = new JSONObject().put("name", displayName(uri)).put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                    finishPlatformValue(result);
                } catch (Exception e) { finishPlatformError(message(e)); }
            });
        }
    }

    private List<Uri> selectedUris(Intent data) {
        List<Uri> result = new ArrayList<>();
        if (data.getClipData() != null) {
            ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) result.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) result.add(data.getData());
        return result;
    }

    private JSONObject readSelectedPhoto(Uri uri) throws Exception {
        String mime = normalizeImageMime(getContentResolver().getType(uri));
        File tempDirectory = new File(getCacheDir(), "incoming");
        if (!tempDirectory.isDirectory() && !tempDirectory.mkdirs()) throw new IOException("无法创建照片暂存目录");
        File temp = new File(tempDirectory, UUID.randomUUID() + extensionForMime(mime));
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(temp)) {
            if (in == null) throw new IOException("无法读取所选照片");
            copyLimited(in, out, Long.MAX_VALUE);
        }
        try {
            byte[] bytes = readFileLimited(temp, Long.MAX_VALUE);
            return new JSONObject().put("name", displayName(uri)).put("type", mime).put("size", bytes.length)
                    .put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
        } finally { deleteFile(temp); }
    }

    private static String normalizeImageMime(String mime) throws IOException {
        if ("image/jpg".equals(mime)) mime = "image/jpeg";
        try { return JournalStore.checkedMime(mime); }
        catch (IOException e) { throw new IOException("所选文件不是支持的照片格式", e); }
    }

    private static String normalizeMediaMime(String mime) throws IOException {
        if ("image/jpg".equals(mime)) mime = "image/jpeg";
        try { return JournalStore.checkedMime(mime); }
        catch (IOException e) { throw new IOException("所选文件不是支持的图片或视频格式", e); }
    }

    private static String extensionForMime(String mime) {
        switch (mime) {
            case "image/png": return ".png";
            case "image/webp": return ".webp";
            case "image/gif": return ".gif";
            case "image/avif": return ".avif";
            default: return ".jpg";
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) { }
        String last = uri.getLastPathSegment();
        return last == null ? "文件" : last;
    }

    private void requestLocation() {
        if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}, REQ_LOCATION_PERMISSION);
            return;
        }
        beginLocationRequest();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION_PERMISSION) return;
        boolean granted = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (granted) beginLocationRequest(); else finishPlatformError("未获得定位权限");
    }

    private void beginLocationRequest() {
        try {
            locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
            Criteria criteria = new Criteria();
            criteria.setAccuracy(Criteria.ACCURACY_FINE);
            String provider = locationManager.getBestProvider(criteria, true);
            if (provider == null) {
                provider = locationManager.getBestProvider(new Criteria(), true);
            }
            if (provider == null || !locationManager.isProviderEnabled(provider)) {
                finishPlatformError("请开启设备定位服务");
                return;
            }
            locationListener = new LocationListener() {
                @Override public void onLocationChanged(Location location) {
                    try {
                        JSONObject value = new JSONObject().put("latitude", location.getLatitude())
                                .put("longitude", location.getLongitude()).put("accuracy", location.getAccuracy());
                        finishPlatformValue(value);
                    } catch (Exception e) { finishPlatformError(message(e)); }
                    clearLocationRequest();
                }
                @Override public void onProviderDisabled(String providerName) { }
                @Override public void onProviderEnabled(String providerName) { }
                @Override public void onStatusChanged(String providerName, int status, Bundle extras) { }
            };
            locationManager.requestSingleUpdate(provider, locationListener, Looper.getMainLooper());
            locationTimeout = () -> {
                clearLocationRequest();
                finishPlatformError("定位超时，请检查定位服务后重试");
            };
            mainHandler.postDelayed(locationTimeout, 15_000);
        } catch (SecurityException e) {
            finishPlatformError("未获得定位权限");
        } catch (Exception e) {
            finishPlatformError(message(e));
        }
    }

    private void clearLocationRequest() {
        if (locationTimeout != null) mainHandler.removeCallbacks(locationTimeout);
        locationTimeout = null;
        if (locationManager != null && locationListener != null) {
            try { locationManager.removeUpdates(locationListener); } catch (SecurityException ignored) { }
        }
        locationListener = null;
    }

    private void finishPlatformValue(Object value) {
        JSONObject result = new JSONObject();
        try { result.put("ok", true).put("value", value == null ? JSONObject.NULL : value); }
        catch (Exception ignored) { finishPlatformError("无法生成系统操作结果"); return; }
        completePlatform(result);
    }

    private void finishPlatformError(String error) {
        completePlatform(failureObject(error));
    }

    private void completePlatform(JSONObject result) {
        String id;
        synchronized (pendingLock) {
            id = pendingId;
            pendingId = null;
            pendingAction = null;
        }
        if (id != null) reply(id, result);
    }

    private void reply(String id, JSONObject result) {
        if (webView == null) return;
        String js = "window.KFNativeReply&&window.KFNativeReply(" + JSONObject.quote(id) + "," + result.toString() + ")";
        mainHandler.post(() -> { if (webView != null) webView.evaluateJavascript(js, null); });
    }

    private void cleanupCameraFile() throws IOException {
        if (cameraFile != null) deleteFile(cameraFile);
        cameraFile = null;
    }

    private void cleanupCameraVideoFile() throws IOException {
        if (cameraVideoFile != null) deleteFile(cameraVideoFile);
        cameraVideoFile = null;
    }

    private static JSONObject failureObject(String message) {
        JSONObject value = new JSONObject();
        try { value.put("ok", false).put("error", message == null || message.isEmpty() ? "系统操作失败" : message); }
        catch (Exception ignored) { }
        return value;
    }

    private static String success(JSONObject value) {
        JSONObject result = new JSONObject();
        try { result.put("ok", true).put("value", value == null ? JSONObject.NULL : value); return result.toString(); }
        catch (Exception e) { return failure("无法生成本地操作结果"); }
    }

    private static String failure(String message) { return failureObject(message).toString(); }

    private static String message(Exception e) {
        String text = e.getMessage();
        return text != null && text.matches(".*[\\u4e00-\\u9fff].*") ? text : "本地操作失败，请检查存储空间或重试";
    }

    private static byte[] readStream(InputStream input, long maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        copyLimited(input, out, maxBytes);
        return out.toByteArray();
    }

    private static byte[] readFileLimited(File file, long maxBytes) throws IOException {
        try (InputStream in = new FileInputStream(file)) { return readStream(in, maxBytes); }
    }

    private static void copyLimited(InputStream input, OutputStream output, long maxBytes) throws IOException {
        byte[] buffer = new byte[8192];
        int count;
        long total = 0;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > maxBytes) throw new IOException("文件大小超出限制");
            output.write(buffer, 0, count);
        }
    }

    private static void deleteFile(File file) throws IOException {
        if (file != null && file.exists() && !file.delete()) throw new IOException("无法清理应用暂存文件");
    }

    private void showFatal(String message) {
        new AlertDialog.Builder(this).setTitle("看房日记").setMessage(message)
                .setPositiveButton("关闭", (dialog, which) -> finish()).show();
    }

    private void showToast(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) { super.onBackPressed(); return; }
        if (backCheckPending) return;
        backCheckPending = true;
        webView.evaluateJavascript("window.KFAndroidBack ? window.KFAndroidBack() : false", value -> {
            backCheckPending = false;
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onDestroy() {
        clearLocationRequest();
        if (pendingId != null) finishPlatformError("系统操作已中断");
        try { cleanupCameraFile(); }
        catch (IOException e) { showToast(message(e)); }
        try { cleanupCameraVideoFile(); }
        catch (IOException e) { showToast(message(e)); }
        if (webView != null) {
            webView.removeJavascriptInterface("KFNative");
            webView.destroy();
            webView = null;
        }
        if (journalStore != null) journalStore.close();
        ioExecutor.shutdownNow();
        super.onDestroy();
    }

    private static final class WindowInsetsControllerAppearance {
        static final int LIGHT_STATUS_BARS = Build.VERSION.SDK_INT >= 30
                ? android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0;
        static final int LIGHT_NAVIGATION_BARS = Build.VERSION.SDK_INT >= 30
                ? android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0;
    }
}
