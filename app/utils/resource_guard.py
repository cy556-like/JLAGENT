"""Small cross-worker resource budgets; no model timeout or automatic retry changes."""
import asyncio
import contextvars
import errno
import functools
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager


def _positive_env(name, default):
    try:
        value = int(os.getenv(name, str(default)))
        return value if value > 0 else default
    except (ValueError, TypeError):
        return default


SSE_BUFFER_EVENTS = _positive_env('JLAGENT_SSE_BUFFER_EVENTS', 64)
_request_work = contextvars.ContextVar('jlagent_request_document_work', default=None)


async def document_thread(function, *args, **kwargs):
    """Keep an admitted file request reserved until its real thread has finished.

    Canceling an HTTP await cannot stop Python's running worker thread. Shielding
    and tracking the task prevents repeated disconnects from overbooking it.
    """
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    work = _request_work.get()
    if work is not None:
        work.add(task)
    def finished(done):
        if work is not None:
            work.discard(done)
        if not done.cancelled():
            done.exception()  # Also retrieve an exception after the HTTP client left.
    task.add_done_callback(finished)
    return await asyncio.shield(task)


def _release_after_work(leases, work):
    pending = {task for task in work if not task.done()}
    def finished(task=None):
        pending.discard(task)
        if not pending:
            for lease in reversed(leases):
                lease.release()
    for task in pending:
        task.add_done_callback(finished)
    if not pending:
        finished()


def available_memory_mb():
    try:
        import psutil
        return psutil.virtual_memory().available // (1024 * 1024)
    except ImportError:
        pass
    except Exception:
        return None
    try:
        if os.name == 'nt':
            import ctypes
            class MemoryStatus(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
                    (name, ctypes.c_ulonglong) for name in ('total', 'available', 'page_total', 'page_available',
                                                           'virtual_total', 'virtual_available', 'extended')]
            status = MemoryStatus()
            status.length = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return status.available // (1024 * 1024)
        else:
            return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') // (1024 * 1024)
    except Exception:
        pass
    return None


class Lease:
    def __init__(self, handles):
        self.handles = handles
        self._lock = threading.Lock()

    def release(self):
        with self._lock:
            handles, self.handles = self.handles, []
        # Closing a descriptor releases its OS lock, including after a worker crash.
        for handle in handles:
            handle.close()


class SlotPool:
    """OS file locks share capacity across uvicorn workers on Windows and Linux.

    Lock files must not be deleted while the service runs. They contain no user data.
    No PID guessing, stale job snapshots, heartbeat expiry, or database polling.
    """
    def __init__(self, directory):
        self.directory = Path(directory)

    def _slot(self, name, index):
        self.directory.mkdir(parents=True, exist_ok=True)
        handle = (self.directory / (name + '-' + str(index) + '.lock')).open('a+b', buffering=0)
        try:
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b'\0')
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError as exc:
            handle.close()
            if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                return None
            raise
        except BaseException:
            handle.close()
            raise

    def try_acquire(self, name, capacity):
        for index in range(capacity):
            handle = self._slot(name, index)
            if handle is not None:
                return Lease([handle])
        return None


class RuntimeLimits:
    def __init__(self, directory, memory_probe=available_memory_mb):
        self.pool = SlotPool(Path(directory) / 'runtime_resource_locks')
        self.chat_limit = _positive_env('JLAGENT_CHAT_CONCURRENCY', 20)
        self.user_chat_limit = _positive_env('JLAGENT_USER_CHAT_CONCURRENCY', 2)
        self.file_limit = _positive_env('JLAGENT_FILE_CONCURRENCY', 2)
        self.document_limit = _positive_env('JLAGENT_DOCUMENT_CONCURRENCY', 1)
        self.read_limit = _positive_env('JLAGENT_DOCUMENT_READ_CONCURRENCY', 2)
        self.export_limit = _positive_env('JLAGENT_EXPORT_CONCURRENCY', 1)
        self.min_free_mb = _positive_env('JLAGENT_MIN_FREE_MEMORY_MB', 512)
        self.memory_probe = memory_probe
        self._thread = threading.local()

    def snapshot(self):
        return {'shared_across_workers': True, 'chat_limit': self.chat_limit,
                'per_account_chat_limit': self.user_chat_limit, 'file_request_limit': self.file_limit,
                'document_work_limit': self.document_limit, 'minimum_free_memory_mb': self.min_free_mb,
                'document_read_limit': self.read_limit,
                'document_export_limit': self.export_limit,
                'available_memory_mb': self.memory_probe(), 'sse_buffer_events': SSE_BUFFER_EVENTS}

    @contextmanager
    def document_work(self, lane='document-work'):
        # index -> load_document and rebuild -> index are nested in the same thread.
        depths = getattr(self._thread, 'depths', None)
        if depths is None:
            depths = self._thread.depths = {}
        if depths.get(lane, 0):
            depths[lane] += 1
            try:
                yield
            finally:
                depths[lane] -= 1
            return
        capacity = {'document-read': self.read_limit, 'document-export': self.export_limit}.get(lane, self.document_limit)
        lease = self.pool.try_acquire(lane, capacity)
        while lease is None:
            # This wait occurs only in a worker thread, never on the ASGI event loop.
            time.sleep(0.05)
            lease = self.pool.try_acquire(lane, capacity)
        depths[lane] = 1
        try:
            yield
        finally:
            depths[lane] = 0
            lease.release()


