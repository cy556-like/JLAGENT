package com.cy556.jlagent;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A permission-free HTTPS launcher using the installed browser's Custom Tab. */
public final class MainActivity extends Activity {
    private static final String SITE = "https://47.114.99.132:8003/";
    private TextView hint;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);
        content.setPadding(24, 24, 24, 24);
        content.setBackgroundColor(Color.rgb(248, 250, 252));
        content.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                view.setPadding(24 + insets.getSystemWindowInsetLeft(),
                        24 + insets.getSystemWindowInsetTop(), 24 + insets.getSystemWindowInsetRight(),
                        24 + insets.getSystemWindowInsetBottom());
                return insets;
            }
        });
        TextView title = new TextView(this);
        title.setText("JLAGENT\n质量改进 / 精益智能体");
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setTextColor(Color.rgb(16, 81, 191));
        content.addView(title);
        hint = new TextView(this);
        hint.setText("使用 JLAGENT 账户密码登录。\nApp 不读取或保存您的密码。\n请保持网络连接。");
        hint.setGravity(Gravity.CENTER);
        hint.setTextSize(15);
        hint.setPadding(0, 32, 0, 24);
        content.addView(hint);
        Button open = new Button(this);
        open.setText("打开 JLAGENT");
        open.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { openSite(); }
        });
        content.addView(open);
        setContentView(content);
        if (state == null) openSite();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openSite();
    }

    private void openSite() {
        // Fixed address only. No login secrets, custom API proxy, or SSL bypass.
        Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(SITE));
        browser.addCategory(Intent.CATEGORY_BROWSABLE);
        Bundle extras = new Bundle();
        extras.putBinder("android.support.customtabs.extra.SESSION", null);
        browser.putExtras(extras);
        browser.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", Color.rgb(16, 81, 191));
        browser.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 1);
        try {
            startActivity(browser);
        } catch (ActivityNotFoundException error) {
            hint.setText("手机没有可用浏览器。\n请安装 Chrome、Edge 或其他支持 HTTPS 的浏览器，\n然后点击“打开 JLAGENT”。");
        }
    }
}
