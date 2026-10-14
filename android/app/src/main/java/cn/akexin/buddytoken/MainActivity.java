package cn.akexin.buddytoken;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * buddyToken 看板的 Android 外壳。
 *
 * 看板本体是单文件 HTML，装在应用内资源里（file:///android_asset/index.html），
 * 这样打开即有页面；数据则由页面自己去连电脑上的 buddyToken 服务（局域网地址），
 * 拿到的数据会留一份在 WebView 的本地存储里，断网后仍能看上一次的结果。
 *
 * 与页面之间只有一座极小的桥：页面问「服务器地址填的多少」，这里答一个字符串。
 * 桥方法无任何副作用，页面上跑的远端脚本也拿它做不了别的事。
 *
 * 服务器地址默认不必手填：打开时向局域网广播一个探针，电脑上的服务（server.js
 * 的 UDP 发现）会回一句自己的地址，据此自动连上；找不到才退回手输框。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "buddyToken";
    private static final String KEY_SERVER = "serverBase";
    private static final String KEY_ASKED = "serverAsked";

    /** 兜底地址：自动发现失败、用户又不想手填时的最后选择。 */
    private static final String DEFAULT_SERVER = "http://172.16.0.76:8099";

    /** 与 server.js 的 DISCOVER_PORT / DISCOVER_MAGIC 必须一致。 */
    private static final int DISCOVER_PORT = 8098;
    private static final String DISCOVER_MAGIC = "BUDDYTOKEN/DISCOVER";
    private static final int DISCOVER_TIMEOUT_MS = 2500;

    private static final int MENU_DISCOVER = 0;
    private static final int MENU_SERVER = 1;
    private static final int MENU_RELOAD = 2;
    private static final int MENU_CLEAR  = 3;

    private WebView web;
    private SharedPreferences prefs;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        web.setBackgroundColor(Color.parseColor("#F5F7FB"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // IndexedDB / localStorage：看板的本地快照与离线数据缓存都靠它
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        // 页面在 file:// 下要访问 http://<局域网IP>:8099，属于混合内容
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        if (getActionBar() != null) {
            getActionBar().setTitle(R.string.app_name);
        }

        web.loadUrl("file:///android_asset/index.html");

        // 首次启动先自己找一遍服务器，找不到再弹手填框：没配对的话页面只能是空的
        if (!prefs.getBoolean(KEY_ASKED, false)) {
            prefs.edit().putBoolean(KEY_ASKED, true).apply();
            autoDiscover(true);
        }
    }

    /** 暴露给页面的最小桥：只读，无副作用。 */
    private class Bridge {
        @JavascriptInterface
        public String getServerBase() {
            return prefs.getString(KEY_SERVER, DEFAULT_SERVER);
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_DISCOVER, 0, R.string.menu_discover);
        menu.add(0, MENU_SERVER, 1, R.string.menu_server);
        menu.add(0, MENU_RELOAD, 2, R.string.menu_reload);
        menu.add(0, MENU_CLEAR, 3, R.string.menu_clear);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == MENU_DISCOVER) { autoDiscover(false); return true; }
        if (id == MENU_SERVER) { editServer(); return true; }
        if (id == MENU_RELOAD) { web.reload(); return true; }
        if (id == MENU_CLEAR) { confirmClear(); return true; }
        return super.onOptionsItemSelected(item);
    }

    /**
     * 在局域网里找 buddyToken 服务：广播一个探针，等服务回包。
     *
     * 找到就写入并重载；找不到时，首次启动会顺势弹出手填框，用户主动点击的
     * 情况（fallbackToManual=false）只提示失败——不硬塞一个输入框打断操作。
     */
    private void autoDiscover(boolean fallbackToManual) {
        Toast.makeText(this, R.string.discovering, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            final String base = probeServer(DISCOVER_TIMEOUT_MS);
            runOnUiThread(() -> {
                if (base != null) {
                    prefs.edit().putString(KEY_SERVER, base).apply();
                    Toast.makeText(this, getString(R.string.discovered, base), Toast.LENGTH_LONG).show();
                    web.reload();
                } else {
                    Toast.makeText(this, R.string.discover_failed, Toast.LENGTH_LONG).show();
                    if (fallbackToManual) editServer();
                }
            });
        }, "buddyToken-discover").start();
    }

    /** 广播探针并等待应答；拿到服务器地址返回它，超时或出错返回 null。 */
    private String probeServer(int timeoutMs) {
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(timeoutMs);

            byte[] probe = DISCOVER_MAGIC.getBytes(StandardCharsets.UTF_8);
            for (InetAddress target : broadcastTargets()) {
                try {
                    sock.send(new DatagramPacket(probe, probe.length, target, DISCOVER_PORT));
                } catch (IOException ignored) {
                    // 某个网卡发不出去（如未连上）不影响其它网卡
                }
            }

            long deadline = System.currentTimeMillis() + timeoutMs;
            byte[] buf = new byte[512];
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket resp = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(resp);
                } catch (SocketTimeoutException te) {
                    break;
                }
                String base = parseBase(new String(resp.getData(), 0, resp.getLength(), StandardCharsets.UTF_8));
                if (base != null) return base;
            }
        } catch (Exception e) {
            // 网络不可用等一律当作「没找到」，由上层决定是否回退手填
        } finally {
            if (sock != null) sock.close();
        }
        return null;
    }

    /**
     * 广播目标：全局广播地址 + 各网卡的子网广播地址。
     *
     * 部分设备会过滤 255.255.255.255，多带一份子网广播（如 192.168.1.255）
     * 能显著提高命中率。
     */
    private List<InetAddress> broadcastTargets() {
        List<InetAddress> list = new ArrayList<>();
        try {
            list.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress b = ia.getBroadcast();
                    if (b != null) list.add(b);
                }
            }
        } catch (Exception ignored) {
            // 取不到网卡信息就只用全局广播
        }
        return list;
    }

    /** 从应答 JSON 里取 base 字段；格式由 server.js 固定，不做完整 JSON 解析。 */
    private String parseBase(String json) {
        int key = json.indexOf("\"base\"");
        if (key < 0) return null;
        int colon = json.indexOf(':', key);
        if (colon < 0) return null;
        int q1 = json.indexOf('"', colon + 1);
        if (q1 < 0) return null;
        int q2 = json.indexOf('"', q1 + 1);
        if (q2 < 0) return null;
        String v = json.substring(q1 + 1, q2).trim();
        return v.isEmpty() ? null : v;
    }

    private void editServer() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(prefs.getString(KEY_SERVER, DEFAULT_SERVER));
        input.setSelection(input.getText().length());
        input.setHint(R.string.hint_server);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        input.setPadding(pad, pad / 2, pad, pad / 2);

        new AlertDialog.Builder(this)
                .setTitle(R.string.menu_server)
                .setMessage(R.string.msg_server)
                .setView(input)
                .setPositiveButton(R.string.save_reload, (d, w) -> {
                    String v = input.getText().toString().trim();
                    while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
                    prefs.edit().putString(KEY_SERVER, v).apply();
                    web.reload();
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void confirmClear() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.menu_clear)
                .setMessage(R.string.msg_clear)
                .setPositiveButton(R.string.do_clear, (d, w) -> {
                    web.clearCache(false);
                    web.clearHistory();
                    WebStorage.getInstance().deleteAllData();
                    Toast.makeText(this, R.string.cleared, Toast.LENGTH_SHORT).show();
                    web.reload();
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
