"""Resolve the schedule at invocation time; retry only the failed model call."""
import logging

from app.config import settings, resolve_model_id, VISION_MODELS

logger = logging.getLogger(__name__)


def capacity_error(error):
    status = getattr(error, 'status_code', None)
    return status in (402, 429) or any(word in str(error).lower() for word in (
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
                 'mimo-v2.5-pro', 'glm-5.2', 'Doubao-Seed-2.0-pro']
        keys = {
            'DeepSeek-V4.1-Flash': settings.DEEPSEEK_V41_API_KEY,
            'DeepSeek-V4-Flash': settings.DEEPSEEK_API_KEY,
            'glm-5.2': settings.DEEPSEEK_API_KEY,
            'Doubao-Seed-2.0-pro': settings.DEEPSEEK_API_KEY,
            'qwen3.7-plus': settings.QWEN_API_KEY,
            'mimo-v2.5-pro': settings.MIMO_API_KEY,
        }
        result = []
        for model in order:
            if model not in result and (keys.get(model) or model == primary):
                result.append(model)
        return result

    def client(self, model):
        client = self.factory(model_override=model, **self.options)
        if self.tools is not None:
            client = client.bind_tools(self.tools, **self.tool_options)
        return client

    def invoke(self, messages, **kwargs):
        for model in self.candidates():
            try:
                return self.client(model).invoke(messages, **kwargs)
            except Exception as error:
                if not capacity_error(error):
                    raise
                last_error = error
                logger.warning('Model capacity exhausted: %s; trying next configured model', model)
        raise last_error

    async def ainvoke(self, messages, **kwargs):
        for model in self.candidates():
            try:
                return await self.client(model).ainvoke(messages, **kwargs)
            except Exception as error:
                if not capacity_error(error):
                    raise
                last_error = error
                logger.warning('Model capacity exhausted: %s; trying next configured model', model)
        raise last_error

    async def astream(self, messages, **kwargs):
        for model in self.candidates():
            emitted = False
            try:
                async for chunk in self.client(model).astream(messages, **kwargs):
                    emitted = emitted or bool(getattr(chunk, 'content', None) or getattr(chunk, 'tool_call_chunks', None))
                    yield chunk
                return
            except Exception as error:
                # Never concatenate a new answer onto a partially delivered answer.
                if emitted or not capacity_error(error):
                    raise
                last_error = error
                logger.warning('Model capacity exhausted: %s; trying next configured model', model)
        raise last_error