_runtime = None
_runtime_lock = threading.Lock()


def get_runtime_limits():
    global _runtime
    if _runtime is None:
        with _runtime_lock:
            if _runtime is None:
                from app.config import settings
                _runtime = RuntimeLimits(settings.DATA_DIR)
    return _runtime


def bounded_document_work(function=None, *, lane='document-work'):
    if function is None:
        return lambda function: bounded_document_work(function, lane=lane)
    @functools.wraps(function)
    def run(*args, **kwargs):
        with get_runtime_limits().document_work(lane):
            return function(*args, **kwargs)
    return run


class BackgroundIndexQueue:
    """Fixed workers, bounded pending jobs; repeated updates to one file coalesce."""
    def __init__(self, workers=1, max_pending=32):
        self.executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='jlagent-index')
        self.max_pending = max_pending
        self._lock = threading.Lock()
        self._pending = {}

    def submit(self, key, function, *args):
        context = contextvars.copy_context()
        with self._lock:
            if key in self._pending:
                self._pending[key] = (function, args, context)
                return True
            if len(self._pending) >= self.max_pending:
                return False
            self._pending[key] = None
            try:
                self.executor.submit(self._run, key, function, args, context)
            except BaseException:
                self._pending.pop(key, None)
                raise
        return True

    def _run(self, key, function, args, context):
        try:
            while True:
                context.run(function, *args)
                with self._lock:
                    latest = self._pending[key]
                    if latest is None:
                        del self._pending[key]
                        return
                    function, args, context = latest
                    self._pending[key] = None
        except BaseException:
            with self._lock:
                self._pending.pop(key, None)
            raise


background_indexes = BackgroundIndexQueue()


class ResourceGuardMiddleware:
    CHAT_PATHS = {'/api/v1/chat', '/api/v1/chat/stream', '/api/v1/chat-with-file/stream'}
    FILE_PATHS = {'/api/v1/upload', '/api/v1/chat-with-file/stream', '/api/v1/reindex',
                  '/api/v1/documents/export', '/api/v1/documents/export-xlsx', '/api/v1/migrate/cleanup-collections'}

    def __init__(self, app, limits, user_resolver):
        self.app, self.limits, self.user_resolver = app, limits, user_resolver

    async def _reject(self, send, message, status=503):
        body = json.dumps({'detail': message}, ensure_ascii=False).encode('utf-8')
        await send({'type': 'http.response.start', 'status': status, 'headers': [
            (b'content-type', b'application/json; charset=utf-8'), (b'content-length', str(len(body)).encode()),
            (b'retry-after', b'3'), (b'cache-control', b'no-store')]})
        await send({'type': 'http.response.body', 'body': body})

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path, method = scope['path'], scope['method']
        chat = method == 'POST' and path in self.CHAT_PATHS
        files = (method == 'POST' and path in self.FILE_PATHS or
                 method == 'GET' and path == '/api/v1/migrate/cleanup-collections' or
                 method in ('PUT', 'DELETE') and (path.startswith('/api/v1/documents/') or path.endswith('/knowledge')))
        if not chat and not files:
            return await self.app(scope, receive, send)
        free = self.limits.memory_probe()
        if free is not None and free < self.limits.min_free_mb:
            return await self._reject(send, '服务器内存紧张，请稍后重试；已开始的任务不会因此被停止')
        headers = dict(scope.get('headers', []))
        authorization = headers.get(b'authorization', b'').decode('latin-1')
        username = self.user_resolver(authorization[7:]) if authorization.startswith('Bearer ') else None
        identity = username or 'anonymous:' + str((scope.get('client') or ('unknown',))[0])
        user_key = hashlib.sha256(identity.encode('utf-8')).hexdigest()
        leases = []
        file_leases = []
        work = set()
        work_token = _request_work.set(work)
        async def guarded_send(event):
            # File-chat has already finished parsing/indexing before streaming starts.
            # Do not hold upload capacity for its entire model conversation.
            if path == '/api/v1/chat-with-file/stream' and event['type'] == 'http.response.start':
                for lease in file_leases:
                    lease.release()
            await send(event)
        try:
            demands = []
            if chat:
                demands.extend([('user-chat-' + user_key, self.limits.user_chat_limit, '当前账号已有对话在处理中，请稍后再发送', 429),
                                ('chat', self.limits.chat_limit, '服务器对话繁忙，请稍后重试', 503)])
            if files:
                demands.extend([('user-file-' + user_key, 1, '当前账号已有文件正在处理，请稍后重试', 429),
                                ('file', self.limits.file_limit, '服务器文件处理繁忙，请稍后重试；普通聊天仍可使用', 503)])
            for name, capacity, message, status in demands:
                lease = self.limits.pool.try_acquire(name, capacity)
                if lease is None:
                    return await self._reject(send, message, status)
                leases.append(lease)
                if name == 'file' or name.startswith('user-file-'):
                    file_leases.append(lease)
            # Hold budgets until the entire streaming response finishes, not only its headers.
            return await self.app(scope, receive, guarded_send)
        finally:
            _request_work.reset(work_token)
            _release_after_work(leases, work)
