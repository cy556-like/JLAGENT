"""Offline regression suite. Real API handlers/SDK, fake auth and model transport.

Run: python -X utf8 -m unittest discover -s tests -p test_auto_account_routing.py -v
AST extraction loads the exact production function bodies without initializing
the application's Chroma database, user store, tools or paid model services.
"""
import ast
import asyncio
import base64
import concurrent.futures
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import ModuleType, SimpleNamespace
from typing import AsyncGenerator
import unittest
from unittest.mock import patch
from urllib.parse import unquote

from fastapi import APIRouter, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
import httpx
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
ARK_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
ARK_HOST = 'ark.cn-beijing.volces.com'


def definitions(path, names, scope):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8-sig'))
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name in names]
    assert {n.name for n in nodes} == set(names)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), path, 'exec'), scope)
    return scope


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class IsolatedSource(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        app, agent = ModuleType('app'), ModuleType('app.agent')
        app.__path__, agent.__path__ = [str(ROOT / 'app')], [str(ROOT / 'app/agent')]
        dotenv = ModuleType('dotenv')
        dotenv.load_dotenv = lambda *args, **kwargs: True
        modules = patch.dict(sys.modules, {'app': app, 'app.agent': agent, 'dotenv': dotenv})
        modules.start()
        self.addCleanup(modules.stop)
        env = {'DATA_DIR': self.temp.name, 'LLM_MODEL': 'auto', 'LLM_API_KEY': 'test-default',
               'LLM_BASE_URL': 'https://default.invalid/v1', 'DEEPSEEK_API_KEY': 'test-ark',
               'DEEPSEEK_BASE_URL': ARK_URL, 'ARK_API_KEY_BACKUP': 'test-backup',
               'LLM_API_KEY_BACKUP': 'old-zhipu-backup', 'LLM_BASE_URL_BACKUP': 'https://open.bigmodel.cn/api/anthropic'}
        with patch.dict(os.environ, env, clear=True):
            self.cfg = load_module('app.config', 'app/config.py')
        self.prefs = load_module('app.model_preferences', 'app/model_preferences.py')
        self.routing = load_module('app.agent.model_routing', 'app/agent/model_routing.py')
        self.core = dict(self.cfg.__dict__, time=time, logger=logging.getLogger('test'),
                         _primary_key_failed=True, _llm_cache={}, _LLM_CACHE_TTL=900,
                         ChatOpenAI=lambda **kw: SimpleNamespace(**kw))
        definitions('app/agent/core.py', ['_create_llm_client', 'create_llm', '_is_model_auth_error'], self.core)


class RoutingTests(IsolatedSource):
    def routed(self, selected='auto'):
        return self.core['create_llm'](model_override=selected)

    def test_auto_uses_ark_and_ignores_shared_failure_flag(self):
        client = self.core['_create_llm_client'](model_override='auto')
        self.assertEqual((client.model, client.api_key, client.base_url),
                         ('glm-5.3', 'test-ark', ARK_URL))

    def test_explicit_backup_changes_key_and_endpoint(self):
        primary = self.core['_create_llm_client'](model_override='glm-5.3')
        backup = self.core['_create_llm_client'](model_override='glm-5.3', force_backup=True)
        self.assertEqual((backup.api_key, backup.base_url), ('test-backup', ARK_URL))
        self.assertIsNot(primary, backup)
        self.assertIs(primary, self.core['_create_llm_client'](model_override='glm-5.3'))

    def test_primary_candidate_order_unchanged(self):
        self.assertEqual(self.routed().candidates(), ['glm-5.3', 'DeepSeek-V4-Flash', 'doubao-seed-2.1-pro'])
        self.cfg.settings.QWEN_API_KEY = 'test-qwen'
        self.cfg.settings.MIMO_API_KEY = 'test-mimo'
        self.assertEqual(self.routed().candidates(), ['glm-5.3', 'DeepSeek-V4-Flash', 'qwen3.7-plus',
                                                      'mimo-v2.5-pro', 'doubao-seed-2.1-pro'])

    def test_missing_backup_pair_does_not_make_attempt(self):
        for attr in ('LLM_API_KEY_BACKUP', 'LLM_BASE_URL_BACKUP'):
            with self.subTest(attr=attr), patch.object(self.cfg.settings, attr, ''):
                self.assertFalse(any(backup for _, backup in self.routed().targets()))
                with self.assertRaises(ValueError):
                    self.cfg.get_model_connection('glm-5.3', backup=True)

    def test_duplicate_backup_and_vision_not_retried(self):
        self.cfg.settings.LLM_API_KEY_BACKUP = 'test-ark'
        self.cfg.settings.LLM_BASE_URL_BACKUP = ARK_URL + '/'
        self.assertFalse(any(backup for _, backup in self.routed().targets()))
        self.assertEqual(self.routed('glm-4v-flash').targets(), [('glm-5.3-flash', False)])

    def test_backup_uses_ark_model_not_selected_other_provider_id(self):
        for model in ('kimi-k3', 'qwen3.7-plus', 'DeepSeek-V4.1-Flash'):
            with self.subTest(model=model):
                client = self.core['_create_llm_client'](model_override=model, force_backup=True, deep_think=True)
                self.assertEqual((client.model, client.api_key, client.base_url), ('glm-5.3', 'test-backup', ARK_URL))
                self.assertNotIn('reasoning_effort', vars(client))
                self.assertNotIn('extra_body', vars(client))
        client = self.core['_create_llm_client'](force_backup=True, fast_mode=True)
        self.assertEqual(client.model, 'glm-5.3')

    def test_backup_deduplicates_against_all_normal_candidates(self):
        self.cfg.settings.QWEN_API_KEY = 'test-qwen'
        self.cfg.settings.LLM_API_KEY_BACKUP = 'test-ark'
        self.assertIn(('glm-5.3', False), self.routed('qwen3.7-plus').targets())
        self.assertNotIn(('glm-5.3', True), self.routed('qwen3.7-plus').targets())
        self.cfg.settings.LLM_API_KEY_BACKUP = 'test-backup'
        self.assertEqual(self.routed('qwen3.7-plus').targets()[-1], ('glm-5.3', True))

    def test_legacy_glm_and_vision_factory_ids_migrate(self):
        for old, new in [('glm-5.2', 'glm-5.3'), ('glm-4v-flash', 'glm-5.3-flash')]:
            with self.subTest(old=old):
                client = self.core['_create_llm_client'](model_override=old)
                self.assertEqual((client.model, client.api_key, client.base_url), (new, 'test-ark', ARK_URL))

    def test_old_doubao_choices_route_to_seed21pro_on_ark(self):
        for selected in ('Doubao-Seed-2.0-pro', 'doubao-seed-2.0-pro', 'Doubao-Seed-2.1-pro', 'doubao-seed-2.1-pro'):
            with self.subTest(selected=selected):
                client = self.core['_create_llm_client'](model_override=selected)
                self.assertEqual((client.model, client.api_key, client.base_url), ('doubao-seed-2.1-pro', 'test-ark', ARK_URL))
                self.assertEqual(self.routed(selected).candidates()[0], 'doubao-seed-2.1-pro')
        self.assertNotIn('Doubao-Seed-2.0-pro', self.routed().candidates())

    def test_missing_ark_key_does_not_send_generic_zhipu_key(self):
        self.cfg.settings.DEEPSEEK_API_KEY = ''
        for model in ('auto', 'glm-5.3', 'glm-4v-flash'):
            with self.subTest(model=model), self.assertRaisesRegex(RuntimeError, 'ARK_API_KEY'):
                self.core['_create_llm_client'](model_override=model)

    def test_provider_mapping_preserved(self):
        self.cfg.settings.QWEN_API_KEY = 'test-qwen'
        self.cfg.settings.MIMO_API_KEY = 'test-mimo'
        self.cfg.settings.MOONSHOT_API_KEY = 'test-kimi'
        for model, key in [('qwen3.7-plus', 'test-qwen'), ('mimo-v2.5-pro', 'test-mimo'), ('kimi-k3', 'test-kimi')]:
            with self.subTest(model=model):
                self.assertEqual(self.cfg.get_model_connection(model)[0], key)
        self.cfg.settings.MOONSHOT_API_KEY = ''
        with self.assertRaisesRegex(RuntimeError, 'MOONSHOT_API_KEY'):
            self.cfg.get_model_connection('kimi-k3')

    def test_peak_schedule_and_official_endpoint_unchanged(self):
        from datetime import datetime
        for hour, expected in [(8, 'DeepSeek-V4.1-Flash'), (9, 'DeepSeek-V4-Flash'),
                               (12, 'DeepSeek-V4.1-Flash'), (14, 'DeepSeek-V4-Flash'), (18, 'DeepSeek-V4.1-Flash')]:
            with self.subTest(hour=hour):
                self.assertEqual(self.cfg.resolve_model_id('DeepSeek-V4.1-Flash', datetime(2026, 10, 7, hour)), expected)
        self.cfg.settings.DEEPSEEK_V41_API_KEY = 'test-official'
        with patch.dict(self.core, resolve_model_id=lambda value: value):
            client = self.core['_create_llm_client'](model_override='DeepSeek-V4.1-Flash')
            self.assertEqual(client.api_key, 'test-official')
            self.assertEqual(client.model, self.cfg.settings.DEEPSEEK_V41_MODEL)
            self.assertEqual(client.extra_body, {'thinking': {'type': 'disabled'}})

    def transport(self, status=401, primary_ok=False):
        self.requests = []

        def handle(request):
            data = json.loads(request.content)
            self.requests.append((request.url.host, request.headers['authorization'], data))
            self.assertEqual(str(request.url), ARK_URL + '/chat/completions')
            if request.headers['authorization'] != 'Bearer test-backup' and not primary_ok:
                return httpx.Response(status, json={'error': {'message': 'provider failure', 'type': 'error',
                                                             'code': 'invalid_api_key' if status == 401 else 'failure'}})
            if data.get('stream'):
                chunk = {'id': 'test', 'object': 'chat.completion.chunk', 'created': 1, 'model': data['model'],
                         'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'OK'}, 'finish_reason': None}]}
                return httpx.Response(200, headers={'Content-Type': 'text/event-stream'},
                                      content='data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n')
            return httpx.Response(200, json={'id': 'test', 'object': 'chat.completion', 'created': 1,
                'model': data['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'OK'}, 'finish_reason': 'stop'}]})

        sync = httpx.Client(transport=httpx.MockTransport(handle))
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        self.addCleanup(sync.close)
        self.addCleanup(lambda: asyncio.run(async_client.aclose()))
        self.core['ChatOpenAI'] = lambda **kw: ChatOpenAI(**kw, http_client=sync,
                                                         http_async_client=async_client, max_retries=0)

    def test_real_sdk_primary_success_is_one_request(self):
        self.transport(primary_ok=True)
        self.assertEqual(self.routed().invoke([HumanMessage(content='hi')]).content, 'OK')
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][:2], (ARK_HOST, 'Bearer test-ark'))
        self.assertEqual(self.requests[0][2]['model'], 'glm-5.3')

    def test_real_sdk_auth_fallback_same_request_sync(self):
        self.transport()
        self.assertEqual(self.routed().invoke([HumanMessage(content='hi')]).content, 'OK')
        self.assertEqual([item[0] for item in self.requests], [ARK_HOST] * 2)
        self.assertEqual(self.requests[-1][1], 'Bearer test-backup')
        self.assertEqual(self.requests[-1][2]['model'], 'glm-5.3')

    def test_auth_failure_skip_is_request_local_not_shared(self):
        self.transport()
        self.routed().invoke([HumanMessage(content='first')])
        self.routed().invoke([HumanMessage(content='second')])
        self.assertEqual([item[1] for item in self.requests],
                         ['Bearer test-ark', 'Bearer test-backup'] * 2)

    def test_quota_error_can_try_different_model_with_same_ark_key(self):
        self.transport(status=429)
        self.assertEqual(self.routed().invoke([HumanMessage(content='hi')]).content, 'OK')
        self.assertEqual([item[2]['model'] for item in self.requests],
                         ['glm-5.3', 'DeepSeek-V4-Flash', 'doubao-seed-2.1-pro', 'glm-5.3'])

    def test_real_sdk_vision_request_stays_on_ark_vision_model(self):
        self.transport(primary_ok=True)
        content = [{'type': 'text', 'text': 'describe'},
                   {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,dGVzdA=='}}]
        self.assertEqual(self.routed('glm-4v-flash').invoke([HumanMessage(content=content)]).content, 'OK')
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][2]['model'], 'glm-5.3-flash')
        self.assertEqual(self.requests[0][2]['messages'][0]['content'][1]['type'], 'image_url')

    def test_real_sdk_auth_fallback_async_and_stream_with_tools(self):
        for kind in ('ainvoke', 'astream'):
            with self.subTest(kind=kind):
                self.core['_llm_cache'].clear()
                self.transport()
                routed = self.routed().bind_tools([{'type': 'function', 'function': {'name': 'noop',
                                                        'description': 'test', 'parameters': {'type': 'object', 'properties': {}}}}])
                async def run():
                    if kind == 'ainvoke':
                        return (await routed.ainvoke([HumanMessage(content='hi')])).content
                    return ''.join([chunk.content async for chunk in routed.astream([HumanMessage(content='hi')])])
                self.assertEqual(asyncio.run(run()), 'OK')
                self.assertEqual(self.requests[-1][:2], (ARK_HOST, 'Bearer test-backup'))
                self.assertEqual(len(self.requests), 2)
                self.assertIn('tools', self.requests[-1][2])

    def test_bad_request_not_routed_to_backup(self):
        self.transport(status=400)
        with self.assertRaises(Exception) as raised:
            self.routed().invoke([HumanMessage(content='hi')])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(len(self.requests), 1)

    def test_timeout_not_routed_to_backup(self):
        attempts = []
        def factory(**kw):
            attempts.append(kw)
            return SimpleNamespace(invoke=lambda *a, **k: (_ for _ in ()).throw(TimeoutError('timeout')))
        with self.assertRaises(TimeoutError):
            self.routing.RoutedLLM(factory, 'auto', {}).invoke([])
        self.assertEqual(len(attempts), 1)

    def test_quota_can_route_but_generic_token_wording_is_not_auth(self):
        self.assertTrue(self.routing.capacity_error(SimpleNamespace(status_code=429)))
        self.assertTrue(self.routing.capacity_error(RuntimeError('insufficient_quota')))
        self.assertFalse(self.routing.authentication_error(RuntimeError('令牌数量超过上下文，编号4012')))
        self.assertFalse(self.routing.capacity_error(RuntimeError('令牌数量超过上下文')))

    def test_no_model_switch_after_partial_content_or_tool_call(self):
        for chunk in (SimpleNamespace(content='partial', tool_call_chunks=[]),
                      SimpleNamespace(content='', tool_call_chunks=[{'name': 'noop'}])):
            with self.subTest(chunk=chunk):
                attempts = []
                async def stream(*args, **kwargs):
                    yield chunk
                    error = RuntimeError('invalid_api_key')
                    raise error
                def factory(**kw):
                    attempts.append(kw)
                    return SimpleNamespace(astream=stream)
                async def run():
                    async for _ in self.routing.RoutedLLM(factory, 'auto', {}).astream([]):
                        pass
                with self.assertRaisesRegex(RuntimeError, 'invalid_api_key'):
                    asyncio.run(run())
                self.assertEqual(len(attempts), 1)


class ArkConfigurationTests(IsolatedSource):
    def config(self, env):
        with patch.dict(os.environ, env, clear=True):
            return load_module('migration_test_config', 'app/config.py')

    def test_old_zhipu_urls_and_keys_are_not_reused_for_chat_or_vision(self):
        cfg = self.config({'DEEPSEEK_API_KEY': 'existing-ark', 'DEEPSEEK_BASE_URL': 'https://wrong.invalid/v1',
                           'LLM_API_KEY': 'old-zhipu', 'LLM_BASE_URL': 'https://open.bigmodel.cn/api/paas/v4',
                           'LLM_API_KEY_BACKUP': 'old-zhipu-backup',
                           'LLM_BASE_URL_BACKUP': 'https://open.bigmodel.cn/api/anthropic',
                           'GLM_API_KEY': 'old-glm-key', 'GLM_BASE_URL': 'https://open.bigmodel.cn/api/paas/v4',
                           'VISION_API_KEY': 'old-vision-key', 'VISION_BASE_URL': 'https://open.bigmodel.cn/api/paas/v4'})
        for model in ('glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4v-flash'):
            self.assertEqual(cfg.get_model_connection(model), ('existing-ark', ARK_URL))
        self.assertEqual(cfg.get_model_connection('glm-5.3', backup=True), ('existing-ark', ARK_URL))
        self.assertEqual((cfg.VISION_API_KEY, cfg.VISION_BASE_URL), ('existing-ark', ARK_URL))
        self.assertEqual((cfg.settings.GLM_API_KEY, cfg.settings.GLM_BASE_URL), ('existing-ark', ARK_URL))
        # Do not change the existing embedding model/Key/URL or rebuild its index.
        self.assertEqual((cfg.settings.EMBEDDING_MODEL, cfg.settings.EMBEDDING_API_KEY,
                          cfg.settings.EMBEDDING_BASE_URL),
                         ('embedding-3', 'old-zhipu', 'https://open.bigmodel.cn/api/paas/v4'))

    def test_explicit_ark_keys_take_priority_and_embedding_configuration_is_preserved(self):
        cfg = self.config({'ARK_API_KEY': ' new-ark ', 'ARK_API_KEY_BACKUP': ' new-backup ',
                           'DEEPSEEK_API_KEY': 'old-ark', 'EMBEDDING_MODEL': 'existing-model',
                           'EMBEDDING_API_KEY': 'existing-embedding', 'EMBEDDING_BASE_URL': 'https://embedding.invalid/v1'})
        self.assertEqual(cfg.get_model_connection('glm-5.3'), ('new-ark', ARK_URL))
        self.assertEqual(cfg.get_model_connection('glm-5.3', backup=True), ('new-backup', ARK_URL))
        self.assertEqual((cfg.settings.EMBEDDING_MODEL, cfg.settings.EMBEDDING_API_KEY,
                          cfg.settings.EMBEDDING_BASE_URL),
                         ('existing-model', 'existing-embedding', 'https://embedding.invalid/v1'))

    def test_generic_legacy_keys_are_only_reused_for_exact_ark_coding_chat_endpoint(self):
        cfg = self.config({'LLM_API_KEY': 'legacy-ark', 'LLM_BASE_URL': ARK_URL + '/',
                           'LLM_API_KEY_BACKUP': 'legacy-ark-backup', 'LLM_BASE_URL_BACKUP': ARK_URL})
        self.assertEqual(cfg.get_model_connection('glm-5.3'), ('legacy-ark', ARK_URL))
        self.assertEqual(cfg.get_model_connection('glm-5.3', backup=True), ('legacy-ark-backup', ARK_URL))
        for url in ('https://ark.cn-beijing.volces.com/api/coding',
                    'https://ark.cn-beijing.volces.com/api/v3', 'https://[malformed',
                    'https://open.bigmodel.cn/api/anthropic', 'https://ark.cn-beijing.volces.com.fake.invalid/api/coding/v3'):
            with self.subTest(url=url):
                cfg = self.config({'LLM_API_KEY': 'not-chat-ark', 'LLM_BASE_URL': url,
                                   'LLM_API_KEY_BACKUP': 'not-chat-ark-backup', 'LLM_BASE_URL_BACKUP': url})
                self.assertEqual(cfg.get_model_connection('glm-5.3'), ('', ARK_URL))
                self.assertEqual(cfg.settings.LLM_API_KEY_BACKUP, '')

    def test_whitespace_ark_override_does_not_hide_existing_key(self):
        cfg = self.config({'ARK_API_KEY': '  ', 'ARK_API_KEY_BACKUP': '  ', 'DEEPSEEK_API_KEY': 'existing-ark'})
        self.assertEqual(cfg.get_model_connection('glm-5.3'), ('existing-ark', ARK_URL))
        self.assertEqual(cfg.get_model_connection('glm-5.3', backup=True), ('existing-ark', ARK_URL))

    def test_old_server_default_and_catalogue_migrate_to_glm53(self):
        cfg = self.config({'LLM_MODEL': 'glm-5.2'})
        self.assertEqual(cfg.settings.LLM_MODEL, 'glm-5.3')
        ids = {item['id'] for item in cfg.AVAILABLE_MODELS}
        self.assertIn('glm-5.3', ids)
        self.assertNotIn('glm-5.2', ids)
        self.assertEqual(cfg.resolve_model_id('auto'), 'glm-5.3')


class PreferenceTests(IsolatedSource):
    def test_existing_glm52_preference_is_read_as_glm53_without_rewriting(self):
        self.prefs.save_user_model('admin', 'auto')
        path = self.prefs._path('admin')
        path.write_text('{"model_id":"glm-5.2"}', encoding='utf-8')
        before = path.read_bytes()
        self.assertEqual(self.prefs.load_user_model('admin'), 'glm-5.3')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.prefs.save_user_model('admin', 'glm-5.2'), 'glm-5.3')
    def test_accounts_and_process_default_are_isolated(self):
        self.prefs.save_user_model('admin', 'kimi-k3')
        self.prefs.save_user_model('quanzhiadmin', 'auto')
        self.assertEqual(self.prefs.load_user_model('admin'), 'kimi-k3')
        self.assertEqual(self.prefs.load_user_model('quanzhiadmin'), 'auto')
        self.assertEqual(self.cfg.settings.LLM_MODEL, 'auto')
        self.assertEqual(self.prefs.load_user_model('new-user'), 'auto')

    def test_invalid_model_does_not_overwrite_saved_preference(self):
        self.prefs.save_user_model('admin', 'kimi-k3')
        for value in ('', '../escape', None, 'glm-4-plus'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.prefs.save_user_model('admin', value)
        self.assertEqual(self.prefs.load_user_model('admin'), 'kimi-k3')

    def test_atomic_concurrent_writes_leave_valid_json_no_temp_or_backup(self):
        choices = ['auto', 'kimi-k3', 'glm-5.3'] * 10
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda model: self.prefs.save_user_model('admin', model), choices))
        self.assertIn(self.prefs.load_user_model('admin'), choices)
        files = list(Path(self.temp.name).rglob('*.*'))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].name, hashlib.sha256(b'admin').hexdigest() + '.json')

    def test_write_failure_keeps_previous_file_and_cleans_temporary(self):
        self.prefs.save_user_model('admin', 'kimi-k3')
        with patch.object(self.prefs.os, 'replace', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                self.prefs.save_user_model('admin', 'auto')
        self.assertEqual(self.prefs.load_user_model('admin'), 'kimi-k3')
        self.assertFalse(list(Path(self.temp.name).rglob('*.tmp')))

    def test_corrupt_preference_uses_default(self):
        self.prefs.save_user_model('admin', 'auto')
        with self.prefs._path('admin').open('w', encoding='utf-8') as stream:
            stream.write('{broken')
        self.assertEqual(self.prefs.load_user_model('admin'), self.cfg.settings.LLM_MODEL)

    def test_second_process_observes_saved_choice(self):
        self.prefs.save_user_model('quanzhiadmin', 'kimi-k3')
        code = "import sys,types; d=types.ModuleType('dotenv'); d.load_dotenv=lambda *a,**k:True; sys.modules['dotenv']=d; from app.model_preferences import load_user_model; print(load_user_model('quanzhiadmin'))"
        result = subprocess.run([sys.executable, '-X', 'utf8', '-c', code], cwd=ROOT,
                                 env={**os.environ, 'DATA_DIR': self.temp.name}, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), 'kimi-k3')

    def test_multiple_worker_processes_can_write_and_read(self):
        code = "import sys,types; d=types.ModuleType('dotenv'); d.load_dotenv=lambda *a,**k:True; sys.modules['dotenv']=d; from app.model_preferences import save_user_model,load_user_model; [ (save_user_model('admin',m),load_user_model('admin')) for m in ['auto','kimi-k3','glm-5.2']*10 ]"
        children = [subprocess.Popen([sys.executable, '-X', 'utf8', '-c', code], cwd=ROOT,
                         env={**os.environ, 'DATA_DIR': self.temp.name}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    for _ in range(4)]
        results = [(child, child.communicate(timeout=30)) for child in children]
        for child, (out, err) in results:
            self.assertEqual(child.returncode, 0, err.decode('utf-8'))
        self.assertIn(self.prefs.load_user_model('admin'), ['auto', 'kimi-k3', 'glm-5.3'])


class APITests(IsolatedSource):
    def setUp(self):
        super().setUp()
        self.calls = []
        def chat(*args, **kwargs):
            self.calls.append(('sync', kwargs))
            return 'OK'
        async def generate(*args, **kwargs):
            self.calls.append(('stream', kwargs))
            yield {'type': 'token', 'content': 'OK'}
        async def multimodal(*args, **kwargs):
            self.calls.append(('image', kwargs))
            yield {'type': 'token', 'content': 'OK'}
        async def wrapper(factory, *args, **kwargs):
            async for item in factory():
                yield 'data: ' + json.dumps(item) + '\n\n'
        self.scope = dict(self.cfg.__dict__, BaseModel=BaseModel, asyncio=asyncio, Depends=Depends,
                          HTTPException=HTTPException, Request=Request, UploadFile=UploadFile, File=File,
                          Form=Form, StreamingResponse=StreamingResponse, router=APIRouter(),
                          get_username_from_token=lambda token: token if token in ('admin', 'quanzhiadmin') else None,
                          chat=chat, chat_stream_generator=generate,
                          chat_stream_generator_multimodal=multimodal, _sse_stream_wrapper=wrapper,
                          ensure_chat_ownership=lambda *args: None, ensure_kb_upload_permission=lambda *args: None,
                          record_message=lambda **kw: None, update_chat_time=lambda *args: None,
                          _record_request=lambda *args, **kw: None, time=time, os=os, base64=base64,
                          unquote=unquote, logger=logging.getLogger('test'), MAX_FILE_SIZE=50 * 1024 * 1024,
                          load_user_model=self.prefs.load_user_model, save_user_model=self.prefs.save_user_model,
                          validate_model_id=self.prefs.validate_model_id)
        definitions('app/api/routes.py', ['get_current_user', 'require_auth', 'ChatRequest', 'ChatResponse', 'ModelSetRequest', '_request_model_id',
                    'get_models', 'set_model', 'chat_api', 'chat_stream_api', 'chat_with_file_stream'], self.scope)
        app = FastAPI()
        app.include_router(self.scope['router'], prefix='/api/v1')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def headers(self, account='admin'):
        return {'Authorization': 'Bearer ' + account}

    def test_http_select_one_account_does_not_change_other(self):
        result = self.client.post('/api/v1/models/set', headers=self.headers(), json={'model_id': 'kimi-k3'})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()['success'])
        self.assertEqual(self.client.get('/api/v1/models', headers=self.headers()).json()['current'], 'kimi-k3')
        other = self.client.get('/api/v1/models', headers=self.headers('quanzhiadmin')).json()
        self.assertEqual((other['current'], other['effective']), ('auto', 'glm-5.3'))
        self.assertEqual(self.cfg.settings.LLM_MODEL, 'auto')

    def test_old_client_glm52_request_and_selector_normalize_to_glm53(self):
        response = self.client.post('/api/v1/models/set', headers=self.headers(), json={'model_id': 'glm-5.2'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['current'], 'glm-5.3')
        for endpoint in ('/chat', '/chat/stream'):
            response = self.client.post('/api/v1' + endpoint, headers=self.headers(),
                                        json={'message': 'hi', 'model_id': 'glm-5.2'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.calls[-1][1]['model_override'], 'glm-5.3')

    def test_old_doubao_preference_requests_and_catalogue_migrate_to_seed21pro(self):
        self.prefs.save_user_model('admin', 'auto')
        path = self.prefs._path('admin')
        path.write_text('{"model_id":"Doubao-Seed-2.0-pro"}', encoding='utf-8')
        response = self.client.get('/api/v1/models', headers=self.headers())
        self.assertEqual(response.json()['current'], 'doubao-seed-2.1-pro')
        models = {item['id']: item['name'] for item in response.json()['models']}
        self.assertEqual(models['doubao-seed-2.1-pro'], 'Doubao-Seed-2.1-Pro')
        self.assertNotIn('Doubao-Seed-2.0-pro', models)
        for endpoint in ('/chat', '/chat/stream'):
            response = self.client.post('/api/v1' + endpoint, headers=self.headers(),
                                       json={'message': 'hi', 'model_id': 'Doubao-Seed-2.0-pro'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.calls[-1][1]['model_override'], 'doubao-seed-2.1-pro')

    def test_http_authentication_and_validation_before_model_call(self):
        self.assertEqual(self.client.get('/api/v1/models').status_code, 401)
        self.assertEqual(self.client.get('/api/v1/models', headers={'Authorization': 'Bearer invalid'}).status_code, 401)
        self.assertEqual(self.client.post('/api/v1/models/set', json={'model_id': 'auto'}).status_code, 401)
        self.assertEqual(self.client.post('/api/v1/models/set', headers=self.headers(), json={'model_id': 'bad'}).status_code, 400)
        for endpoint in ('/chat', '/chat/stream'):
            response = self.client.post('/api/v1' + endpoint, headers=self.headers(), json={'message': 'hi', 'model_id': 'bad'})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.calls, [])

    def test_chat_sync_and_stream_honor_explicit_model_not_global_or_preference(self):
        self.prefs.save_user_model('quanzhiadmin', 'kimi-k3')
        for endpoint, kind in (('/chat', 'sync'), ('/chat/stream', 'stream')):
            with self.subTest(endpoint=endpoint):
                response = self.client.post('/api/v1' + endpoint, headers=self.headers('quanzhiadmin'),
                                            json={'message': 'hi', 'model_id': 'auto', 'session_id': 'other'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.calls[-1][0], kind)
                self.assertEqual(self.calls[-1][1]['model_override'], 'auto')

    def test_legacy_request_uses_account_saved_model(self):
        self.prefs.save_user_model('quanzhiadmin', 'kimi-k3')
        response = self.client.post('/api/v1/chat/stream', headers=self.headers('quanzhiadmin'), json={'message': 'hi'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls[-1][1]['model_override'], 'kimi-k3')

    def test_file_and_image_requests_keep_model_choice(self):
        for filename, kind in (('code.py', 'stream'), ('image.png', 'image')):
            with self.subTest(filename=filename):
                response = self.client.post('/api/v1/chat-with-file/stream', headers=self.headers('quanzhiadmin'),
                    data={'model_id': 'auto', 'store_to_kb': 'false', 'skill': '8d-skill'},
                    files={'file': (filename, b'test')})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.calls[-1][0], kind)
                self.assertEqual(self.calls[-1][1]['model_override'], 'auto')
                self.assertEqual(self.calls[-1][1]['skill'], '8d-skill')

    def test_explicit_model_does_not_read_preferences_on_chat_hot_path(self):
        with patch.dict(self.scope, load_user_model=lambda account: self.fail('unexpected disk read')):
            self.assertEqual(self.client.post('/api/v1/chat/stream', headers=self.headers(),
                                             json={'message': 'hi', 'model_id': 'auto'}).status_code, 200)


class CoreSelectionTests(IsolatedSource):
    def test_multimodal_auto_uses_ark_glm53_flash_not_text_glm53(self):
        selected = []
        async def stream(*args):
            yield SimpleNamespace(content='OK')
        def create(**kw):
            selected.append(kw['model_override'])
            return SimpleNamespace(astream=stream)
        scope = dict(self.core, AsyncGenerator=AsyncGenerator, create_llm=create,
                     set_current_agent_id=lambda *a: None, set_current_session_id=lambda *a: None,
                     _resolve_agent_task=lambda *a: None, get_session_history=lambda *a: SimpleNamespace(messages=[], add_message=lambda *a: None),
                     MAX_HISTORY_MESSAGES=20, HumanMessage=HumanMessage, SystemMessage=SystemMessage,
                     AIMessage=AIMessage, _inject_current_date=lambda value: value, SYSTEM_PROMPT='prompt',
                     _extract_content=lambda chunk: chunk.content)
        definitions('app/agent/core.py', ['chat_stream_generator_multimodal'], scope)
        async def run():
            return [event async for event in scope['chat_stream_generator_multimodal'](
                [{'type': 'text', 'text': 'describe'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,dGVzdA=='}}],
                model_override='auto')]
        events = asyncio.run(run())
        self.assertEqual(selected, ['glm-5.3-flash'])
        self.assertEqual([event['content'] for event in events if event['type'] == 'token'], ['OK'])
        self.assertEqual(events[-1]['type'], 'done')

    def test_graph_retry_keeps_selected_model_when_default_changes(self):
        calls = []
        settings = self.cfg.settings
        class Client:
            def __init__(self, fail): self.fail = fail
            def bind_tools(self, *args, **kwargs): return self
            async def ainvoke(self, messages):
                if self.fail:
                    settings.LLM_MODEL = 'kimi-k3'
                    raise TimeoutError('timeout')
                return AIMessage(content='OK')
        class Graph:
            def __init__(self, state): self.nodes = {}
            def add_node(self, name, fn): self.nodes[name] = fn
            def set_entry_point(self, *args): pass
            def add_conditional_edges(self, *args): pass
            def add_edge(self, *args): pass
            def compile(self): return self
        async def sleep(*args): pass
        def create(**kwargs):
            calls.append(kwargs)
            return Client(len(calls) == 1)
        scope = dict(self.core, hashlib=hashlib, create_llm=create, AgentState=dict, StateGraph=Graph,
                     get_tools=lambda **kw: [], _sanitize_tools_for_moonshot=lambda tools, kimi: tools,
                     ParallelToolNode=lambda *a, **kw: None, _agent_prompt_graph_cache={},
                     _agent_prompt_graph_timestamps={}, _AGENT_PROMPT_CACHE_MAX_SIZE=64,
                     _cleanup_stale_graph_cache=lambda: None, END='end', SystemMessage=SystemMessage,
                     ToolMessage=ToolMessage, _is_session_cancelled=lambda: False,
                     asyncio=SimpleNamespace(CancelledError=asyncio.CancelledError, sleep=sleep))
        definitions('app/agent/core.py', ['get_agent_with_prompt'], scope)
        graph = scope['get_agent_with_prompt']('prompt', model_override='auto')
        result = asyncio.run(graph.nodes['think']({'messages': [HumanMessage(content='hi')]}))
        self.assertEqual(result['messages'][0].content, 'OK')
        self.assertEqual([call['model_override'] for call in calls], ['auto', 'auto'])
        self.assertEqual(settings.LLM_MODEL, 'kimi-k3')

    def test_chat_mode_auth_error_does_not_claim_backup_success(self):
        selected = []
        async def failing(*args, **kwargs):
            raise RuntimeError('invalid_api_key')
            yield
        def create(**kwargs):
            selected.append(kwargs['model_override'])
            return SimpleNamespace(astream=failing)
        scope = dict(self.core, create_llm=create, AsyncGenerator=AsyncGenerator,
                     set_current_agent_id=lambda *a: None, set_current_session_id=lambda *a: None,
                     reset_search_count=lambda: None, _resolve_agent_task=lambda *a: None,
                     _inject_current_date=lambda value: value, _is_simple_query=lambda text: True,
                     CHAT_SYSTEM_PROMPT='prompt', MAX_HISTORY_MESSAGES=20,
                     get_session_history=lambda session: SimpleNamespace(messages=[]),
                     HumanMessage=HumanMessage, SystemMessage=SystemMessage, AIMessage=AIMessage,
                     _extract_content=lambda chunk: chunk.content, asyncio=asyncio)
        definitions('app/agent/core.py', ['_chat_mode_stream'], scope)
        async def run():
            return [event async for event in scope['_chat_mode_stream']('hi', model_override='auto')]
        events = asyncio.run(run())
        self.assertEqual(selected, ['auto'])
        self.assertIn('模型服务认证失败', events[-1]['content'])
        self.assertNotIn('已自动切换', events[-1]['content'])

    def test_graph_cache_separates_auto_and_explicit_models(self):
        calls = []
        class Graph:
            def __init__(self, state):
                self.nodes = {}
            def add_node(self, name, fn):
                self.nodes[name] = fn
            def set_entry_point(self, *args): pass
            def add_conditional_edges(self, *args): pass
            def add_edge(self, *args): pass
            def compile(self): return self
        class Client:
            def bind_tools(self, *args, **kw): return self
        def create(**kw):
            calls.append(kw)
            return Client()
        scope = dict(self.core, hashlib=hashlib, create_llm=create, AgentState=dict, StateGraph=Graph,
                     get_tools=lambda **kw: [], _sanitize_tools_for_moonshot=lambda tools, kimi: tools,
                     ParallelToolNode=lambda *a, **kw: None, _agent_prompt_graph_cache={},
                     _agent_prompt_graph_timestamps={}, _AGENT_PROMPT_CACHE_MAX_SIZE=64,
                     _cleanup_stale_graph_cache=lambda: None, END='end')
        definitions('app/agent/core.py', ['get_agent_with_prompt'], scope)
        get = scope['get_agent_with_prompt']
        auto = get('prompt', model_override='auto')
        glm = get('prompt', model_override='glm-5.3')
        kimi = get('prompt', model_override='kimi-k3', skill='pfmea-dfmea-skill')
        self.assertIsNot(auto, glm)
        self.assertIsNot(glm, kimi)
        self.cfg.settings.LLM_MODEL = 'qwen3.7-plus'
        self.assertIs(get('prompt', model_override='auto'), auto)
        self.assertEqual([call['model_override'] for call in calls], ['auto', 'glm-5.3', 'kimi-k3'])
        self.assertTrue(calls[-1]['force_non_streaming'])

    def test_every_request_core_client_and_graph_creation_carries_snapshot(self):
        tree = ast.parse((ROOT / 'app/agent/core.py').read_text(encoding='utf-8-sig'))
        relevant = {'chat', 'chat_stream_generator', '_chat_mode_stream', 'get_agent_with_prompt'}
        checked = 0
        for fn in tree.body:
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name in relevant:
                for call in ast.walk(fn):
                    if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in ('create_llm', 'get_agent_with_prompt'):
                        self.assertIn('model_override', {kw.arg for kw in call.keywords}, fn.name)
                        checked += 1
        self.assertGreaterEqual(checked, 7)

    def test_false_switched_message_is_removed(self):
        source = (ROOT / 'app/agent/core.py').read_text(encoding='utf-8-sig')
        self.assertNotIn('主API Key已失效，已自动切换到备用Key，请重新提问', source)
        self.assertNotIn('_check_and_switch_to_backup', source)
        self.assertIn('模型服务认证失败，请检查服务端对应的 API Key 和接口地址。', source)


if __name__ == '__main__':
    unittest.main()
