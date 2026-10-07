"""Account-scoped model choices, shared by workers; not credentials or backups."""
import hashlib
import errno
import json
import logging
import os
from pathlib import Path
import tempfile
import time
from app.config import settings, AVAILABLE_MODELS, MODEL_ID_ALIASES

logger = logging.getLogger(__name__)


def validate_model_id(model_id):
    if isinstance(model_id, str):
        model_id = MODEL_ID_ALIASES.get(model_id, model_id)
    if not isinstance(model_id, str) or model_id not in {item['id'] for item in AVAILABLE_MODELS}:
        raise ValueError('不支持的模型选择')
    return model_id


def _path(username):
    if not isinstance(username, str) or not username:
        raise ValueError('缺少已认证的账号')
    return Path(settings.DATA_DIR) / 'model_preferences' / (hashlib.sha256(username.encode()).hexdigest() + '.json')


def _retry_busy_file(operation):
    # Windows can briefly deny atomic replacement while another worker reads
    # or replaces this file. Only retry that OS error, not disk/permission faults
    # on other platforms. No delay on the normal path; at most 70ms contention.
    for attempt in range(8):
        try:
            return operation()
        except PermissionError as error:
            busy = getattr(error, 'winerror', None) in (5, 32, 33) or error.errno == errno.EACCES
            if os.name != 'nt' or not busy or attempt == 7:
                raise
            time.sleep(0.01)


def load_user_model(username):
    path = _path(username)
    try:
        return validate_model_id(json.loads(_retry_busy_file(lambda: path.read_text(encoding='utf-8')))['model_id'])
    except FileNotFoundError:
        return settings.LLM_MODEL
    except (ValueError, KeyError, TypeError):
        logger.warning('Invalid stored model preference; using configured default')
        return settings.LLM_MODEL


def save_user_model(username, model_id):
    selected = validate_model_id(model_id)
    path = _path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.model-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump({'model_id': selected}, output)
            output.flush()
            os.fsync(output.fileno())
        _retry_busy_file(lambda: os.replace(temporary, path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return selected
