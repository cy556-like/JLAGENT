"""Offline concurrency regressions: no paid model requests or production data.

Run: python -X utf8 -m unittest discover -s tests -p test_resource_guard.py -v
The resource module is loaded in full; existing route bodies are AST-loaded
without initializing the application's vector database or credential store.
"""
import ast
import asyncio
import concurrent.futures
import contextvars
import importlib.util
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / 'app/utils/resource_guard.py'
spec = importlib.util.spec_from_file_location('jlagent_test_resources', MODULE_PATH)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def limits(directory, **changes):
    env = {'JLAGENT_' + key.upper(): str(value) for key, value in changes.items()}
    with patch.dict(os.environ, env, clear=True):
        return guard.RuntimeLimits(directory, memory_probe=lambda: 4096)


async def invoke(app, path='/api/v1/chat/stream', user='user', method='POST', send=None):
    events = []
    async def receive():
        await asyncio.Event().wait()
    async def collect(event):
        events.append(event)
    scope = {'type': 'http', 'method': method, 'path': path,
             'headers': [(b'authorization', ('Bearer ' + user).encode())],
             'client': ('127.0.0.1', 1234)}
    await app(scope, receive, send or collect)
    return events


class SlotsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pool = guard.SlotPool(self.temp.name)

    def test_same_process_capacity_and_idempotent_release(self):
        leases = [self.pool.try_acquire('chat', 2) for _ in range(2)]
        self.assertTrue(all(leases))
        self.assertIsNone(self.pool.try_acquire('chat', 2))
        leases[0].release()
        leases[0].release()
        replacement = self.pool.try_acquire('chat', 2)
        self.assertIsNotNone(replacement)
        replacement.release()
        leases[1].release()

    def test_actual_cross_process_lock_and_crash_recovery(self):
        code = (
            "import importlib.util,sys,time; "
            "s=importlib.util.spec_from_file_location('guard',sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "lease=m.SlotPool(sys.argv[2]).try_acquire('shared',1); "
            "print('ACQUIRED' if lease else 'BUSY',flush=True); "
            "time.sleep(30) if sys.argv[3]=='hold' else None"
        )
        child = subprocess.Popen([sys.executable, '-c', code, str(MODULE_PATH), self.temp.name, 'hold'],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ACQUIRED')
            self.assertIsNone(self.pool.try_acquire('shared', 1))
            other = subprocess.run([sys.executable, '-c', code, str(MODULE_PATH), self.temp.name, 'probe'],
                                   capture_output=True, text=True, timeout=10, check=True)
            self.assertEqual(other.stdout.strip(), 'BUSY')
        finally:
            child.terminate()
            child.communicate(timeout=10)
        lease = self.pool.try_acquire('shared', 1)
        self.assertIsNotNone(lease, 'OS must release permits when a worker dies')
        lease.release()

    def test_defaults_and_invalid_environment_do_not_block_every_request(self):
        runtime = limits(self.temp.name)
        self.assertEqual((runtime.chat_limit, runtime.user_chat_limit, runtime.file_limit,
                          runtime.document_limit, runtime.read_limit), (20, 2, 2, 1, 2))
        bad = limits(self.temp.name, chat_concurrency='bad', file_concurrency=0,
                     document_concurrency=-1)
        self.assertEqual((bad.chat_limit, bad.file_limit, bad.document_limit), (20, 2, 1))
        self.assertTrue(runtime.snapshot()['shared_across_workers'])

    def test_nested_document_calls_do_not_deadlock(self):
        runtime = limits(self.temp.name)
        with patch.object(guard, 'get_runtime_limits', return_value=runtime):
            @guard.bounded_document_work
            def outer():
                return inner()
            @guard.bounded_document_work
            def inner():
                self.assertIsNone(runtime.pool.try_acquire('document-work', 1))
                return 42
            self.assertEqual(outer(), 42)
        lease = runtime.pool.try_acquire('document-work', 1)
        self.assertIsNotNone(lease)
        lease.release()

    def test_read_lane_not_blocked_by_cloud_indexing(self):
        runtime = limits(self.temp.name)
        with runtime.document_work():
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                def read():
                    with runtime.document_work('document-read'):
                        return 'read ready'
                self.assertEqual(pool.submit(read).result(timeout=2), 'read ready')


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = limits(self.temp.name)
        self.started = asyncio.Queue()
        self.release = asyncio.Event()
        self.running = []
        self.calls = 0
        async def held(scope, receive, send):
            self.calls += 1
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await self.started.put(scope['path'])
            await self.release.wait()
            await send({'type': 'http.response.body', 'body': b'OK'})
        self.app = guard.ResourceGuardMiddleware(held, self.runtime, lambda token: token)

    async def asyncTearDown(self):
        self.release.set()
        await asyncio.gather(*self.running, return_exceptions=True)
        self.temp.cleanup()

    async def start(self, **kwargs):
        task = asyncio.create_task(invoke(self.app, **kwargs))
        self.running.append(task)
        await asyncio.wait_for(self.started.get(), 2)
        return task

    async def test_twenty_accounts_are_parallel_twenty_first_is_busy(self):
        for index in range(20):
            await self.start(user='account-' + str(index))
        events = await invoke(self.app, user='account-21')
        self.assertEqual(events[0]['status'], 503)
        self.assertEqual(self.calls, 20)
        self.assertIn('detail', json.loads(events[1]['body']))
        self.assertIn((b'retry-after', b'3'), events[0]['headers'])

    async def test_account_quota_does_not_block_another_account(self):
        await self.start(user='one')
        await self.start(user='one')
        self.assertEqual((await invoke(self.app, user='one'))[0]['status'], 429)
        await self.start(user='two')
        self.assertEqual(self.calls, 3)

    async def test_stream_holds_quota_after_headers_and_releases_when_finished(self):
        self.runtime.chat_limit = 1
        task = await self.start(user='one')
        self.assertEqual((await invoke(self.app, user='two'))[0]['status'], 503)
        self.release.set()
        await task
        self.assertEqual((await invoke(self.app, user='two'))[0]['status'], 200)

    async def test_cancel_releases_quota_and_partial_admission_leases(self):
        self.runtime.chat_limit = 1
        task = await self.start(user='one')
        self.assertEqual((await invoke(self.app, user='two'))[0]['status'], 503)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.release.set()
        self.assertEqual((await invoke(self.app, user='two'))[0]['status'], 200)

    async def test_exceptions_do_not_leak_capacity(self):
        async def crash(scope, receive, send):
            raise RuntimeError('fake error')
        app = guard.ResourceGuardMiddleware(crash, self.runtime, lambda token: token)
        for _ in range(4):
            with self.assertRaises(RuntimeError):
                await invoke(app)
        self.release.set()
        self.assertEqual((await invoke(self.app))[0]['status'], 200)

    async def test_file_slots_are_separate_from_chat(self):
        await self.start(path='/api/v1/upload', user='one')
        await self.start(path='/api/v1/upload', user='two')
        self.assertEqual((await invoke(self.app, path='/api/v1/upload', user='three'))[0]['status'], 503)
        self.assertEqual((await invoke(self.app, path='/api/v1/upload', user='one'))[0]['status'], 429)
        await self.start(user='three')
        self.assertEqual(self.calls, 3)

    async def test_file_chat_releases_file_slot_before_long_model_stream(self):
        self.runtime.file_limit = 1
        await self.start(path='/api/v1/chat-with-file/stream', user='one')
        await self.start(path='/api/v1/upload', user='two')
        self.assertEqual(self.calls, 2)

    async def test_pressure_rejects_only_new_work_not_history_auth_or_active_stream(self):
        task = await self.start()
        self.runtime.memory_probe = lambda: 100
        events = await invoke(self.app, user='two')
        self.assertEqual(events[0]['status'], 503)
        self.assertFalse(task.done())
        for path in ('/api/v1/login', '/api/v1/history/session', '/health', '/static/index.html',
                     '/api/v1/documents/example/download'):
            await self.start(path=path, method='GET')
        self.runtime.memory_probe = lambda: None
        await self.start(user='two')

    async def test_failed_file_admission_releases_reserved_chat_slot(self):
        self.runtime.file_limit = 1
        self.runtime.chat_limit = 1
        await self.start(path='/api/v1/upload', user='one')
        rejected = await invoke(self.app, path='/api/v1/chat-with-file/stream', user='two')
        self.assertEqual(rejected[0]['status'], 503)
        await self.start(user='two')

    async def test_canceled_http_keeps_file_capacity_until_actual_thread_finishes(self):
        begun, stop = threading.Event(), threading.Event()
        def worker():
            begun.set()
            stop.wait(5)
            return 'complete'
        async def process(scope, receive, send):
            result = await guard.document_thread(worker)
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await send({'type': 'http.response.body', 'body': result.encode()})
        self.runtime.file_limit = 1
        app = guard.ResourceGuardMiddleware(process, self.runtime, lambda token: token)
        task = asyncio.create_task(invoke(app, path='/api/v1/upload', user='one'))
        try:
            while not begun.is_set():
                await asyncio.sleep(0.005)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual((await invoke(app, path='/api/v1/upload', user='two'))[0]['status'], 503)
            self.assertEqual((await invoke(app, path='/api/v1/upload', user='one'))[0]['status'], 429)
        finally:
            stop.set()
            await asyncio.sleep(0.05)
        self.assertEqual((await invoke(app, path='/api/v1/upload', user='two'))[0]['status'], 200)

    async def test_standard_fastapi_middleware_keeps_guard_until_full_stream(self):
        import httpx
        from fastapi import FastAPI
        from fastapi.responses import StreamingResponse
        app = FastAPI()
        self.runtime.chat_limit = 1
        @app.post('/api/v1/chat/stream')
        async def endpoint():
            async def response():
                await self.started.put(True)
                yield b'data: start\n\n'
                await self.release.wait()
                yield b'data: end\n\n'
            return StreamingResponse(response(), media_type='text/event-stream')
        app.add_middleware(guard.ResourceGuardMiddleware, limits=self.runtime, user_resolver=lambda token: token)
        @app.middleware('http')
        async def logging_style(request, call_next):
            return await call_next(request)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            task = asyncio.create_task(client.post('/api/v1/chat/stream', headers={'Authorization': 'Bearer one'}))
            self.running.append(task)
            await asyncio.wait_for(self.started.get(), 2)
            rejected = await client.post('/api/v1/chat/stream', headers={'Authorization': 'Bearer two'})
            self.assertEqual(rejected.status_code, 503)
            self.release.set()
            self.assertEqual((await task).status_code, 200)
            self.assertEqual((await client.post('/api/v1/chat/stream', headers={'Authorization': 'Bearer two'})).status_code, 200)


class IndexQueueTests(unittest.TestCase):
    def setUp(self):
        self.queue = guard.BackgroundIndexQueue(workers=1, max_pending=2)
        self.stop = threading.Event()
        self.addCleanup(lambda: self.queue.executor.shutdown(wait=True))
        self.addCleanup(self.stop.set)

    def test_bounded_backlog_and_latest_update_coalescing(self):
        started, finished = threading.Event(), threading.Event()
        calls = []
        def first():
            started.set()
            self.stop.wait(3)
            calls.append('first')
        def latest(value):
            calls.append(value)
            if value == 'other':
                finished.set()
        self.assertTrue(self.queue.submit('same', first))
        self.assertTrue(started.wait(2))
        self.assertTrue(self.queue.submit('same', latest, 'old'))
        self.assertTrue(self.queue.submit('same', latest, 'latest'))
        self.assertTrue(self.queue.submit('other', latest, 'other'))
        self.assertFalse(self.queue.submit('overflow', latest, 'overflow'))
        self.stop.set()
        self.assertTrue(finished.wait(3))
        self.queue.executor.shutdown(wait=True)
        self.assertEqual(calls, ['first', 'latest', 'other'])
        self.assertEqual(self.queue._pending, {})

    def test_request_context_is_propagated_to_background_worker(self):
        account = contextvars.ContextVar('test-account')
        account.set('independent-user')
        observed, finished = [], threading.Event()
        def work():
            observed.append(account.get())
            finished.set()
        self.queue.submit('context', work)
        self.assertTrue(finished.wait(2))
        self.assertEqual(observed, ['independent-user'])

    def test_failed_job_does_not_leave_pending_key(self):
        def fail():
            raise ValueError('fake')
        self.queue.submit('failed', fail)
        self.queue.executor.shutdown(wait=True)
        self.assertEqual(self.queue._pending, {})

    def test_rapid_resubmissions_are_not_lost(self):
        calls = []
        for index in range(200):
            self.queue.submit('same', calls.append, index)
            if index % 5 == 0:
                time.sleep(0.001)
        self.queue.executor.shutdown(wait=True)
        self.assertEqual(calls[-1], 199)
        self.assertEqual(self.queue._pending, {})


def source_function(filename, name, scope):
    tree = ast.parse((ROOT / filename).read_text(encoding='utf-8-sig'))
    node = next(n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec'), scope)
    return scope[name]


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.persisted = []
        self.scope = {'asyncio': asyncio, 'time': time, 'json': json, 'Request': object,
                      'logger': logging.getLogger('test-sse'), 'SSE_BUFFER_EVENTS': 3,
                      'update_chat_time': lambda *args: self.persisted.append('update'),
                      'flush_session': lambda *args: self.persisted.append('flush'),
                      '_record_request': lambda *args: None}
        self.wrapper = source_function('app/api/routes.py', '_sse_stream_wrapper', self.scope)
        class Request:
            async def is_disconnected(self):
                return False
        self.request = Request()

    def stream(self, factory):
        return self.wrapper(factory, self.request, 'session', time.time(), 'user')

    async def test_slow_client_has_bounded_backlog_and_close_cancels_producer(self):
        produced, stopped = [], asyncio.Event()
        async def factory():
            try:
                for index in range(1000):
                    produced.append(index)
                    yield {'type': 'token', 'content': str(index)}
            finally:
                stopped.set()
        stream = self.stream(factory)
        self.assertIn('0', await anext(stream))
        await asyncio.sleep(0.03)
        self.assertLessEqual(len(produced), 1 + 3 + 1)
        self.assertFalse(stopped.is_set())
        await stream.aclose()
        self.assertTrue(stopped.is_set())

    async def test_full_output_order_and_completion_flush(self):
        async def factory():
            for index in range(100):
                yield {'type': 'token', 'content': str(index)}
            yield {'type': 'done'}
        received = [json.loads(item[6:]) async for item in self.stream(factory)]
        self.assertEqual([item['content'] for item in received[:-1]], [str(i) for i in range(100)])
        self.assertEqual(received[-1]['type'], 'done')
        self.assertEqual(self.persisted, ['update', 'flush'])

    async def test_model_error_returns_error_then_done_without_orphan(self):
        async def factory():
            yield {'type': 'token', 'content': 'start'}
            raise ValueError('fake model error')
        received = [json.loads(item[6:]) async for item in self.stream(factory)]
        self.assertEqual([item['type'] for item in received], ['token', 'error', 'done'])


class DocumentWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_event_loop_stays_responsive_while_document_workers_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = limits(directory)
            first, stop = threading.Event(), threading.Event()
            active, maximum = 0, 0
            lock = threading.Lock()
            def work():
                nonlocal active, maximum
                with runtime.document_work():
                    with lock:
                        active += 1
                        maximum = max(maximum, active)
                    first.set()
                    stop.wait(3)
                    with lock:
                        active -= 1
            tasks = [asyncio.create_task(guard.document_thread(work)) for _ in range(3)]
            try:
                while not first.is_set():
                    await asyncio.sleep(0.005)
                for _ in range(10):
                    await asyncio.sleep(0.005)
                self.assertEqual(maximum, 1)
                self.assertFalse(any(task.done() for task in tasks))
            finally:
                stop.set()
                await asyncio.wait_for(asyncio.gather(*tasks), 3)
            self.assertEqual(maximum, 1)

    async def test_upload_and_file_chat_save_exact_bounded_bytes_off_event_loop(self):
        from types import SimpleNamespace
        from urllib.parse import unquote
        from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
        from fastapi.responses import StreamingResponse
        import base64
        with tempfile.TemporaryDirectory() as directory:
            main_thread = threading.get_ident()
            workers = []
            save = source_function('app/api/routes.py', '_save_uploaded_bytes', {})
            def save_checked(*args):
                workers.append(threading.get_ident())
                return save(*args)
            def index(path, *args, **kwargs):
                self.assertNotEqual(threading.get_ident(), main_thread)
                self.assertEqual(Path(path).read_bytes(), b'bounded data')
                return {'status': 'success', 'chunks': 1}
            async def wrapper(*args, **kwargs):
                yield 'done'
            scope = dict(router=APIRouter(), Depends=Depends, File=File, Form=Form,
                         UploadFile=UploadFile, Request=Request, HTTPException=HTTPException,
                         require_auth=lambda: 'user', ensure_kb_upload_permission=lambda *a: None,
                         ensure_chat_ownership=lambda *a: None, record_message=lambda **kw: None,
                         _request_model_id=lambda *a: None, document_thread=guard.document_thread,
                         _save_uploaded_bytes=save_checked, index_document=index,
                         _sse_stream_wrapper=wrapper, StreamingResponse=StreamingResponse,
                         load_document=lambda *a: [SimpleNamespace(page_content='read')],
                         logger=logging.getLogger('test-upload'), MAX_FILE_SIZE=12,
                         settings=SimpleNamespace(DOCUMENTS_DIR=directory, DATA_DIR=directory),
                         os=os, time=time, unquote=unquote, base64=base64)
            async def model(*args):
                return 'auto'
            scope['_request_model_id'] = model
            upload = source_function('app/api/routes.py', 'upload_document', scope)
            file_chat = source_function('app/api/routes.py', 'chat_with_file_stream', scope)
            class FileObject:
                filename = 'sample.txt'
                async def read(self, size):
                    self.size = size
                    return b'bounded data'
            file = FileObject()
            response = await upload(file=file, agent_id='agent', username='user')
            self.assertEqual(response['status'], 'success')
            self.assertEqual(file.size, 13)
            await file_chat(request=object(), file=FileObject(), message='hi', session_id='session',
                            web_search='false', mode='agent', agent_id='agent', store_to_kb='false',
                            username='user', model_id='auto', skill='')
            self.assertTrue(workers)
            self.assertTrue(all(worker != main_thread for worker in workers))
            self.assertEqual((Path(directory) / 'temp/session/sample.txt').read_bytes(), b'bounded data')


class VectorCacheTests(unittest.TestCase):
    def test_twenty_cold_requests_reuse_one_client_and_keep_cached_reads_lock_free(self):
        from types import SimpleNamespace
        initialized = []
        def chroma(**kwargs):
            initialized.append(kwargs['collection_name'])
            time.sleep(0.005)
            return SimpleNamespace(**kwargs)
        scope = dict(threading=threading, time=time, logger=logging.getLogger('test-vector'),
                     _embedding_available=None, _embedding_degraded_at=None, _chroma_client=None,
                     _vector_store_cache={}, _vector_store_init_lock=threading.RLock(),
                     _VECTOR_STORE_CACHE_MAX_SIZE=20, _CHROMA_CLIENT_TTL=1800,
                     settings=SimpleNamespace(CHROMA_DIR='unused'), Chroma=chroma,
                     get_embeddings=lambda: object(), _get_collection_name=lambda aid: 'agent_' + str(aid))
        source_function('app/rag/document.py', '_get_vector_store_initialized', scope)
        get_store = source_function('app/rag/document.py', 'get_vector_store', scope)
        fake = SimpleNamespace(PersistentClient=lambda **kwargs: SimpleNamespace())
        with patch.dict(sys.modules, chromadb=fake):
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                stores = list(pool.map(lambda _: get_store('same'), range(20)))
                self.assertEqual(initialized, ['agent_same'])
                self.assertTrue(all(item is stores[0] for item in stores))
                with scope['_vector_store_init_lock']:
                    self.assertIs(pool.submit(get_store, 'same').result(timeout=1), stores[0])


class AsyncSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_initialization_and_neighbor_lookup_run_off_loop_with_same_results(self):
        from types import SimpleNamespace
        main = threading.get_ident()
        visited = []
        def store(**kwargs):
            self.assertNotEqual(threading.get_ident(), main)
            visited.append(('store', kwargs['agent_id']))
            return object()
        def neighbors(results, **kwargs):
            self.assertNotEqual(threading.get_ident(), main)
            visited.append(('neighbors', kwargs['agent_id']))
            return results
        doc = SimpleNamespace(page_content='match', metadata={'source_file': 'file', 'chunk_index': 0})
        scope = dict(asyncio=asyncio, time=time, logger=logging.getLogger('test-search'),
                     _embedding_available=True, get_vector_store=store,
                     _generate_multi_queries=lambda query: [query],
                     _safe_similarity_search_with_score=lambda *a: [(doc, 0.4)],
                     _bm25_keyword_search=lambda *a, **kw: [], _expand_context_window=neighbors)
        search = source_function('app/rag/document.py', 'search_documents_async', scope)
        self.assertEqual(await search('query', agent_id=None), [])
        result = await search('query', agent_id='independent-agent')
        self.assertEqual(result, [{'content': 'match', 'source': 'file', 'chunk_index': 0, 'relevance_score': 0.8}])
        self.assertEqual(visited, [('store', 'independent-agent'), ('neighbors', 'independent-agent')])


class SourceCoverageTests(unittest.TestCase):
    def test_every_guarded_route_call_uses_worker_offload(self):
        tree = ast.parse((ROOT / 'app/api/routes.py').read_text(encoding='utf-8-sig'))
        heavy = {'load_document', 'index_document', 'update_document', 'delete_document',
                 'delete_agent_collection', 'reindex_all_documents', 'export_document_as_docx',
                 'export_document_as_xlsx', 'search_documents', '_save_uploaded_bytes'}
        found = set()
        for function in tree.body:
            if isinstance(function, ast.AsyncFunctionDef):
                for call in (node for node in ast.walk(function) if isinstance(node, ast.Call)):
                    if isinstance(call.func, ast.Name):
                        self.assertNotIn(call.func.id, heavy, function.name + ' blocks the event loop')
                    if call.args and isinstance(call.args[0], ast.Name) and call.args[0].id in heavy:
                        found.add(call.args[0].id)
        self.assertEqual(found, heavy)

    def test_file_read_is_bounded_before_existing_fifty_mb_validation(self):
        tree = ast.parse((ROOT / 'app/api/routes.py').read_text(encoding='utf-8-sig'))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and
                 isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and
                 node.func.value.id == 'file' and node.func.attr == 'read']
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(ast.unparse(call.args[0]), 'MAX_FILE_SIZE + 1')

    def test_rag_decorators_are_imported_and_write_read_lanes_are_distinct(self):
        tree = ast.parse((ROOT / 'app/rag/document.py').read_text(encoding='utf-8-sig'))
        imports = {n.name for node in tree.body if isinstance(node, ast.ImportFrom) and
                   node.module == 'app.utils.resource_guard' for n in node.names}
        self.assertEqual(imports, {'bounded_document_work', 'background_indexes'})
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        self.assertEqual(ast.unparse(functions['load_document'].decorator_list[0]),
                         "bounded_document_work(lane='document-read')")
        for name in ('index_document', 'reindex_all_documents', 'update_document', 'delete_document',
                     'delete_agent_collection'):
            self.assertEqual(ast.unparse(functions[name].decorator_list[0]), 'bounded_document_work')
        for name in ('export_document_as_docx', 'export_document_as_xlsx'):
            self.assertEqual(ast.unparse(functions[name].decorator_list[0]),
                             "bounded_document_work(lane='document-export')")


if __name__ == '__main__':
    unittest.main()
