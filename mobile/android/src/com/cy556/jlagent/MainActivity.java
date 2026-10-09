package com.cy556.jlagent;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** A real in-app WebView. No browser/Custom Tab and no embedded credentials. */
public final class MainActivity extends Activity {
    static final String ORIGIN = "https://47.114.99.132:8003";
    static final String SITE = ORIGIN + "/";
    private static final int PICK_FILE = 10, SAVE_FILE = 11;
    private FrameLayout root;
    private WebView web;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private TextView errorText;
    private ValueCallback<Uri[]> upload;
    private String uploadAccount;
    private int uploadNavigation;
    private EmbeddedDownloads downloads;
    private File pendingSave;
    private final ExecutorService fileIO = Executors.newSingleThreadExecutor();
    private String downloadScript;
    private int navigation;
    private boolean scriptInstalled;
    private boolean backPending;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= 30) {
                    int types = WindowInsets.Type.systemBars();
                    if (Build.VERSION.SDK_INT >= 35) types |= WindowInsets.Type.ime();
                    Insets padding = insets.getInsets(types);
                    view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                } else {
                    view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                            insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                }
                return insets;
            }
        });
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams bar = new FrameLayout.LayoutParams(-1, (int) (3 * getResources().getDisplayMetrics().density));
        bar.gravity = Gravity.TOP;
        root.addView(progress, bar);
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(32, 32, 32, 32);
        errorPanel.setBackgroundColor(Color.WHITE);
        errorText = new TextView(this);
        errorText.setTextSize(16);
        errorText.setGravity(Gravity.CENTER);
        errorPanel.addView(errorText);
        Button retry = new Button(this);
        retry.setText("重新连接");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                if (downloadScript == null) { toast("请重新安装 JLAGENT"); return; }
                if (web == null) createWebView();
                errorPanel.setVisibility(View.GONE);
                web.loadUrl(SITE);
            }
        });
        errorPanel.addView(retry);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        errorPanel.setVisibility(View.GONE);
        setContentView(root);
        try {
            InputStream input = getAssets().open("downloads.js");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            input.close();
            downloadScript = bytes.toString("UTF-8");
        } catch (Exception error) {
            showError("应用资源不完整，请重新安装 JLAGENT。");
            return;
        }
        downloads = new EmbeddedDownloads(this);
        createWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    new OnBackInvokedCallback() { @Override public void onBackInvoked() { goBack(); } });
        }
        web.loadUrl(SITE);
    }

    boolean currentSite() {
        return web != null && isSite(web.getUrl());
    }

    private static boolean isSite(String value) {
        if (value == null) return false;
        Uri uri = Uri.parse(value);
        return "https".equals(uri.getScheme()) && "47.114.99.132".equals(uri.getHost()) && uri.getPort() == 8003;
    }

    private void createWebView() {
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " JLAGENTAndroid/1.2.0");
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                navigation++;
                backPending = false;
                cancelUpload();
                scriptInstalled = false;
                downloads.resetChannel();
                errorPanel.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
            }
            @Override public void onPageCommitVisible(WebView view, String url) { installDownloads(view); }
            @Override public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                installDownloads(view);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // Never bypass certificate validation, including subresources.
                if (isSite(error.getUrl())) showError("HTTPS 证书校验失败，请联系管理员检查服务器证书。");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("暂时无法连接 JLAGENT，请检查网络后重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showError("服务器暂时不可用（" + response.getStatusCode() + "），请稍后重试。");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                downloads.resetChannel();
                cancelUpload();
                root.removeView(view);
                view.destroy();
                web = null;
                showError("页面进程已停止，请重新连接。");
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); }
            @Override public boolean onShowFileChooser(final WebView view, final ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!currentSite()) return false;
                if (upload != null) { callback.onReceiveValue(null); return true; }
                upload = callback;
                uploadNavigation = navigation;
                final Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                ArrayList<String> types = new ArrayList<String>();
                String[] accepts = params.getAcceptTypes();
                if (accepts != null) for (String value : accepts) if (value != null && value.contains("/")) types.add(value);
                if (!types.isEmpty()) picker.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[types.size()]));
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                view.evaluateJavascript(accountStampScript(), new ValueCallback<String>() {
                    @Override public void onReceiveValue(String stamp) {
                        if (upload != callback) return;
                        if (view != web || uploadNavigation != navigation || !currentSite() || stamp == null || "null".equals(stamp)) {
                            cancelUpload(); return;
                        }
                        uploadAccount = stamp;
                        try { startActivityForResult(picker, PICK_FILE); }
                        catch (ActivityNotFoundException error) { cancelUpload(); toast("未找到系统文件选择器"); }
                    }
                });
                return true;
            }
        });
        web.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String agent, String disposition, String mime, long length) {
                if (!currentSite()) { toast("请返回 JLAGENT 页面后下载文件"); return; }
                web.evaluateJavascript("window.__jlNativeDownloads && window.__jlNativeDownloads.download(" +
                        JSONObject.quote(url) + ", '', " + JSONObject.quote(mime == null ? "" : mime) + ")", null);
            }
        });
    }

    private void installDownloads(final WebView view) {
        if (scriptInstalled || view != web || !currentSite() || errorPanel.getVisibility() == View.VISIBLE) return;
        scriptInstalled = true;
        final int document = navigation;
        final String nonce = UUID.randomUUID().toString();
        view.evaluateJavascript(downloadScript + ";window.__jlNativeDownloads.bindNonce(" + JSONObject.quote(nonce) + ");", new ValueCallback<String>() {
            @Override public void onReceiveValue(String value) {
                if (view == web && document == navigation && currentSite()) downloads.attach(view, nonce);
            }
        });
    }

    private boolean handleNavigation(Uri uri) {
        if ("https".equals(uri.getScheme())) return false; // Links stay inside this WebView.
        if ("about:blank".equals(uri.toString())) return false;
        if ("tel".equals(uri.getScheme())) {
            try { startActivity(new Intent(Intent.ACTION_DIAL, uri)); }
            catch (ActivityNotFoundException error) { toast("此设备无法拨号"); }
        } else toast("已阻止非 HTTPS 页面");
        return true;
    }

    private void showError(String message) {
        errorText.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
    }

    void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    void chooseSave(File file, String name, String mime) {
        if (isFinishing() || isDestroyed()) { file.delete(); downloads.saveFinished(); return; }
        pendingSave = file;
        Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType(mime);
        picker.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(picker, SAVE_FILE); }
        catch (ActivityNotFoundException error) {
            file.delete(); pendingSave = null; downloads.saveFinished(); toast("未找到系统文件保存界面");
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILE && upload != null) {
            final ArrayList<Uri> files = new ArrayList<Uri>();
            if (result == RESULT_OK && data != null && currentSite()) {
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) addUpload(files, data.getClipData().getItemAt(i).getUri());
                } else addUpload(files, data.getData());
            }
            if (files.isEmpty() || uploadNavigation != navigation || !currentSite()) { cancelUpload(); return; }
            final ValueCallback<Uri[]> callback = upload;
            final WebView page = web;
            page.evaluateJavascript(accountStampScript(), new ValueCallback<String>() {
                @Override public void onReceiveValue(String stamp) {
                    if (upload != callback) return;
                    if (page != web || uploadNavigation != navigation || !currentSite() || stamp == null || !stamp.equals(uploadAccount)) {
                        cancelUpload(); return;
                    }
                    upload = null;
                    uploadAccount = null;
                    callback.onReceiveValue(files.toArray(new Uri[files.size()]));
                }
            });
        } else if (request == SAVE_FILE && pendingSave != null) {
            final File file = pendingSave;
            pendingSave = null;
            final Uri destination = data == null ? null : data.getData();
            if (result != RESULT_OK || destination == null || !"content".equals(destination.getScheme())) {
                file.delete(); downloads.saveFinished(); return;
            }
            fileIO.execute(new Runnable() {
                @Override public void run() {
                    String notice = "文件已保存";
                    try (InputStream input = new FileInputStream(file);
                         OutputStream output = getContentResolver().openOutputStream(destination)) {
                        if (output == null) throw new java.io.IOException("No output stream");
                        byte[] buffer = new byte[32768];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    } catch (Exception error) { notice = "文件保存失败，请重新下载"; }
                    finally { file.delete(); downloads.saveFinished(); }
                    final String message = notice;
                    runOnUiThread(new Runnable() { @Override public void run() { if (!isDestroyed()) toast(message); } });
                }
            });
        }
    }

    private static void addUpload(ArrayList<Uri> files, Uri uri) {
        if (uri != null && "content".equals(uri.getScheme())) files.add(uri);
    }

    private static String accountStampScript() {
        return "(function(){if(typeof nativeAccountStamp==='function')return nativeAccountStamp();" +
                "if(typeof currentUser!=='undefined'&&currentUser&&typeof authToken!=='undefined'&&authToken)" +
                "return JSON.stringify([typeof accountSessionVersion!=='undefined'?accountSessionVersion:null,currentUser," +
                "typeof currentAgentId!=='undefined'?currentAgentId:null]);return null;})()";
    }

    private void cancelUpload() {
        ValueCallback<Uri[]> previous = upload;
        upload = null;
        uploadAccount = null;
        if (previous != null) previous.onReceiveValue(null);
    }

    private void goBack() {
        if (web == null) { finish(); return; }
        if (backPending) return;
        backPending = true;
        final WebView page = web;
        final int document = navigation;
        page.evaluateJavascript("(function(){if(typeof handleAndroidBack==='function')return handleAndroidBack();" +
                "var s=document.getElementById('sidebar');if(s&&s.classList.contains('mobile-open')&&typeof closeSidebarMobile==='function')" +
                "{closeSidebarMobile();return 'handled';}return 'history';})()",
                new ValueCallback<String>() {
                    @Override public void onReceiveValue(String closed) {
                        backPending = false;
                        if (page != web || document != navigation || isDestroyed()) return;
                        if ("\"handled\"".equals(closed)) return;
                        if ("\"home\"".equals(closed)) { finish(); return; }
                        if (web != null && web.canGoBack()) web.goBack(); else finish();
                    }
                });
    }
    @Override public void onBackPressed() { goBack(); }
    @Override protected void onPause() {
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        cancelUpload();
        if (pendingSave != null) { pendingSave.delete(); pendingSave = null; }
        if (downloads != null) downloads.close();
        fileIO.shutdown();
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
}
