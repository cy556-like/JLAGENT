package com.cy556.jlagent;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Origin-bound, bounded binary download channel. No general JavaScript interface. */
final class EmbeddedDownloads {
    private static final long MAX_SIZE = 50L * 1024 * 1024;
    private final MainActivity activity;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile WebMessagePort port;
    private String id;
    private File file;
    private FileOutputStream output;
    private long expected, written;
    private String name, mime;
    private boolean saving;

    EmbeddedDownloads(MainActivity activity) { this.activity = activity; }

    void attach(WebView web, String nonce) {
        resetChannel();
        if (!activity.currentSite()) return;
        WebMessagePort[] channel = web.createWebMessageChannel();
        final WebMessagePort reader = channel[0];
        port = reader;
        reader.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(final WebMessagePort sender, WebMessage message) {
                if (sender != port || !activity.currentSite()) return;
                final String data = message.getData();
                if (data == null || data.length() > 100000) return;
                execute(new Runnable() { @Override public void run() { receive(sender, data); } });
            }
        });
        // Transfer only to our top-frame origin; never use a wildcard or Uri.EMPTY.
        web.postWebMessage(new WebMessage("JLAGENT_NATIVE_DOWNLOADS:" + nonce, new WebMessagePort[]{channel[1]}),
                Uri.parse(MainActivity.ORIGIN));
    }

    private void execute(Runnable action) { if (!io.isShutdown()) io.execute(action); }

    private void receive(final WebMessagePort sender, String data) {
        if (sender != port) return;
        String requestId = "";
        try {
            JSONObject request = new JSONObject(data);
            requestId = request.getString("id");
            if (!requestId.matches("[a-zA-Z0-9_-]{1,80}")) throw new Exception("Invalid transfer");
            String action = request.getString("action");
            if ("begin".equals(action)) {
                if (saving || output != null) throw new Exception("请先完成当前文件的保存");
                long size = request.getLong("size");
                if (size < 0 || size > MAX_SIZE) throw new Exception("文件超过 50MB 限制");
                name = request.optString("name", "JLAGENT-文件").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                if (name.isEmpty()) name = "JLAGENT-文件";
                if (name.length() > 180) name = name.substring(0, 180);
                mime = request.optString("mime", "application/octet-stream");
                if (!mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) mime = "application/octet-stream";
                id = requestId;
                file = File.createTempFile("jl-export-", ".tmp", activity.getCacheDir());
                output = new FileOutputStream(file);
                expected = size;
                written = 0;
            } else {
                if (!requestId.equals(id) || output == null) throw new Exception("下载已取消，请重试");
                if ("chunk".equals(action)) {
                    byte[] bytes = Base64.decode(request.getString("data"), Base64.NO_WRAP);
                    if (bytes.length > 49152 || written + bytes.length > expected) throw new Exception("下载数据长度异常");
                    output.write(bytes);
                    written += bytes.length;
                } else if ("end".equals(action)) {
                    if (written != expected) throw new Exception("下载不完整，请重试");
                    output.close();
                    output = null;
                    final File completed = file;
                    final String filename = name, contentType = mime;
                    file = null;
                    id = null;
                    saving = true;
                    // ACK before showing the system picker: choosing a folder must not time out JS.
                    reply(sender, requestId, null);
                    new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                        @Override public void run() { activity.chooseSave(completed, filename, contentType); }
                    }, 200);
                    return;
                } else if ("cancel".equals(action)) discard();
                else throw new Exception("未知下载操作");
            }
            reply(sender, requestId, null);
        } catch (Exception error) {
            if (requestId.equals(id)) discard();
            reply(sender, requestId, "下载失败，请重试或先完成当前保存");
        }
    }

    private void reply(final WebMessagePort sender, String requestId, String error) {
        final JSONObject result = new JSONObject();
        try {
            result.put("id", requestId);
            result.put("ok", error == null);
            if (error != null) result.put("error", error);
        } catch (Exception ignored) { return; }
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (sender != port || !activity.currentSite()) return;
                try { sender.postMessage(new WebMessage(result.toString())); } catch (IllegalStateException ignored) { }
            }
        });
    }

    private void discard() {
        if (output != null) try { output.close(); } catch (Exception ignored) { }
        if (file != null) file.delete();
        output = null;
        file = null;
        id = null;
    }

    void saveFinished() { execute(new Runnable() { @Override public void run() { saving = false; } }); }

    void resetChannel() {
        WebMessagePort previous = port;
        port = null;
        if (previous != null) previous.close();
        execute(new Runnable() { @Override public void run() { discard(); } });
    }

    void close() { resetChannel(); io.shutdown(); }
}
