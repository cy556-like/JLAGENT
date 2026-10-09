"""Offline low-load/concurrent-write tests. No production/model API calls."""
import asyncio
import concurrent.futures
import contextvars
import inspect
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from test_resource_guard import guard, limits, source_function, invoke


class ParallelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = limits(self.temp.name)
        self.addCleanup(lambda: self.runtime.shutdown(wait=True))
        runtime_patch = patch.object(guard, 'get_runtime_limits', return_value=self.runtime)
        runtime_patch.start()
        self.addCleanup(runtime_patch.stop)
        self.stop = threading.Event()
        self.addCleanup(self.stop.set)

    async def wait_until(self, condition, timeout=3):
        async with asyncio.timeout(timeout):
            while not condition():
                await asyncio.sleep(0.005)

    async def test_ten_small_jobs_start_together_in_each_lane(self):
        for lane in ('document-work', 'document-read', 'document-export'):
            with self.subTest(lane=lane):
                started = []
                self.stop.clear()
                @guard.bounded_document_work(lane=lane)
                def work(index):
                    started.append(index)
                    self.stop.wait(5)
                    return index
                tasks = [asyncio.create_task(guard.document_thread(work, index)) for index in range(10)]
                try:
                    await self.wait_until(lambda: len(started) == 10)
                    self.assertFalse(any(task.done() for task in tasks))
                finally:
                    self.stop.set()
                    self.assertEqual(await asyncio.gather(*tasks), list(range(10)))

    async def test_ten_independent_file_requests_are_admitted_without_waiting(self):
        started, release = [], asyncio.Event()
        async def application(scope, receive, send):
            started.append(scope)
            await release.wait()
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await send({'type': 'http.response.body', 'body': b'OK'})
        app = guard.ResourceGuardMiddleware(application, self.runtime, lambda token: token)
        tasks = [asyncio.create_task(invoke(app, path='/api/v1/upload', user=str(i))) for i in range(10)]
        try:
            await self.wait_until(lambda: len(started) == 10)
        finally:
            release.set()
            responses = await asyncio.gather(*tasks)
        self.assertTrue(all(response[0]['status'] == 200 for response in responses))

    async def test_uncontended_work_does_not_enter_retry_sleep(self):
        @guard.bounded_document_work
        def work():
            return 42
        with patch.object(guard.asyncio, 'sleep', side_effect=AssertionError('unexpected delay')):
            self.assertEqual(await guard.document_thread(work), 42)

    async def test_waiters_use_no_executor_threads_and_default_chat_pool_remains_free(self):
        self.runtime.document_limit = 1
        started, second = threading.Event(), threading.Event()
        @guard.bounded_document_work
        def held():
            started.set()
            self.stop.wait(5)
        @guard.bounded_document_work
        def queued():
            second.set()
        loop = asyncio.get_running_loop()
        default = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(default)
        tasks = [asyncio.create_task(guard.document_thread(held))]
        try:
            await self.wait_until(started.is_set)
            tasks += [asyncio.create_task(guard.document_thread(queued)) for _ in range(10)]
            await self.wait_until(lambda: self.runtime._pending == 10)
            self.assertFalse(second.is_set())
            self.assertEqual(len(self.runtime._executors['document-work']._threads), 1)
            self.assertEqual(await asyncio.wait_for(asyncio.to_thread(lambda: 'chat-ready'), 1), 'chat-ready')
        finally:
            self.stop.set()
            await asyncio.gather(*tasks)
            default.shutdown(wait=True)

    async def test_saturated_document_pipeline_does_not_block_read_or_export(self):
        self.runtime.document_limit = 1
        started = threading.Event()
        @guard.bounded_document_work
        def held():
            started.set()
            self.stop.wait(5)
        task = asyncio.create_task(guard.document_thread(held))
        try:
            await self.wait_until(started.is_set)
            for lane in ('document-read', 'document-export'):
                work = guard.bounded_document_work(lambda: lane, lane=lane)
                self.assertEqual(await asyncio.wait_for(guard.document_thread(work), 1), lane)
        finally:
            self.stop.set()
            await task

    async def test_cancel_queued_job_never_runs_and_releases_pending_count(self):
        self.runtime.document_limit = 1
        started, unexpected = threading.Event(), threading.Event()
        work = guard.bounded_document_work(lambda: (started.set(), self.stop.wait(5)))
        task = asyncio.create_task(guard.document_thread(work))
        queued = None
        try:
            await self.wait_until(started.is_set)
            queued = asyncio.create_task(guard.document_thread(unexpected.set))
            await self.wait_until(lambda: self.runtime._pending == 1)
            queued.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await queued
            self.assertEqual(self.runtime._pending, 0)
        finally:
            self.stop.set()
            await task
        self.assertFalse(unexpected.is_set())
        self.assertEqual(await guard.document_thread(lambda: 42), 42)

    async def test_cancel_running_job_keeps_work_permit_until_real_thread_finishes(self):
        self.runtime.document_limit = 1
        started = threading.Event()
        work = guard.bounded_document_work(lambda: (started.set(), self.stop.wait(5)))
        task = asyncio.create_task(guard.document_thread(work))
        try:
            await self.wait_until(started.is_set)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNone(self.runtime.pool.try_acquire('document-work', 1))
        finally:
            self.stop.set()
            await self.wait_until(lambda: not self.runtime._executors['document-work']._work_queue.qsize())
            self.assertEqual(await asyncio.wait_for(guard.document_thread(lambda: 42), 2), 42)

    async def test_same_file_serializes_but_other_files_in_same_collection_run(self):
        observed = []
        @guard.bounded_document_work(requires=lambda args: [('collection', 'shared'),
                                                          ('source-' + args['name'], 'mutex')])
        def work(name):
            observed.append(name)
            if name == 'a':
                self.stop.wait(5)
        first = asyncio.create_task(guard.document_thread(work, 'a'))
        tasks = [first]
        try:
            await self.wait_until(lambda: observed == ['a'])
            tasks += [asyncio.create_task(guard.document_thread(work, 'a')),
                      asyncio.create_task(guard.document_thread(work, 'b'))]
            await self.wait_until(lambda: 'b' in observed)
            self.assertEqual(observed.count('a'), 1)
        finally:
            self.stop.set()
            await asyncio.gather(*tasks)
        self.assertEqual(observed.count('a'), 2)

    async def test_collection_maintenance_is_exclusive_but_other_collections_are_parallel(self):
        begun, forbidden = threading.Event(), threading.Event()
        @guard.bounded_document_work(requires=lambda args: [('collection-a', 'exclusive')])
        def maintenance():
            begun.set()
            self.stop.wait(5)
        @guard.bounded_document_work(requires=lambda args: [('collection-a', 'shared')])
        def upload():
            forbidden.set()
        first = asyncio.create_task(guard.document_thread(maintenance))
        second = None
        try:
            await self.wait_until(begun.is_set)
            second = asyncio.create_task(guard.document_thread(upload))
            await self.wait_until(lambda: self.runtime._pending == 1)
            other = guard.bounded_document_work(lambda: 'ready', requires=lambda args: [('collection-b', 'shared')])
            self.assertEqual(await asyncio.wait_for(guard.document_thread(other), 1), 'ready')
            self.assertFalse(forbidden.is_set())
        finally:
            self.stop.set()
            await asyncio.gather(first, *([second] if second else []))
        self.assertTrue(forbidden.is_set())

    async def test_pending_queue_overflow_is_explicit_and_does_not_leak(self):
        self.runtime.document_limit = self.runtime.pending_limit = 1
        begun = threading.Event()
        work = guard.bounded_document_work(lambda: (begun.set(), self.stop.wait(5)))
        first = asyncio.create_task(guard.document_thread(work))
        waiting = None
        try:
            await self.wait_until(begun.is_set)
            waiting = asyncio.create_task(guard.document_thread(lambda: 'waiting'))
            await self.wait_until(lambda: self.runtime._pending == 1)
            with self.assertRaisesRegex(RuntimeError, '队列已满'):
                await guard.document_thread(lambda: 'overflow')
        finally:
            self.stop.set()
            await asyncio.gather(first, *([waiting] if waiting else []))
        self.assertEqual(self.runtime._pending, 0)

    async def test_failed_old_upload_cannot_delete_newer_same_filename(self):
        filename = str(Path(self.temp.name) / 'same.txt')
        begun, newer = threading.Event(), threading.Event()
        def index(file_path, filename, agent_id=None):
            content = Path(file_path).read_bytes()
            if content == b'old':
                begun.set()
                self.stop.wait(5)
                raise ValueError('fake old embedding error')
            newer.set()
            self.assertEqual(content, b'new')
            return {'status': 'success'}
        scope = dict(os=os, get_runtime_limits=lambda: self.runtime,
                     document_path_resources=lambda path, kind='2-source', mode='mutex': [(guard.resource_key(kind, path), mode)],
                     index_document=index, load_document=lambda path: Path(path).read_bytes())
        scope['_save_uploaded_bytes'] = source_function('app/api/routes.py', '_save_uploaded_bytes', scope)
        process = source_function('app/api/routes.py', '_process_uploaded_bytes', scope)
        process = guard.bounded_document_work(process, requires=lambda args: [(guard.resource_key('source', args['file_path']), 'mutex')])
        old = asyncio.create_task(guard.document_thread(process, filename, b'old', 'same.txt', 'agent'))
        new = None
        try:
            await self.wait_until(begun.is_set)
            new = asyncio.create_task(guard.document_thread(process, filename, b'new', 'same.txt', 'agent'))
            await self.wait_until(lambda: self.runtime._pending == 1)
            self.assertFalse(newer.is_set())
        finally:
            self.stop.set()
            responses = await asyncio.gather(old, *([new] if new else []), return_exceptions=True)
        self.assertIsInstance(responses[0], ValueError)
        self.assertEqual(responses[1], {'status': 'success'})
        self.assertEqual(Path(filename).read_bytes(), b'new')


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = limits(self.temp.name)
        self.addCleanup(lambda: self.runtime.shutdown(wait=True))
        runtime_patch = patch.object(guard, 'get_runtime_limits', return_value=self.runtime)
        runtime_patch.start()
        self.addCleanup(runtime_patch.stop)

    def test_exclusive_parent_remains_exclusive_across_nested_shared_calls(self):
        with self.runtime.locked([('collection', 'exclusive')]):
            with self.runtime.locked([('collection', 'shared')]):
                self.assertEqual(dict(guard._held_resources.get())['collection'], 'exclusive')
                with self.runtime.locked([('collection', 'exclusive')]):
                    pass
        lease = self.runtime.pool.try_exclusive('collection')
        self.assertIsNotNone(lease)
        lease.release()

    def test_exclusive_probe_releases_partial_locks_and_rejects_upgrade(self):
        held = self.runtime.pool._slot('collection', 20)
        self.assertIsNone(self.runtime.pool.try_exclusive('collection'))
        lease = self.runtime.pool.try_acquire('collection', 1)
        self.assertIsNotNone(lease)
        lease.release()
        held.close()
        with self.runtime.locked([('collection', 'shared')]):
            with self.assertRaisesRegex(RuntimeError, 'upgrade'):
                with self.runtime.locked([('collection', 'exclusive')]):
                    pass

    def test_same_file_readers_share_disk_gate_and_only_writers_are_exclusive(self):
        scope = dict(os=os, resource_key=guard.resource_key)
        path_resources = source_function('app/rag/document.py', 'document_path_resources', scope)
        readers = path_resources(str(Path(self.temp.name) / 'same.txt'), '4-disk', 'shared')
        writer = path_resources(str(Path(self.temp.name) / 'same.txt'), '4-disk', 'exclusive')
        first = self.runtime.try_requirements(readers)
        second = self.runtime.try_requirements(readers)
        self.assertIsNotNone(second, 'same-file reads must remain parallel')
        try:
            self.assertIsNone(self.runtime.try_requirements(writer))
        finally:
            for lease in first + second:
                lease.release()
        writes = self.runtime.try_requirements(writer)
        self.assertIsNotNone(writes)
        try:
            self.assertIsNone(self.runtime.try_requirements(readers))
        finally:
            for lease in writes:
                lease.release()

    def test_background_job_does_not_inherit_parent_lock_ownership(self):
        queue = guard.BackgroundIndexQueue(workers=1)
        stop, ready, entered = threading.Event(), threading.Event(), threading.Event()
        account = contextvars.ContextVar('account', default=None)
        account.set('independent-user')
        observed = []
        def background():
            ready.set()
            with self.runtime.locked([('same-file', 'mutex')]):
                observed.append(account.get())
                entered.set()
        try:
            with self.runtime.locked([('same-file', 'mutex')]):
                queue.submit('key', background)
                self.assertTrue(ready.wait(2))
                self.assertFalse(entered.wait(0.1), 'background must acquire its own source lock')
            self.assertTrue(entered.wait(2))
            self.assertEqual(observed, ['independent-user'])
        finally:
            stop.set()
            queue.executor.shutdown(wait=True)

    def rag_scope(self):
        scope = dict(os=os, json=json, uuid=uuid, logger=logging.getLogger('test-transactions'),
                     settings=SimpleNamespace(DOCUMENTS_DIR=self.temp.name),
                     _get_collection_name=lambda aid: 'agent-' + str(aid),
                     get_runtime_limits=lambda: self.runtime, resource_key=guard.resource_key,
                     document_path_resources=lambda path, kind='2-source': [
                         (guard.resource_key(kind, os.path.normcase(os.path.abspath(path))), 'mutex')],
                     _get_keyword_index_path=lambda agent_id=None: str(Path(self.temp.name) / 'keyword.json'),
                     _keyword_bm25_cache={})
        return scope

    def test_concurrent_keyword_updates_keep_all_files_and_atomic_failures_keep_previous(self):
        scope = self.rag_scope()
        resource = source_function('app/rag/document.py', '_keyword_resources', scope)
        for name in ('_load_keyword_index', '_save_keyword_index', '_add_chunks_to_keyword_index'):
            scope[name] = guard.resource_locked(resource)(source_function('app/rag/document.py', name, scope))
        def add(i):
            scope['_add_chunks_to_keyword_index']([SimpleNamespace(page_content=str(i), metadata={'chunk_index': i})],
                                                  str(i) + '.txt', 'same-agent')
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            list(pool.map(add, range(30)))
        data = scope['_load_keyword_index']('same-agent')
        self.assertEqual({entry['source_file'] for entry in data}, {str(i) + '.txt' for i in range(30)})
        with patch.object(scope['os'], 'replace', side_effect=OSError('fake disk failure')):
            with self.assertRaises(OSError):
                scope['_save_keyword_index']([], 'same-agent')
        self.assertEqual(scope['_load_keyword_index']('same-agent'), data)
        self.assertFalse(list(Path(self.temp.name).glob('*.tmp')))

    def test_embedding_wait_is_outside_writer_lock_and_metadata_ids_are_preserved(self):
        scope = self.rag_scope()
        store_batch = source_function('app/rag/document.py', '_store_embedding_batch', scope)
        calls = []
        key = guard.resource_key('3-vector-write', 'agent-one')
        def embed(texts):
            lease = self.runtime.pool.try_acquire(key, 1)
            self.assertIsNotNone(lease, 'embedding must not hold the local writer lock')
            lease.release()
            calls.append(texts)
            return [[float(i)] for i in range(len(texts))]
        def upsert(**kwargs):
            self.assertIsNone(self.runtime.pool.try_acquire(key, 1))
            calls.append(kwargs)
        chunks = [SimpleNamespace(id='stable-id', page_content='one', metadata={'source_file': 'f', 'chunk_index': 0}),
                  SimpleNamespace(page_content='two', metadata={'source_file': 'f', 'chunk_index': 1})]
        vector_store = SimpleNamespace(_embedding_function=SimpleNamespace(embed_documents=embed),
                                       _collection=SimpleNamespace(upsert=upsert))
        store_batch(vector_store, chunks, 'one')
        self.assertEqual(calls[0], ['one', 'two'])
        self.assertEqual(calls[1]['ids'][0], 'stable-id')
        uuid.UUID(calls[1]['ids'][1])
        self.assertEqual(calls[1]['metadatas'], [chunk.metadata for chunk in chunks])
        self.assertEqual(calls[1]['embeddings'], [[0.0], [1.0]])
        self.assertEqual(len(calls), 2, 'one embed call, one local write, no retry')
        vector_store._embedding_function.embed_documents = lambda texts: []
        with self.assertRaisesRegex(ValueError, 'count'):
            store_batch(vector_store, chunks, 'one')
        self.assertEqual(len(calls), 2, 'invalid vectors must not write anything')

    def test_two_files_can_embed_together_but_writes_are_serial(self):
        store_batch = source_function('app/rag/document.py', '_store_embedding_batch', self.rag_scope())
        barrier = threading.Barrier(2)
        active, maximum, lock = 0, 0, threading.Lock()
        writes = []
        def embed(texts):
            barrier.wait(2)
            return [[1.0]]
        def upsert(**kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.02)
            writes.append(kwargs['documents'])
            with lock:
                active -= 1
        store = SimpleNamespace(_embedding_function=SimpleNamespace(embed_documents=embed),
                                _collection=SimpleNamespace(upsert=upsert))
        def write(name):
            store_batch(store, [SimpleNamespace(page_content=name, metadata={'source_file': name})], 'one')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(write, ['a', 'b']))
        self.assertEqual(maximum, 1)
        self.assertEqual(sorted(writes), [['a'], ['b']])

    def test_memory_pressure_reduces_only_new_capacity_not_existing_lease(self):
        self.assertEqual(self.runtime.capacity('document-work'), 10)
        self.runtime.memory_probe = lambda: 1280
        self.assertEqual(self.runtime.capacity('document-work'), 3)
        with self.runtime.document_work():
            self.runtime.memory_probe = lambda: 256
            self.assertEqual(self.runtime.capacity('document-work'), 0)
            self.assertIn('document-work', dict(guard._held_resources.get()))
        self.runtime.memory_probe = lambda: None
        self.assertEqual(self.runtime.capacity('document-work'), 10)

    def test_same_filename_in_existing_independent_agent_directories_does_not_share_source_lock(self):
        scope = self.rag_scope()
        source_function('app/rag/document.py', 'document_collection_resources', scope)
        resources = source_function('app/rag/document.py', 'document_mutation_resources', scope)
        for aid in ('a', 'b'):
            path = Path(self.temp.name) / ('agent_' + aid) / 'same.docx'
            path.parent.mkdir()
            path.touch()
        left = {key for key, mode in resources({'filename': 'same.docx', 'agent_id': 'a'})}
        right = {key for key, mode in resources({'filename': 'same.docx', 'agent_id': 'b'})}
        self.assertEqual(left & right, {'0-maintenance'})

    def test_cache_eviction_uses_a_snapshot_and_tolerates_concurrent_invalidation(self):
        oldest = source_function('app/rag/document.py', '_oldest_cache_key', {})
        cache = {'new': {'updated_at': 20}, 'old': {'updated_at': 10}}
        self.assertEqual(oldest(cache), 'old')
        self.assertIsNone(oldest({}))
        class ConcurrentCache(dict):
            def copy(self):
                snapshot = super().copy()
                self.clear()
                return snapshot
        self.assertEqual(oldest(ConcurrentCache(cache)), 'old')


