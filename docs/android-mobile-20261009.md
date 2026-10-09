# JLAGENT 轻量安卓入口与手机适配

范围：一个打开既有 HTTPS 网站的安卓 APK，以及四个服务器静态文件。
APK 使用手机安装的浏览器内核；兼容浏览器优先显示 Custom Tab。
无可用浏览器时提供安装浏览器提示和重新打开按钮。
本版不是独立原生聊天客户端，不在 APK 内放任何模型 API 密钥、网站密码或 GitHub token。

## 网页改动

- 独立 `mobile.css` 仅在宽度不超过 768px 时调整登录、顶部工具栏、
  侧边抽屉、欢迎页滚动、输入框、知识库、长表格和个人微信页。
- 标题栏增加只在手机显示的智能体/会话入口，复用已有 `toggleSidebar()`。
- `mobile.js` 使用可视窗口高度应对键盘，合并多次 resize 为一帧；不请求后台。
- 允许页面缩放；补充安全区域和 Android 键盘 viewport 提示。
- `index.html`、Service Worker 资源版本一致更新。

原有 `app.js`、桌面 `style.css`、登录策略、账户隔离、模型选择、API 路由、
流式生成和数据库均未改。首次打开显示现有登录页；完整重新载入网站时，
继续沿用该项目每次手动登录的现有策略，不承诺自动记住账户。

## 验证

- HTTPS 正常校验证书的连接读取成功。
- 使用用户提供的账号在实际 HTTPS 服务登录；测试拦截所有聊天模型请求，
  以及除登录之外的写请求，避免改动生产会话和配置。
- 验证 320、360、390、412、768px 的手机工具栏/抽屉，键盘高度变化、
  个人微信图片、知识库和退出登录。电脑登录框添加/移除手机样式后位置一致。
- 重跑账号隔离、模型选择回归测试；补充移动高度、缩放、静态版本和 APK 安全测试。
- 官方工具编译 APK、检查清单并验证 v1/v2/v3 签名。

未连接安卓真机，因此尚不能宣称完成真机安装、OEM 浏览器、软键盘或
实际文件选择器的端到端测试。应在用户手机安装后再确认这些交互。

## 部署

服务器只同步以下文件，无须新增 pip 依赖或更新 `.env`：

1. `app/static/index.html`
2. `app/static/sw.js`
3. `app/static/css/mobile.css`
4. `app/static/js/mobile.js`

APK 签名密钥和密码只保存在本地构建目录之外，不提交源码或服务器。
后续 APK 升级须使用同一签名密钥。

实现参考：[Custom Tab 低层接口](https://developer.chrome.com/docs/android/custom-tabs/howto-custom-tab-low-level-api)、
[Android APK 签名工具](https://developer.android.com/tools/apksigner)。
