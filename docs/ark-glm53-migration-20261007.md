# GLM 与备用服务迁移至火山引擎

基线：`db5de5e58ecf0a2b4061f5b975cdbd3e98659951`。本记录补充同日的账号模型隔离修复，不改变其鉴权和请求选择隔离规则。

## 修改范围

- Auto 与前端 GLM 选项使用 `glm-5.3`，通过 OpenAI Chat 协议访问 `https://ark.cn-beijing.volces.com/api/coding/v3`。SDK 自动拼接 `/chat/completions`。不使用 Anthropic 地址，也不切到另外计费的 `/api/v3`。
- 按追加要求把豆包选项升级为 `Doubao-Seed-2.1-Pro`，实际发送官方模型 ID `doubao-seed-2.1-pro`；旧 2.0 请求与账号偏好兼容迁移，复用原火山 Key。
- 通用备用服务也使用这个火山地址和 `glm-5.3`，不把 Kimi、千问或官方 DeepSeek 的模型 ID/专属参数错误地带到火山备用请求。
- 图片对话和图片 OCR 的默认视觉模型迁为支持图片的火山 `glm-5.3-flash`；不把图片发给文本模型 `glm-5.3`。
- 旧前端请求、已保存的账号偏好与旧 `LLM_MODEL=glm-5.2` 均兼容映射为 `glm-5.3`。读取旧账号偏好不重写文件；旧视觉内部 ID 兼容映射到 `glm-5.3-flash`。
- 前端仅更新名称提示与静态缓存版本，不改变排版或业务流程。

## Key 规则

主火山 Key 的优先级：`ARK_API_KEY` → 原有 `DEEPSEEK_API_KEY` → 明确配置在火山 Coding Chat 地址上的旧 `LLM_API_KEY`。

备用火山 Key 的优先级：`ARK_API_KEY_BACKUP` → 明确配置在火山 Coding Chat 地址上的旧 `LLM_API_KEY_BACKUP` → 主火山 Key。

不修改服务器 `.env`，不提交任何密钥。旧智谱地址的 `LLM_API_KEY_BACKUP`、`GLM_API_KEY`、`VISION_API_KEY` 不会被发送给火山；原有专用火山 Key 可以继续复用。缺少主火山 Key 时明确报告缺配置，不继承不明来源的通用智谱 Key。仍需确保实际配置的是有效的火山 Coding Plan Key；更换 URL 不会让失效/其他厂商的 Key 生效。

备用 `(模型, Key, URL)` 与任一普通候选相同时不重复请求。同一次调用遇到认证失败后跳过相同 Key/URL 的后续候选，不使用跨账号或跨请求的失败标记。额度错误仍允许尝试其他模型、其他已配置厂商或不同备用 Key；超时/网络错误不触发路由层跨模型切换。已输出正文或工具调用的流不会再拼接其他模型的答案。正常成功仍只有一个模型请求，不新增预检、等待或磁盘读取。

复用主 Key 不等于获得独立备用额度；火山同一套餐额度耗尽时，切换同套餐模型或同账户 Key 不能保证恢复额度。原有已配置的千问/MiMo 独立候选保留。

## 明确保留

- Embedding 模型、Key、URL 和已有向量索引均不变，避免不兼容的向量空间混用。
- 官方 DeepSeek V4.1 的独立 Key/URL 与峰时调度不变；千问、MiMo、Moonshot 配置不变。
- 8D/FMEA 提示词、工具业务、用户角色、用户名、会话数据、依赖和启动方式不变。
- 不自动备份、不安装新包、不调用付费模型进行测试。

## 验证

49 项后端测试、12 项前端测试通过；前端脚本及 service worker 语法检查通过。后端使用生产函数、真实 FastAPI/ChatOpenAI SDK 与隔离的假 HTTP 传输，检查精确 URL、模型 ID、认证头、同步/异步/流式、工具参数、图片输入、主备去重、认证失败请求隔离、额度/超时边界、旧 GLM/豆包选择兼容及 Embedding 不变。

这些测试没有验证服务器真实 Key、上游实时可用性或完整数据库/RAG 端到端运行。同步生产文件后重启现有服务、刷新网页；无需安装依赖或重建知识库。

## 官方依据

- [火山 Coding Plan 的 OpenAI Chat 接入、模型名称与图片输入支持](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-opencode?lang=en)
- [Coding Plan 支持的模型与 GLM-5.3 默认思考模式](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)
- [旧模型下线说明](https://docs.volcengine.com/docs/ark/coding-plan-personal-model-deprecation?lang=zh)

GLM-5.3 默认思考且不支持关闭，不承诺比旧模型更快；此次没有加长超时或新增重试。