class ToolTests(unittest.IsolatedAsyncioTestCase):
    setUp = ParallelTests.setUp
    async def test_tool_keeps_sync_async_behavior_signature_and_context(self):
        from functools import wraps
        from langchain_core.tools import tool
        scope = dict(tool=tool, wraps=wraps, bounded_document_work=guard.bounded_document_work,
                     document_thread=guard.document_thread)
        decorate = source_function('app/agent/tools.py', 'document_tool', scope)
        account = contextvars.ContextVar('tool-account', default=None)
        observed = []
        def original(content: str, filename: str = '', title: str = '') -> str:
            """Export a document without changing the existing arguments."""
            observed.append((account.get(), threading.current_thread().name))
            return content + ':' + filename + ':' + title
        baseline = tool(original)
        converted = decorate(original, lane='document-export')
        self.assertEqual(converted.name, baseline.name)
        self.assertEqual(converted.description, baseline.description)
        self.assertEqual(converted.args, baseline.args)
        self.assertEqual(inspect.signature(converted.func), inspect.signature(original))
        account.set('independent-user')
        self.assertEqual(converted.invoke({'content': 'sync', 'filename': 'f'}), 'sync:f:')
        self.assertEqual(await converted.ainvoke({'content': 'async', 'title': 't'}), 'async::t')
        self.assertTrue(all(item[0] == 'independent-user' for item in observed))
        self.assertTrue(observed[1][1].startswith('jl-document-export'))


if __name__ == '__main__':
    unittest.main()
