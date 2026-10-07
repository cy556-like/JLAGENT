"""
应用配置管理
支持动态切换 LLM 模型

优化:
- [#22] 配置中心：支持运行时热更新，无需重启
"""
import os
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

AUTO_MODEL_ID = "auto"
AUTO_MODEL_TARGET = "glm-5.3"
ARK_CHAT_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3"
ARK_BACKUP_MODEL = "glm-5.3"
MODEL_ID_ALIASES = {
    "glm-5.2": "glm-5.3",
    "glm-4v-plus": "glm-5.3-flash",
    "glm-4v": "glm-5.3-flash",
    "glm-4v-flash": "glm-5.3-flash",
    "Doubao-Seed-2.0-pro": "doubao-seed-2.1-pro",
    "doubao-seed-2.0-pro": "doubao-seed-2.1-pro",
    "Doubao-Seed-2.1-pro": "doubao-seed-2.1-pro",
}

# 显式指定 .env 路径（项目根目录），避免 uvicorn 启动目录不是项目根时找不到 .env
_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
if not load_dotenv(_env_path):
    load_dotenv()  # 回退：尝试从 cwd 加载


def _legacy_ark_key(key_name, url_name):
    """Reuse a generic legacy Key only when its URL explicitly identifies Ark Coding Chat."""
    try:
        url = urlsplit(os.getenv(url_name, '').strip())
    except ValueError:
        return ''
    if url.scheme == 'https' and url.hostname == 'ark.cn-beijing.volces.com' and url.path.rstrip('/') == '/api/coding/v3':
        return os.getenv(key_name, '').strip()
    return ''


_ark_key = (os.getenv('ARK_API_KEY', '').strip() or os.getenv('DEEPSEEK_API_KEY', '').strip() or
            _legacy_ark_key('LLM_API_KEY', 'LLM_BASE_URL'))
_ark_backup_key = (os.getenv('ARK_API_KEY_BACKUP', '').strip() or
                   _legacy_ark_key('LLM_API_KEY_BACKUP', 'LLM_BASE_URL_BACKUP') or _ark_key)

# 可用的 LLM 模型列表
AVAILABLE_MODELS = [
    # 自动模式（默认）：当前使用火山引擎 GLM-5.3。
    {"id": AUTO_MODEL_ID, "name": "Auto", "desc": "自动选择模型，当前默认使用 GLM-5.3（火山引擎）"},
    # DeepSeek 系列（火山引擎）
    {"id": "DeepSeek-V4.1-Flash", "name": "Deepseek-V4.1-Flash", "desc": "DeepSeek V4.1 Flash"},
    # GLM 系列（火山引擎Ark，与豆包/DeepSeek共用套餐）
    {"id": "glm-5.3", "name": "GLM-5.3", "desc": "GLM旗舰，火山引擎Ark"},
    # 豆包系列（火山引擎）
    {"id": "doubao-seed-2.1-pro", "name": "Doubao-Seed-2.1-Pro", "desc": "豆包旗舰，火山引擎"},
    # 千问系列（阿里云）
    {"id": "qwen3.7-plus", "name": "Qwen3.7-Plus", "desc": "千问旗舰，阿里云DashScope"},
    # MiMo系列（小米）
    {"id": "mimo-v2.5-pro", "name": "MiMo-V2.5-Pro", "desc": "小米旗舰，MiMo推理模型"},
    # Kimi 系列（Moonshot AI）
    {"id": "kimi-k3", "name": "Kimi K3", "desc": "Kimi旗舰推理模型，Moonshot API"},
]

# 支持图片分析的视觉模型列表
VISION_MODELS = {"glm-5.3-flash"}
# 默认视觉模型（当用户上传图片时自动切换）
DEFAULT_VISION_MODEL = "glm-5.3-flash"
# GLM-5.3 是文本模型；图片分析与图片 OCR 使用火山 GLM-5.3-Flash。
# 保留导出名称供 RAG 图片 OCR 使用，不再读取旧智谱视觉配置。
VISION_API_KEY: str = _ark_key
VISION_BASE_URL: str = ARK_CHAT_BASE_URL

# 快速模型列表（用于意图路由，加速简单问题的响应）
FAST_MODELS = {"DeepSeek-V4-Flash"}

