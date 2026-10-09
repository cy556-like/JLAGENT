# JLAGENT 安卓内嵌 App（1.2.0）

安装 APK 后，点击图标在 App 的 WebView 内显示 `https://47.114.99.132:8003/`。
不启动浏览器或 Custom Tab；登录、聊天、智能体切换均留在软件界面。
附件上传使用系统文件选择器；下载使用系统保存界面选择位置。
下载桥仅绑定此站点的顶层 HTTPS origin，分块传输并逐块确认，单文件上限 50MB。
只有 Internet 权限，不申请存储、相机、通讯录等权限。
首次打开输入自己的账户密码；之后 App 在服务器认可登录令牌的有效期内自动恢复登录。
App 不保存明文密码。主动退出会清除登录令牌；服务器判定失效时需要重新登录。
短暂断网、超时或服务端 5xx 不会删掉已保存令牌，也不会在未验证时显示私密聊天。
普通浏览器仍保持原来的每次手动登录策略。
没有原生大模型请求、硬编码账户密码、通用 addJavascriptInterface 或 HTTPS 证书绕过。
证书错误会在软件内提示并停止加载，不自动跳转浏览器或降级 HTTP。
返回键优先关闭弹层/抽屉，再退出知识库；聊天首页返回关闭 App，不退出账户。
横竖屏切换不重新加载聊天。文件选择返回时再次校验账户、智能体和页面，防止串到另一账户。

## 编译

需要 Python 3.11+、JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。
不需要 Android Studio、Gradle、Node.js、第三方安卓运行时或新增后端 Python 包。

```cmd
python mobile/android/build.py --java-bin "JDK的bin目录" --build-tools "SDK的build-tools目录" --android-jar "SDK的android.jar路径" --keystore "项目目录外的签名文件.jks" --password-file "项目目录外的签名密码文件.password" --output "JLAGENT-Android-1.2.0.apk"
```

第一次构建会生成签名密钥；后续升级须保留并复用同一密钥和密码文件。
签名文件不得提交 GitHub，也不得包含 GitHub token 或网站账户密码。

## 服务器同步

1.2.0 需要同步 `app/static/index.html`、`app/static/sw.js`、`app/static/js/app.js`，
然后覆盖安装新 APK；只安装 APK 而不更新网页不能修复重复登录。
已同步过手机布局的服务器不需要重传 `mobile.css` 或 `mobile.js`。
桌面 CSS、后台 API、模型请求、`.env` 和 Python 依赖不改。
App 使用系统 Android WebView，请保持 Android System WebView 最新。

## 验证范围

构建后检查 APK 包信息和签名；下载脚本回归覆盖字节完整性、分块确认、
即时撤销 Blob 地址、账户切换取消、URL 白名单和大小限制；网页检查覆盖手机登录、侧边栏、
智能体欢迎页、个人微信、聊天长表格、输入框和知识库。
电脑端保持原样。没有实际安卓设备时，不能把编译和浏览器测试称为真机测试。
见 `docs/android-session-20261009.md` 的问题清单、验证及部署说明。

实现参考：[WebView](https://developer.android.com/reference/android/webkit/WebView)、
[WebMessagePort](https://developer.android.com/reference/android/webkit/WebMessagePort)、
[系统文件选择](https://developer.android.com/training/data-storage/shared/documents-files)。
