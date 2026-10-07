"""Resolve the schedule at invocation time; retry only the failed model call."""
import logging

from app.config import settings, resolve_model_id, VISION_MODELS, get_model_connection, ARK_BACKUP_MODEL

logger = logging.getLogger(__name__)


def authentication_error(error):
    status = getattr(error, 'status_code', None) or getattr(getattr(error, 'response', None), 'status_code', None)
    return status == 401 or any(word in str(error).lower() for word in (
        'authenticationerror', 'invalid_api_key', 'invalid api key', 'api key format is incorrect',
        'authentication failed', 'incorrect api key'))


def capacity_error(error):
    status = getattr(error, 'status_code', None) or getattr(getattr(error, 'response', None), 'status_code', None)
    return authentication_error(error) or status in (402, 429) or any(word in str(error).lower() for word in (
        'insufficient_quota', 'quota', 'rate limit', 'ratelimit',
        'insufficient balance', '余额不足', '额度', 'resource exhausted'))


class RoutedLLM:
    def __init__(self, factory, selected, options, tools=None, tool_options=None):
        self.factory, self.selected, self.options = factory, selected, options
        self.tools, self.tool_options = tools, tool_options or {}

    def bind_tools(self, tools, **kwargs):
        return RoutedLLM(self.factory, self.selected, self.options, tools, kwargs)

    def candidates(self):
        primary = resolve_model_id(self.selected)
        # Vision inputs must not be sent to text-only fallback models.
        if primary in VISION_MODELS:
            return [primary]
        order = [primary, 'DeepSeek-V4-Flash', 'qwen3.7-plus',
                 'mimo-v2.5-pro', 'glm-5.3', 'doubao-seed-2.1-pro']
        keys = {
            'DeepSeek-V4.1-Flash': settings.DEEPSEEK_V41_API_KEY,
            'DeepSeek-V4-Flash': settings.DEEPSEEK_API_KEY,
            'glm-5.3': settings.DEEPSEEK_API_KEY,
            'doubao-seed-2.1-pro': settings.DEEPSEEK_API_KEY,
            'qwen3.7-plus': settings.QWEN_API_KEY,
            'mimo-v2.5-pro': settings.MIMO_API_KEY,
        }
        result = []
        for model in order:
            if model not in result and (model == primary or keys.get(model)):
                result.append(model)
        return result

    def targets(self):
        models = self.candidates()
        targets = [(model, False) for model in models]
        primary = models[0]
        # Ark backup must use an Ark-supported model, not the selected provider's ID.
        # Avoid retrying a model/Key/URL already included in normal candidates.
        if primary not in VISION_MODELS and settings.LLM_API_KEY_BACKUP and settings.LLM_BASE_URL_BACKUP:
            backup = (ARK_BACKUP_MODEL, *self.credentials(ARK_BACKUP_MODEL, True))
            normal = {(model, *self.credentials(model)) for model in models}
            if backup not in normal:
                targets.append((ARK_BACKUP_MODEL, True))
        return targets

    def credentials(self, model, backup=False):
        key, url = get_model_connection(model, backup=backup)
        return key, url.rstrip('/')

    def client(self, model, backup=False):
        options = {**self.options, **({'force_backup': True} if backup else {})}
        client = self.factory(model_override=model, **options)
        if self.tools is not None:
            client = client.bind_tools(self.tools, **self.tool_options)
        return client

    def invoke(self, messages, **kwargs):
        failed_auth = set()
        for model, backup in self.targets():
            credentials = self.credentials(model, backup)
            if credentials in failed_auth:
                continue
            try:
                return self.client(model, backup).invoke(messages, **kwargs)
            except Exception as error:
                if not capacity_error(error):
                    raise
                if authentication_error(error):
                    failed_auth.add(credentials)
                last_error = error
                logger.warning('Configured model authentication/capacity failed: model=%s backup=%s', model, backup)
        raise last_error

    async def ainvoke(self, messages, **kwargs):
        failed_auth = set()
        for model, backup in self.targets():
            credentials = self.credentials(model, backup)
            if credentials in failed_auth:
                continue
            try:
                return await self.client(model, backup).ainvoke(messages, **kwargs)
            except Exception as error:
                if not capacity_error(error):
                    raise
                if authentication_error(error):
                    failed_auth.add(credentials)
                last_error = error
                logger.warning('Configured model authentication/capacity failed: model=%s backup=%s', model, backup)
        raise last_error

    async def astream(self, messages, **kwargs):
        failed_auth = set()
        for model, backup in self.targets():
            credentials = self.credentials(model, backup)
            if credentials in failed_auth:
                continue
            emitted = False
            try:
                async for chunk in self.client(model, backup).astream(messages, **kwargs):
                    emitted = emitted or bool(getattr(chunk, 'content', None) or getattr(chunk, 'tool_call_chunks', None))
                    yield chunk
                return
            except Exception as error:
                # Never concatenate a new answer onto a partially delivered answer.
                if emitted or not capacity_error(error):
                    raise
                if authentication_error(error):
                    failed_auth.add(credentials)
                last_error = error
                logger.warning('Configured model authentication/capacity failed: model=%s backup=%s', model, backup)
        raise last_error