# 火山引擎模型列表（走火山引擎Ark Coding API，包括豆包/DeepSeek/GLM）
VOLCENGINE_MODELS = {"DeepSeek-V4-Flash", "doubao-seed-2.1-pro", "glm-5.3", "glm-5.3-flash"}

# DeepSeek 模型列表（兼容旧代码引用，走火山引擎Coding API）
DEEPSEEK_MODELS = {"DeepSeek-V4-Flash"}

# 千问模型列表（走阿里云DashScope API）
QWEN_MODELS = {"qwen3.7-plus"}

# MiMo模型列表（走小米MiMo API）
MIMO_MODELS = {"mimo-v2.5-pro"}

# Kimi模型列表（走 Moonshot API）
KIMI_MODELS = {"kimi-k3"}

# GLM 已归入火山模型；保留旧版导出兼容。
GLM_MODELS = set()


class Settings:
    """应用配置（[#22] 支持运行时热更新）"""

    # LLM 默认配置（阿里云百炼平台，兼容模式代理多家模型）
    LLM_API_KEY: str = os.getenv("LLM_API_KEY", "")
    LLM_BASE_URL: str = os.getenv("LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    # 新默认值为 Auto。兼容旧部署：若 .env 仍保留旧默认 DeepSeek，则自动迁移到 Auto；
    # 用户仍可在前端显式选择 DeepSeek。
    _configured_model = os.getenv("LLM_MODEL", AUTO_MODEL_ID).strip()
    _configured_model = MODEL_ID_ALIASES.get(_configured_model, _configured_model)
    if _configured_model in ("", "DeepSeek-V4-Flash"):
        _configured_model = AUTO_MODEL_ID
    _valid_model_ids = {model["id"] for model in AVAILABLE_MODELS}
    LLM_MODEL: str = _configured_model if _configured_model in _valid_model_ids else AUTO_MODEL_ID

    # 备用服务统一使用火山 GLM-5.3；不把旧智谱 Key 发送给火山。
    # 可用 ARK_API_KEY_BACKUP 配置另一把有效火山 Key；没有则复用主火山 Key。
    LLM_API_KEY_BACKUP: str = _ark_backup_key
    LLM_BASE_URL_BACKUP: str = ARK_CHAT_BASE_URL

    # DeepSeek / 豆包 独立配置（火山引擎Ark）
    DEEPSEEK_API_KEY: str = _ark_key
    DEEPSEEK_BASE_URL: str = ARK_CHAT_BASE_URL
    DEEPSEEK_V41_API_KEY: str = os.getenv("DEEPSEEK_V41_API_KEY", "")
    DEEPSEEK_V41_BASE_URL: str = os.getenv("DEEPSEEK_V41_BASE_URL") or "https://api.deepseek.com"
    DEEPSEEK_V41_MODEL: str = os.getenv("DEEPSEEK_V41_MODEL") or "deepseek-flash"

    # 千问独立配置（阿里云DashScope）
    QWEN_API_KEY: str = os.getenv("QWEN_API_KEY", "")
    QWEN_BASE_URL: str = os.getenv("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")

    # MiMo独立配置（小米）
    MIMO_API_KEY: str = os.getenv("MIMO_API_KEY", "")
    MIMO_BASE_URL: str = os.getenv("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1")

    # Kimi独立配置（Moonshot AI）
    MOONSHOT_API_KEY: str = os.getenv("MOONSHOT_API_KEY", "")
    MOONSHOT_BASE_URL: str = os.getenv("MOONSHOT_BASE_URL", "https://api.moonshot.cn/v1")

    # 旧导出兼容；GLM 的 API 服务统一为火山，不读取旧智谱配置。
    GLM_API_KEY: str = _ark_key
    GLM_BASE_URL: str = ARK_CHAT_BASE_URL

    # Embedding 模型
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "embedding-3")
    # [#12] Embedding 独立 API Key（如未设置则复用 LLM_API_KEY）
    EMBEDDING_API_KEY: str = os.getenv("EMBEDDING_API_KEY", os.getenv("LLM_API_KEY", ""))
    # Embedding API Base URL（如未设置则复用 LLM_BASE_URL）
    EMBEDDING_BASE_URL: str = os.getenv("EMBEDDING_BASE_URL", os.getenv("LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"))

    # 应用配置
    APP_HOST: str = os.getenv("APP_HOST", "0.0.0.0")
    APP_PORT: int = int(os.getenv("APP_PORT", "8000"))

    # 数据目录
    DATA_DIR: str = os.getenv("DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
    DOCUMENTS_DIR: str = os.getenv("DOCUMENTS_DIR", os.path.join(DATA_DIR, "documents"))
    CHROMA_DIR: str = os.getenv("CHROMA_DIR", os.path.join(DATA_DIR, "chroma_db"))
    EMPLOYEES_FILE: str = os.getenv("EMPLOYEES_FILE", os.path.join(DATA_DIR, "employees.json"))

    # [#22] 配置变更回调列表
    _change_callbacks = []

    @classmethod
    def on_change(cls, callback):
        """注册配置变更回调"""
        cls._change_callbacks.append(callback)

    @classmethod
    def notify_change(cls, key: str, old_value, new_value):
        """通知配置变更"""
        for cb in cls._change_callbacks:
            try:
                cb(key, old_value, new_value)
            except Exception as e:
                logger.warning(f"配置变更回调异常: {e}")


settings = Settings()


def resolve_model_id(model_id: str, now: datetime | None = None) -> str:
    """将前端选择值解析为实际调用的模型ID。"""
    model_id = MODEL_ID_ALIASES.get(model_id, model_id)
    model_id = AUTO_MODEL_TARGET if model_id == AUTO_MODEL_ID else model_id
    if model_id == "DeepSeek-V4.1-Flash":
        china = timezone(timedelta(hours=8))
        current = now or datetime.now(china)
        current = current.replace(tzinfo=china) if current.tzinfo is None else current.astimezone(china)
        minute = current.hour * 60 + current.minute
        if 540 <= minute < 720 or 840 <= minute < 1080:
            return "DeepSeek-V4-Flash"
    return model_id


def get_effective_model() -> str:
    """获取当前实际调用的模型ID（Auto 当前解析为火山 GLM-5.3）。"""
    return resolve_model_id(settings.LLM_MODEL)


def get_model_connection(model: str, *, backup: bool = False) -> tuple[str, str]:
    """One source of truth for the model's credential and compatible endpoint."""
    if backup:
        if not settings.LLM_API_KEY_BACKUP or not settings.LLM_BASE_URL_BACKUP:
            raise ValueError('备用服务需要同时配置 API Key 和接口地址')
        return settings.LLM_API_KEY_BACKUP, settings.LLM_BASE_URL_BACKUP
    model = MODEL_ID_ALIASES.get(model, model)
    if model == 'DeepSeek-V4.1-Flash':
        return settings.DEEPSEEK_V41_API_KEY, settings.DEEPSEEK_V41_BASE_URL
    if model in VOLCENGINE_MODELS:
        return settings.DEEPSEEK_API_KEY, settings.DEEPSEEK_BASE_URL
    if model in QWEN_MODELS and settings.QWEN_API_KEY:
        return settings.QWEN_API_KEY, settings.QWEN_BASE_URL
    if model in MIMO_MODELS and settings.MIMO_API_KEY:
        return settings.MIMO_API_KEY, settings.MIMO_BASE_URL
    if model in KIMI_MODELS:
        if not settings.MOONSHOT_API_KEY:
            raise RuntimeError('Kimi K3 未配置 MOONSHOT_API_KEY，请在服务器 .env 中配置后重启服务')
        return settings.MOONSHOT_API_KEY, settings.MOONSHOT_BASE_URL
    if model in GLM_MODELS and settings.GLM_API_KEY:
        return settings.GLM_API_KEY, settings.GLM_BASE_URL
    if model in VISION_MODELS:
        return VISION_API_KEY, VISION_BASE_URL
    return settings.LLM_API_KEY, settings.LLM_BASE_URL


def set_current_model(model_id: str) -> bool:
    """动态切换当前使用的模型"""
    model_id = MODEL_ID_ALIASES.get(model_id, model_id)
    valid_ids = [m["id"] for m in AVAILABLE_MODELS]
    if model_id in valid_ids:
        old = settings.LLM_MODEL
        settings.LLM_MODEL = model_id
        # 重置 Agent 单例，让下次对话使用新模型
        from app.agent.core import reset_agent
        reset_agent()
        # [#22] 通知配置变更
        Settings.notify_change("LLM_MODEL", old, model_id)
        logger.info(f"模型切换: {old} → {model_id}")
        return True
    return False


def get_current_model() -> str:
    """获取当前使用的模型ID"""
    return settings.LLM_MODEL
