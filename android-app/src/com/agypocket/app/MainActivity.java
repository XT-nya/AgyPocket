package com.agypocket.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends Activity {

    private static final String PREFS_NAME = "agypocket_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_CONN_MODE = "connection_mode";
    private static final String KEY_DEVICE_NAME = "device_name";
    private static final String KEY_DEVICES_JSON = "saved_devices_json";
    private static final String KEY_CHAT_IMMERSIVE = "chat_immersive";
    private static final String KEY_CERT_PIN_PREFIX = "cert_pin_";

    private static final String MODE_FIXED = "fixed";
    private static final String MODE_TEMP = "temp";

    private static final int FILE_CHOOSER_REQ = 1001;
    private static final int QR_SCAN_REQ = 1002;

    private FrameLayout rootContainer;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> filePathCallback;

    private SharedPreferences prefs;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, List<SslErrorHandler>> pendingSslHandlers = new HashMap<>();

    private boolean remoteFullscreen = false;
    private boolean chatImmersive = false;
    private long lastBackPressAt = 0L;
    private long lastThreeFingerAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        chatImmersive = prefs.getBoolean(KEY_CHAT_IMMERSIVE, false);

        configureWindow();

        rootContainer = new FrameLayout(this);
        rootContainer.setBackgroundColor(0xFF090B10);
        setContentView(rootContainer);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF090B10);
        rootContainer.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        setupWebView();
        applySystemBars();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            startSmartConnectFlow();
        }
    }

    private void configureWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(0xFF090B10);
        window.setNavigationBarColor(0xFF090B10);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
    }

    @SuppressWarnings("deprecation")
    private void applySystemBars() {
        boolean hideBars = remoteFullscreen || customView != null;
        boolean hideStatusOnly = !hideBars && chatImmersive;

        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(!hideBars);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                if (hideBars) {
                    controller.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    controller.hide(WindowInsets.Type.systemBars());
                } else if (hideStatusOnly) {
                    controller.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    controller.hide(WindowInsets.Type.statusBars());
                    controller.show(WindowInsets.Type.navigationBars());
                } else {
                    controller.show(WindowInsets.Type.systemBars());
                }
            }
        } else {
            View decor = window.getDecorView();
            if (hideBars) {
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN);
            } else if (hideStatusOnly) {
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_FULLSCREEN);
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applySystemBars();
        }
    }

    private void setupWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setSupportZoom(true);
        ws.setBuiltInZoomControls(true);
        ws.setDisplayZoomControls(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        ws.setUserAgentString(ws.getUserAgentString() + " AgyPocketApp/2.1");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new NativeBridge(), "AgyPocketNative");

        webView.setOnTouchListener((v, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_POINTER_DOWN
                    && event.getPointerCount() == 3) {
                long now = System.currentTimeMillis();
                if (now - lastThreeFingerAt > 600) {
                    lastThreeFingerAt = now;
                    mainHandler.post(this::showServerConfigDialog);
                    return true;
                }
            }
            return false;
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
                if (!scheme.equals("http") && !scheme.equals("https")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handleScopedSslError(handler, error);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    String desc = error != null && error.getDescription() != null
                            ? error.getDescription().toString()
                            : "无法连接到远程服务端";
                    showOfflineFallbackPage(desc);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent;
                try {
                    intent = fileChooserParams.createIntent();
                } catch (Exception e) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), FILE_CHOOSER_REQ);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                rootContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                applySystemBars();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                rootContainer.removeView(customView);
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
                setRequestedOrientation(remoteFullscreen
                        ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                applySystemBars();
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
                downloadMediaWithCookies(url, userAgent, contentDisposition, mimetype));
    }

    private void startSmartConnectFlow() {
        String currentUrl = getServerUrl();
        if (currentUrl.isEmpty()) {
            showOfflineFallbackPage("尚未配置电脑端连接地址，请扫描电脑启动器二维码。");
            openQrScannerInternal("首次使用：请扫描电脑启动器生成的二合一二维码");
            return;
        }
        probeAndLoadServer(currentUrl, getConnectionMode());
    }

    private void probeAndLoadServer(String targetUrl, String modeAtStart) {
        showConnectingPage(targetUrl, getDeviceName(), modeAtStart);
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL healthUrl = new URL(targetUrl.replaceAll("/+$", "") + "/api/health");
                conn = (HttpURLConnection) healthUrl.openConnection();
                if (conn instanceof HttpsURLConnection) {
                    applyPinnedTrustIfSaved((HttpsURLConnection) conn, healthUrl, targetUrl);
                }
                conn.setConnectTimeout(2500);
                conn.setReadTimeout(2500);
                conn.setRequestMethod("GET");
                int code = conn.getResponseCode();
                if (code != 200) {
                    throw new IllegalStateException("HTTP " + code);
                }
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        sb.append(line);
                    }
                }
                JSONObject json = new JSONObject(sb.toString());
                if (!"agypocket".equals(json.optString("service"))) {
                    throw new IllegalStateException("非 AgyPocket 服务端响应");
                }
                String srvName = json.optString("device_name", "");
                String srvMode = json.optString("connection_mode", "");
                mainHandler.post(() -> {
                    if (!srvName.isEmpty() || !srvMode.isEmpty()) {
                        String finalName = srvName.isEmpty() ? getDeviceName() : srvName;
                        String finalMode = (MODE_TEMP.equals(srvMode) || MODE_FIXED.equals(srvMode))
                                ? srvMode
                                : modeAtStart;
                        saveActiveDevice(targetUrl, finalMode, finalName);
                    }
                    webView.loadUrl(targetUrl);
                });
            } catch (Exception ex) {
                String msg = ex.getMessage() != null ? ex.getMessage() : ex.getClass().getSimpleName();
                mainHandler.post(() -> {
                    if (MODE_TEMP.equals(modeAtStart)) {
                        showOfflineFallbackPage("临时隧道地址已失效（" + msg + "），正在打开扫码...");
                        openQrScannerInternal("临时隧道地址已失效，请扫描电脑最新二维码");
                    } else {
                        showOfflineFallbackPage("连接失败: " + msg);
                    }
                });
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void openQrScannerInternal(String hint) {
        Intent intent = new Intent(this, QrScanActivity.class);
        if (hint != null && !hint.isEmpty()) {
            intent.putExtra(QrScanActivity.EXTRA_HINT, hint);
        }
        startActivityForResult(intent, QR_SCAN_REQ);
    }

    private void handleScopedSslError(SslErrorHandler handler, SslError error) {
        if (error == null || error.getUrl() == null) {
            handler.cancel();
            return;
        }
        Uri errUri = Uri.parse(error.getUrl());
        Uri cfgUri = Uri.parse(getServerUrl());
        String errHost = errUri.getHost();
        String cfgHost = cfgUri.getHost();
        if (errHost == null || cfgHost == null || !errHost.equalsIgnoreCase(cfgHost)) {
            handler.cancel();
            return;
        }
        int errPort = errUri.getPort() > 0 ? errUri.getPort() : 443;
        String fingerprint = computeCertSha256(error.getCertificate());
        String pinKey = KEY_CERT_PIN_PREFIX + errHost.toLowerCase(Locale.US) + ":" + errPort;
        String saved = prefs.getString(pinKey, "");

        if (!saved.isEmpty() && saved.equalsIgnoreCase(fingerprint)) {
            handler.proceed();
            return;
        }

        String queueKey = errHost.toLowerCase(Locale.US) + ":" + errPort + "|" + fingerprint;
        synchronized (pendingSslHandlers) {
            List<SslErrorHandler> list = pendingSslHandlers.get(queueKey);
            boolean first = (list == null);
            if (first) {
                list = new ArrayList<>();
                pendingSslHandlers.put(queueKey, list);
            }
            list.add(handler);
            if (!first) return;
        }

        mainHandler.post(() -> {
            if (isFinishing() || isDestroyed()) {
                resolveSslQueue(queueKey, false);
                return;
            }
            new AlertDialog.Builder(this)
                    .setTitle("确认自签 / 新 HTTPS 证书")
                    .setMessage("主机: " + errHost + ":" + errPort
                            + "\nSHA-256 指纹:\n" + fingerprint
                            + "\n\n如果这是你的远程穿透自签证书，点击“信任并记住”后以后将自动放行。")
                    .setPositiveButton("信任并记住", (d, w) -> {
                        prefs.edit().putString(pinKey, fingerprint).apply();
                        resolveSslQueue(queueKey, true);
                    })
                    .setNegativeButton("取消", (d, w) -> resolveSslQueue(queueKey, false))
                    .setOnCancelListener(d -> resolveSslQueue(queueKey, false))
                    .show();
        });
    }

    private void resolveSslQueue(String queueKey, boolean proceed) {
        List<SslErrorHandler> handlers;
        synchronized (pendingSslHandlers) {
            handlers = pendingSslHandlers.remove(queueKey);
        }
        if (handlers == null) return;
        for (SslErrorHandler h : handlers) {
            if (proceed) h.proceed();
            else h.cancel();
        }
    }

    private static String computeCertSha256(SslCertificate cert) {
        if (cert == null) return "UNKNOWN";
        try {
            byte[] der = null;
            if (Build.VERSION.SDK_INT >= 29) {
                X509Certificate x509 = cert.getX509Certificate();
                if (x509 != null) der = x509.getEncoded();
            } else {
                Bundle bundle = SslCertificate.saveState(cert);
                if (bundle != null) der = bundle.getByteArray("x509-certificate");
            }
            byte[] source = der != null ? der : cert.toString().getBytes(StandardCharsets.UTF_8);
            return sha256HexColon(source);
        } catch (Exception e) {
            return "ERR:" + e.getClass().getSimpleName();
        }
    }

    private static String sha256HexColon(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < digest.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format(Locale.US, "%02X", digest[i] & 0xFF));
        }
        return sb.toString();
    }

    private void fetchAndPinCertTofu(String originUrl) {
        try {
            URL url = new URL(originUrl);
            if (!"https".equalsIgnoreCase(url.getProtocol())) return;
            String host = url.getHost();
            int port = url.getPort() > 0 ? url.getPort() : 443;
            if (host == null || host.isEmpty()) return;

            final String[] capturedFingerprint = new String[1];
            X509TrustManager tofuCaptureTm = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    if (chain != null && chain.length > 0) {
                        try {
                            capturedFingerprint[0] = sha256HexColon(chain[0].getEncoded());
                        } catch (Exception ignored) {
                        }
                    }
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            };

            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, new TrustManager[]{tofuCaptureTm}, null);
            HttpsURLConnection conn = (HttpsURLConnection) new URL(originUrl + "/api/health").openConnection();
            conn.setSSLSocketFactory(sc.getSocketFactory());
            conn.setHostnameVerifier((hostname, session) -> hostname.equalsIgnoreCase(host));
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
            try {
                conn.connect();
                conn.getResponseCode();
            } finally {
                conn.disconnect();
            }

            if (capturedFingerprint[0] != null && !capturedFingerprint[0].isEmpty()) {
                String pinKey = KEY_CERT_PIN_PREFIX + host.toLowerCase(Locale.US) + ":" + port;
                prefs.edit().putString(pinKey, capturedFingerprint[0]).apply();
            }
        } catch (Exception ignored) {
        }
    }

    private void downloadMediaWithCookies(
            String urlStr,
            String userAgent,
            String contentDisposition,
            String mimetype) {
        Toast.makeText(this, "开始下载...", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                if (conn instanceof HttpsURLConnection) {
                    applyPinnedTrustIfSaved((HttpsURLConnection) conn, url, getServerUrl());
                }
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                String cookie = CookieManager.getInstance().getCookie(urlStr);
                if (cookie != null && !cookie.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookie);
                }
                if (userAgent != null && !userAgent.isEmpty()) {
                    conn.setRequestProperty("User-Agent", userAgent);
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("HTTP " + code);
                }
                String disp = conn.getHeaderField("Content-Disposition");
                if (disp == null || disp.isEmpty()) disp = contentDisposition;
                String ct = conn.getContentType();
                if (ct == null || ct.isEmpty()) ct = mimetype;

                String filename = extractFileName(urlStr, disp, ct);
                byte[] buf = new byte[16384];
                try (InputStream in = new BufferedInputStream(conn.getInputStream());
                     OutputStream out = openDownloadOutputStream(filename, ct)) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                    out.flush();
                }
                mainHandler.post(() -> Toast.makeText(
                        MainActivity.this,
                        "已保存到下载目录: " + filename,
                        Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                mainHandler.post(() -> Toast.makeText(
                        MainActivity.this,
                        "下载失败: " + e.getMessage(),
                        Toast.LENGTH_LONG).show());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void applyPinnedTrustIfSaved(HttpsURLConnection conn, URL url, String configuredBase) {
        try {
            String host = url.getHost();
            int port = url.getPort() > 0 ? url.getPort() : 443;
            Uri cfg = Uri.parse(configuredBase);
            if (host == null || cfg.getHost() == null || !host.equalsIgnoreCase(cfg.getHost())) {
                return;
            }
            String savedPin = prefs.getString(
                    KEY_CERT_PIN_PREFIX + host.toLowerCase(Locale.US) + ":" + port, "");
            if (savedPin.isEmpty()) return;

            TrustManagerFactory tmf = TrustManagerFactory.getInstance(
                    TrustManagerFactory.getDefaultAlgorithm());
            tmf.init((KeyStore) null);
            X509TrustManager defaultTm = (X509TrustManager) tmf.getTrustManagers()[0];

            X509TrustManager pinnedTm = new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType)
                        throws CertificateException {
                    defaultTm.checkClientTrusted(chain, authType);
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType)
                        throws CertificateException {
                    try {
                        defaultTm.checkServerTrusted(chain, authType);
                    } catch (CertificateException primaryEx) {
                        if (chain != null && chain.length > 0) {
                            try {
                                String fp = sha256HexColon(chain[0].getEncoded());
                                if (savedPin.equalsIgnoreCase(fp)) {
                                    return;
                                }
                            } catch (Exception ignored) {
                            }
                        }
                        throw primaryEx;
                    }
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return defaultTm.getAcceptedIssuers();
                }
            };

            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, new TrustManager[]{pinnedTm}, null);
            conn.setSSLSocketFactory(sc.getSocketFactory());
            conn.setHostnameVerifier((hostname, session) -> hostname.equalsIgnoreCase(host));
        } catch (Exception ignored) {
        }
    }

    private OutputStream openDownloadOutputStream(String filename, String mime) throws Exception {
        String safeMime = (mime != null && mime.contains("/"))
                ? mime.split(";")[0].trim()
                : "application/octet-stream";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            cv.put(MediaStore.Downloads.MIME_TYPE, safeMime);
            cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AgyPocket");
            ContentResolver cr = getContentResolver();
            Uri itemUri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (itemUri == null) throw new IllegalStateException("无法创建下载文件");
            OutputStream os = cr.openOutputStream(itemUri);
            if (os == null) throw new IllegalStateException("无法写入下载文件");
            return os;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || (!dir.exists() && !dir.mkdirs()) || !dir.canWrite()) {
            dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        }
        if (dir == null) throw new IllegalStateException("存储不可用");
        if (!dir.exists()) dir.mkdirs();
        return new FileOutputStream(new File(dir, filename));
    }

    private static String extractFileName(String url, String disp, String mime) {
        if (disp != null) {
            Matcher mUtf = Pattern.compile("filename\\*=UTF-8''([^;\\s]+)", Pattern.CASE_INSENSITIVE)
                    .matcher(disp);
            if (mUtf.find()) {
                try {
                    return URLDecoder.decode(mUtf.group(1), "UTF-8");
                } catch (Exception ignored) {
                }
            }
            Matcher mPlain = Pattern.compile("filename=\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE)
                    .matcher(disp);
            if (mPlain.find()) {
                return mPlain.group(1).trim();
            }
        }
        try {
            Uri u = Uri.parse(url);
            String p = u.getQueryParameter("path");
            if (p != null && !p.isEmpty()) {
                String norm = p.replace('\\', '/');
                int idx = norm.lastIndexOf('/');
                if (idx >= 0 && idx + 1 < norm.length()) {
                    return norm.substring(idx + 1);
                }
            }
        } catch (Exception ignored) {
        }
        return URLUtil.guessFileName(url, disp, mime);
    }

    private String getServerUrl() {
        String saved = prefs.getString(KEY_SERVER_URL, "");
        return saved != null ? saved.trim() : "";
    }

    private String getConnectionMode() {
        String m = prefs.getString(KEY_CONN_MODE, MODE_FIXED);
        return MODE_TEMP.equals(m) ? MODE_TEMP : MODE_FIXED;
    }

    private String getDeviceName() {
        String n = prefs.getString(KEY_DEVICE_NAME, "远程电脑");
        return (n == null || n.trim().isEmpty()) ? "远程电脑" : n.trim();
    }

    private void saveActiveDevice(String url, String mode, String name) {
        String cleanUrl = url.trim().replaceAll("/+$", "");
        String cleanMode = MODE_TEMP.equals(mode) ? MODE_TEMP : MODE_FIXED;
        String cleanName = (name == null || name.trim().isEmpty()) ? "远程电脑" : name.trim();

        JSONArray existing = loadSavedDevicesArray();
        JSONArray next = new JSONArray();
        try {
            JSONObject cur = new JSONObject();
            cur.put("url", cleanUrl);
            cur.put("mode", cleanMode);
            cur.put("name", cleanName);
            cur.put("lastUsedAt", System.currentTimeMillis());
            next.put(cur);

            for (int i = 0; i < existing.length() && next.length() < 10; i++) {
                JSONObject item = existing.optJSONObject(i);
                if (item == null) continue;
                String itemUrl = item.optString("url", "").trim().replaceAll("/+$", "");
                if (!itemUrl.isEmpty() && !itemUrl.equalsIgnoreCase(cleanUrl)) {
                    next.put(item);
                }
            }
        } catch (Exception ignored) {
        }

        prefs.edit()
                .putString(KEY_SERVER_URL, cleanUrl)
                .putString(KEY_CONN_MODE, cleanMode)
                .putString(KEY_DEVICE_NAME, cleanName)
                .putString(KEY_DEVICES_JSON, next.toString())
                .apply();
    }

    private JSONArray loadSavedDevicesArray() {
        String raw = prefs.getString(KEY_DEVICES_JSON, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void showConnectingPage(String url, String devName, String mode) {
        String html = "<!doctype html><html lang='zh-CN'><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;min-height:100vh;background:#090b10;color:#eef2ff;"
                + "font-family:sans-serif;display:flex;align-items:center;justify-content:center;padding:20px'>"
                + "<div style='max-width:340px;width:100%;background:rgba(28,34,48,0.85);"
                + "border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:24px;text-align:center'>"
                + "<div style='font-size:17px;font-weight:700;margin-bottom:6px'>正在连接 " + escapeHtml(devName) + "</div>"
                + "<div style='font-size:11px;color:#38bdf8;margin-bottom:10px'>模式: "
                + (MODE_TEMP.equals(mode) ? "临时地址 (Temp)" : "固定地址 (Fixed)") + "</div>"
                + "<div style='font-size:12px;color:#94a3b8;word-break:break-all;margin-bottom:16px'>"
                + escapeHtml(url) + "</div>"
                + "<button onclick='window.AgyPocketNative.openQrScanner()' "
                + "style='width:100%;padding:11px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);"
                + "background:transparent;color:#e2e8f0;font-size:13px'>直接扫码连接</button>"
                + "</div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void showOfflineFallbackPage(String reason) {
        String currentUrl = getServerUrl();
        String urlDisplay = currentUrl.isEmpty() ? "未设置连接地址" : escapeHtml(currentUrl);
        String errText = escapeHtml(reason);
        String modeText = MODE_TEMP.equals(getConnectionMode()) ? "临时模式 (Temp)" : "固定模式 (Fixed)";
        String html = "<!doctype html><html lang='zh-CN'><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;min-height:100vh;background:#090b10;color:#eef2ff;"
                + "font-family:sans-serif;display:flex;align-items:center;justify-content:center;padding:20px'>"
                + "<div style='max-width:360px;width:100%;background:rgba(28,34,48,0.85);"
                + "border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:22px;text-align:center'>"
                + "<div style='font-size:18px;font-weight:700;margin-bottom:6px'>无法连接到远程电脑</div>"
                + "<div style='font-size:11px;color:#94a3b8;margin-bottom:4px'>"
                + escapeHtml(getDeviceName()) + " · " + modeText + "</div>"
                + "<div style='font-size:12px;color:#cbd5e1;word-break:break-all;margin-bottom:10px'>"
                + urlDisplay + "</div>"
                + "<div style='font-size:12px;color:#fca5a5;margin-bottom:16px'>" + errText + "</div>"
                + "<button onclick='window.AgyPocketNative.reloadHome()' "
                + "style='width:100%;padding:12px;border-radius:12px;border:0;background:#3b82f6;"
                + "color:#fff;font-weight:600;font-size:14px;margin-bottom:8px'>重试连接</button>"
                + "<button onclick='window.AgyPocketNative.openQrScanner()' "
                + "style='width:100%;padding:11px;border-radius:12px;border:1px solid rgba(56,189,248,0.45);"
                + "background:rgba(56,189,248,0.14);color:#bae6fd;font-weight:600;font-size:13px;margin-bottom:8px'>"
                + "扫码切换设备 / 更新地址</button>"
                + "<button onclick='window.AgyPocketNative.openServerConfig()' "
                + "style='width:100%;padding:11px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);"
                + "background:transparent;color:#e2e8f0;font-size:13px;margin-bottom:8px'>"
                + "手动修改地址（三指轻触屏幕也可打开）</button>"
                + "<button onclick='window.AgyPocketNative.openManual()' "
                + "style='width:100%;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);"
                + "background:rgba(255,255,255,0.05);color:#cbd5e1;font-size:12px'>"
                + "离线查看使用说明书</button>"
                + "</div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    private void showServerConfigDialog() {
        if (isFinishing() || isDestroyed()) return;

        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (18 * getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad / 2);
        scroll.addView(layout);

        TextView hint = new TextView(this);
        hint.setText("提示：任意界面三指轻触屏幕可呼出本面板。\n当前设备: " + getDeviceName()
                + "（" + (MODE_TEMP.equals(getConnectionMode()) ? "临时模式" : "固定模式") + "）");
        hint.setTextSize(12f);
        hint.setPadding(0, 0, 0, pad / 2);
        layout.addView(hint);

        Button qrBtn = new Button(this);
        qrBtn.setText("📷 扫码连接电脑");
        qrBtn.setOnClickListener(v -> openQrScannerInternal("扫描电脑端二合一二维码"));
        layout.addView(qrBtn);

        Button modeToggleBtn = new Button(this);
        modeToggleBtn.setText("切换连接模式（当前: "
                + (MODE_TEMP.equals(getConnectionMode()) ? "临时模式 Temp" : "固定模式 Fixed") + "）");
        modeToggleBtn.setOnClickListener(v -> {
            String nextMode = MODE_TEMP.equals(getConnectionMode()) ? MODE_FIXED : MODE_TEMP;
            prefs.edit().putString(KEY_CONN_MODE, nextMode).apply();
            modeToggleBtn.setText("切换连接模式（当前: "
                    + (MODE_TEMP.equals(nextMode) ? "临时模式 Temp" : "固定模式 Fixed") + "）");
            Toast.makeText(this, "已切换为 " + nextMode + " 模式", Toast.LENGTH_SHORT).show();
        });
        layout.addView(modeToggleBtn);

        Button manualBtn = new Button(this);
        manualBtn.setText("📖 使用说明书（离线可读）");
        manualBtn.setOnClickListener(v -> showUserManualDialog(this));
        layout.addView(manualBtn);

        JSONArray savedArr = loadSavedDevicesArray();
        if (savedArr.length() > 0) {
            TextView devTitle = new TextView(this);
            devTitle.setText("已保存电脑快速切换：");
            devTitle.setTextSize(12f);
            devTitle.setPadding(0, pad / 2, 0, 4);
            layout.addView(devTitle);

            for (int i = 0; i < Math.min(4, savedArr.length()); i++) {
                JSONObject item = savedArr.optJSONObject(i);
                if (item == null) continue;
                String dName = item.optString("name", "PC");
                String dUrl = item.optString("url", "");
                String dMode = item.optString("mode", MODE_FIXED);
                if (dUrl.isEmpty()) continue;

                Button switchBtn = new Button(this);
                switchBtn.setText("切换: " + dName + " [" + dMode + "]\n" + dUrl);
                switchBtn.setTextSize(11f);
                switchBtn.setOnClickListener(v -> {
                    saveActiveDevice(dUrl, dMode, dName);
                    probeAndLoadServer(dUrl, dMode);
                });
                layout.addView(switchBtn);
            }
        }

        EditText urlInput = new EditText(this);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setText(getServerUrl());
        urlInput.setHint("https://remote.example.com:8443 或 http://192.168.1.10:18765");
        layout.addView(urlInput);

        CheckBox immersiveBox = new CheckBox(this);
        immersiveBox.setText("聊天界面也隐藏顶部系统状态栏（极致全屏）");
        immersiveBox.setChecked(chatImmersive);
        layout.addView(immersiveBox);

        Button clearTrustBtn = new Button(this);
        clearTrustBtn.setText("清除已记忆的自签证书与缓存");
        clearTrustBtn.setOnClickListener(v -> {
            SharedPreferences.Editor ed = prefs.edit();
            for (String k : prefs.getAll().keySet()) {
                if (k.startsWith(KEY_CERT_PIN_PREFIX)) ed.remove(k);
            }
            ed.apply();
            webView.clearCache(true);
            Toast.makeText(this, "已清除缓存与信任证书记录", Toast.LENGTH_SHORT).show();
        });
        layout.addView(clearTrustBtn);

        new AlertDialog.Builder(this)
                .setTitle("AgyPocket 原生壳设置")
                .setView(scroll)
                .setPositiveButton("保存并重连", (d, w) -> {
                    String nextUrl = urlInput.getText().toString().trim().replaceAll("/+$", "");
                    if (!nextUrl.startsWith("http://") && !nextUrl.startsWith("https://")) {
                        Toast.makeText(this, "地址必须以 http:// 或 https:// 开头", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    chatImmersive = immersiveBox.isChecked();
                    prefs.edit().putBoolean(KEY_CHAT_IMMERSIVE, chatImmersive).apply();
                    saveActiveDevice(nextUrl, getConnectionMode(), getDeviceName());
                    applySystemBars();
                    probeAndLoadServer(nextUrl, getConnectionMode());
                })
                .setNeutralButton("刷新当前页", (d, w) -> {
                    chatImmersive = immersiveBox.isChecked();
                    prefs.edit().putBoolean(KEY_CHAT_IMMERSIVE, chatImmersive).apply();
                    applySystemBars();
                    webView.reload();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    public static void showUserManualDialog(Activity activity) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        int pad = (int) (18 * activity.getResources().getDisplayMetrics().density);
        ScrollView sv = new ScrollView(activity);
        TextView tv = new TextView(activity);
        tv.setPadding(pad, pad / 2, pad, pad);
        tv.setTextSize(13f);
        tv.setLineSpacing(6f, 1.15f);
        tv.setText(
                "1. 快速上手与配对\n"
                        + "• 在电脑端运行「启动反重力远程终端.bat」，首次按提示设置口令并选择接入方式（局域网 / Cloudflare 隧道 / SakuraFrp / Tailscale）。\n"
                        + "• 使用本 App 扫描电脑端生成的二合一二维码，可自动绑定设备名称、连接模式、HTTPS 自签证书指纹并免密直进。\n\n"
                        + "2. 固定模式（Fixed）vs 临时模式（Temp）\n"
                        + "• 固定模式：适合局域网固定 IP、SakuraFrp、Tailscale 或 Cloudflare Named Tunnel。断网重连失败时会停留在离线重试页。\n"
                        + "• 临时模式：适合 Cloudflare 免费临时隧道。每次启动 App 会先用 2.5 秒短超时探活，若旧临时地址已失效则自动弹出扫码页。\n\n"
                        + "3. 桌面遥控台手势\n"
                        + "• 自由留白拖动（默认）：1.0x 也可拖动画布，手指在周围点阵留白区滑动照样能把准星推到屏幕 0.0 / 1.0 边角。\n"
                        + "• 双指捏合可缩放 1.0x–3.5x 并跟随移动；点击倍率数字一键居中复位。\n"
                        + "• 支持左/右键按住、带虚线引导的按住拖动、短按/长按连点，以及右下/右上角红色 Esc 急停（自动防卡键）。\n\n"
                        + "4. 三指轻触快捷面板\n"
                        + "• 在任意界面三指同时轻触屏幕，即可呼出设置面板：随时扫码、切换固定/临时模式、在多台已保存电脑间切换、或开启极致沉浸全屏。"
        );
        sv.addView(tv);

        new AlertDialog.Builder(activity)
                .setTitle("AgyPocket 使用说明书（离线版）")
                .setView(sv)
                .setPositiveButton("我知道了", null)
                .show();
    }

    private void handleQrScanPayload(String rawText) {
        if (rawText == null || rawText.trim().isEmpty()) return;
        String raw = rawText.trim();

        String origin = "";
        String pairPath = "";
        String mode = MODE_FIXED;
        String devName = "远程电脑";

        try {
            if (raw.startsWith("{")) {
                JSONObject obj = new JSONObject(raw);
                String u = obj.optString("url", "").trim().replaceAll("/+$", "");
                String p = obj.optString("pair", "").trim();
                String m = obj.optString("mode", "").trim();
                String n = obj.optString("name", "").trim();
                if (!u.isEmpty()) origin = u;
                if (!p.isEmpty()) pairPath = p.startsWith("/") ? p : ("/" + p);
                if (MODE_TEMP.equalsIgnoreCase(m)) mode = MODE_TEMP;
                if (!n.isEmpty()) devName = n;
            } else if (raw.startsWith("http://") || raw.startsWith("https://")) {
                Uri uri = Uri.parse(raw);
                String scheme = uri.getScheme();
                String host = uri.getHost();
                if (scheme != null && host != null) {
                    int port = uri.getPort();
                    origin = scheme + "://" + host + (port > 0 ? (":" + port) : "");
                    String qMode = uri.getQueryParameter("mode");
                    String qName = uri.getQueryParameter("name");
                    if (MODE_TEMP.equalsIgnoreCase(qMode)) mode = MODE_TEMP;
                    if (qName != null && !qName.trim().isEmpty()) devName = qName.trim();

                    String path = uri.getEncodedPath();
                    String query = uri.getEncodedQuery();
                    if (path != null && path.startsWith("/pair")) {
                        pairPath = path + (query != null && !query.isEmpty() ? "?" + query : "");
                    }
                }
            }
        } catch (Exception e) {
            Toast.makeText(this, "二维码解析失败: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            return;
        }

        if (origin.isEmpty() || (!origin.startsWith("http://") && !origin.startsWith("https://"))) {
            Toast.makeText(this, "未识别到有效的 AgyPocket 服务地址", Toast.LENGTH_SHORT).show();
            return;
        }

        final String finalOrigin = origin;
        final String finalLoadUrl = !pairPath.isEmpty() ? (origin + pairPath) : origin;
        final String finalMode = mode;
        final String finalName = devName;

        showConnectingPage(finalOrigin, finalName, finalMode);
        new Thread(() -> {
            if (finalOrigin.startsWith("https://")) {
                fetchAndPinCertTofu(finalOrigin);
            }
            mainHandler.post(() -> {
                saveActiveDevice(finalOrigin, finalMode, finalName);
                Toast.makeText(MainActivity.this,
                        "已接入 " + finalName + " (" + finalMode + ")", Toast.LENGTH_SHORT).show();
                webView.loadUrl(finalLoadUrl);
            });
        }).start();
    }

    private class NativeBridge {
        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

        @JavascriptInterface
        public String getServerUrl() {
            return MainActivity.this.getServerUrl();
        }

        @JavascriptInterface
        public void setRemoteFullscreen(boolean enable) {
            mainHandler.post(() -> {
                remoteFullscreen = enable;
                setRequestedOrientation(enable
                        ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                applySystemBars();
            });
        }

        @JavascriptInterface
        public void openServerConfig() {
            mainHandler.post(MainActivity.this::showServerConfigDialog);
        }

        @JavascriptInterface
        public void openQrScanner() {
            mainHandler.post(() -> openQrScannerInternal("扫描电脑端 AgyPocket 二合一二维码"));
        }

        @JavascriptInterface
        public void openManual() {
            mainHandler.post(() -> showUserManualDialog(MainActivity.this));
        }

        @JavascriptInterface
        public String getAppInfo() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("versionName", "2.1.0");
                obj.put("deviceName", getDeviceName());
                obj.put("connectionMode", getConnectionMode());
                obj.put("serverUrl", getServerUrl());
            } catch (Exception ignored) {
            }
            return obj.toString();
        }

        @JavascriptInterface
        public void reloadHome() {
            mainHandler.post(() -> startSmartConnectFlow());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQ && filePathCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        if (requestCode == QR_SCAN_REQ) {
            if (resultCode == RESULT_OK && data != null) {
                String qrText = data.getStringExtra(QrScanActivity.EXTRA_QR_TEXT);
                handleQrScanPayload(qrText);
            } else if (data != null && QrScanActivity.ACTION_MANUAL.equals(data.getStringExtra(QrScanActivity.EXTRA_ACTION))) {
                showServerConfigDialog();
            }
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) {
            webView.getWebChromeClient().onHideCustomView();
            return;
        }
        if (remoteFullscreen) {
            remoteFullscreen = false;
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            applySystemBars();
            webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('agypocket-exit-fullscreen'));",
                    null);
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressAt < 2000L) {
            super.onBackPressed();
        } else {
            lastBackPressAt = now;
            Toast.makeText(this, "再按一次返回退出 AgyPocket", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        synchronized (pendingSslHandlers) {
            for (List<SslErrorHandler> handlers : pendingSslHandlers.values()) {
                for (SslErrorHandler h : handlers) h.cancel();
            }
            pendingSslHandlers.clear();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
