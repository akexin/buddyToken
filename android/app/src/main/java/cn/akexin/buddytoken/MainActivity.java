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

/**
 * buddyToken 看板的 Android 外壳。
 *
 * 看板本体是单文件 HTML，装在应用内资源里（file:///android_asset/index.html），
 * 这样打开即有页面；数据则由页面自己去连电脑上的 buddyToken 服务（局域网地址），
 * 拿到的数据会留一份在 WebView 的本地存储里，断网后仍能看上一次的结果。
 *
 * 与页面之间只有一座极小的桥：页面问「服务器地址填的多少」，这里答一个字符串。
 * 桥方法无任何副作用，页面上跑的远端脚本也拿它做不了别的事。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "buddyToken";
    private static final String KEY_SERVER = "serverBase";
    private static final String KEY_ASKED = "serverAsked";

    /** 首次运行填的默认值，只是省一次输入——用户随时可在菜单里改。 */
    private static final String DEFAULT_SERVER = "http://172.16.0.76:8099";

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

        // 首次启动先把服务器地址摆出来：没配对的话页面只能是空的
        if (!prefs.getBoolean(KEY_ASKED, false)) {
            prefs.edit().putBoolean(KEY_ASKED, true).apply();
            editServer();
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
        menu.add(0, MENU_SERVER, 0, R.string.menu_server);
        menu.add(0, MENU_RELOAD, 1, R.string.menu_reload);
        menu.add(0, MENU_CLEAR, 2, R.string.menu_clear);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == MENU_SERVER) { editServer(); return true; }
        if (id == MENU_RELOAD) { web.reload(); return true; }
        if (id == MENU_CLEAR) { confirmClear(); return true; }
        return super.onOptionsItemSelected(item);
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
