# JLAGENT 安卓轻量入口

安装 APK 后，点击图标自动打开 `https://47.114.99.132:8003/`。
使用手机已安装浏览器的 Custom Tab；不支持时由浏览器正常打开网址。
网页登录、聊天、附件上传和下载仍由现有 JLAGENT 网站处理。
首次打开需输入自己的账户密码；完整重载时仍遵循网站现有的手动登录策略。
没有原生大模型请求、密码存储、JavaScript 原生桥、额外权限或 HTTPS 证书绕过。

## 编译

需要 Python 3.11+、JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。
不需要 Android Studio、Gradle、Node.js、第三方安卓运行时或新增后端 Python 包。

```cmd
python mobile/android/build.py --java-bin "JDK的bin目录" --build-tools "SDK的build-tools目录" --android-jar "SDK的android.jar路径" --keystore "项目目录外的签名文件.jks" --password-file "项目目录外的签名密码文件.password" --output "JLAGENT-Android-1.0.0.apk"
```

第一次构建会生成签名密钥；后续升级须保留并复用同一密钥和密码文件。
签名文件不得提交 GitHub，也不得包含 GitHub token 或网站账户密码。

## 服务器同步

仅需同步 `app/static/index.html`、`app/static/sw.js`、
`app/static/css/mobile.css`、`app/static/js/mobile.js`。
原有 `app.js`、桌面 CSS、后台 API、模型和账户隔离代码不修改。

## 验证范围

构建后检查 APK 包信息和签名；网页检查覆盖手机登录、侧边栏、
智能体欢迎页、个人微信、聊天长表格、输入框和知识库。
电脑端保持原样。没有实际安卓设备时，不能把编译和浏览器测试称为真机测试。
