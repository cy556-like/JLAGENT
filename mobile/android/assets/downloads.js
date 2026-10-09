/* Loaded by the APK only; does not alter the website's normal browser downloads. */
(function () {
    'use strict';
    const ORIGIN = 'https://47.114.99.132:8003';
    if (location.origin !== ORIGIN || window.__jlNativeDownloads) return;
    const CHUNK_SIZE = 49152, MAX_SIZE = 50 * 1024 * 1024;
    let port = null, waiting = null, busy = false, expectedNonce = null, channelVersion = 0;
    window.addEventListener('message', function (event) {
        // A cross-origin iframe must not replace the native port and intercept file bytes.
        if (!expectedNonce || event.data !== 'JLAGENT_NATIVE_DOWNLOADS:' + expectedNonce ||
            event.ports.length !== 1 || port) return;
        port = event.ports[0];
        port.onmessage = function (message) {
            let response;
            try { response = JSON.parse(message.data); } catch (_) { return; }
            if (!waiting || response.id !== waiting.id) return;
            const current = waiting;
            waiting = null;
            clearTimeout(current.timer);
            if (response.ok) current.resolve(); else current.reject(new Error(response.error || '下载失败'));
        };
        port.start();
    });

    function notify(message) {
        if (typeof showToast === 'function') showToast(message); else window.alert(message);
    }
    function account() {
        return {token: typeof authToken !== 'undefined' ? authToken : localStorage.getItem('authToken'),
            version: typeof accountSessionVersion !== 'undefined' ? accountSessionVersion : null, channel: channelVersion};
    }
    function assertAccount(initial) {
        const current = account();
        if (initial.token !== current.token || initial.version !== current.version) throw new Error('账户已切换，下载已取消');
        if (initial.channel !== channelVersion) throw new Error('页面已切换，下载已取消');
    }
    function send(id, action, payload) {
        return new Promise(function (resolve, reject) {
            const timer = setTimeout(function () { waiting = null; reject(new Error('文件传输超时，请重试')); }, 30000);
            waiting = {id: id, resolve: resolve, reject: reject, timer: timer};
            try { port.postMessage(JSON.stringify(Object.assign({id: id, action: action}, payload))); }
            catch (error) { waiting = null; clearTimeout(timer); reject(error); }
        });
    }
    function base64(blob) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(reader.result.split(',')[1]); };
            reader.onerror = function () { reject(new Error('无法读取下载文件')); };
            reader.readAsDataURL(blob);
        });
    }
    function allowed(value) {
        const url = new URL(value, location.href);
        if (url.protocol === 'blob:' && url.origin === ORIGIN) return url;
        if (url.origin === ORIGIN && /^\/api\/v1\/documents\//.test(url.pathname)) return url;
        throw new Error('只允许下载当前 JLAGENT 的文件');
    }
    function isDownload(value) {
        try { allowed(value); return true; } catch (_) { return false; }
    }
    function filename(response, url, suggested) {
        if (suggested) return suggested;
        const header = response.headers.get('Content-Disposition') || '';
        const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
        if (encoded) try { return decodeURIComponent(encoded[1]); } catch (_) { }
        const plain = header.match(/filename="([^"]+)"|filename=([^;]+)/i);
        if (plain) return (plain[1] || plain[2]).trim();
        const pieces = url.pathname.split('/').filter(Boolean);
        const name = pieces[pieces.length - 1] === 'download' ? pieces[pieces.length - 2] : pieces[pieces.length - 1];
        try { return decodeURIComponent(name || 'JLAGENT-文件'); } catch (_) { return 'JLAGENT-文件'; }
    }

    async function download(value, suggested, mime) {
        if (busy) { notify('正在准备下载，请稍候'); return; }
        busy = true;
        const initial = account(), id = 'jl_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        let begun = false;
        try {
            const url = allowed(value);
            const headers = {};
            if (url.protocol !== 'blob:' && initial.token) headers.Authorization = 'Bearer ' + initial.token;
            // Start fetch before yielding: the site's click handler immediately revokes blob URLs.
            const response = await fetch(url.href, {headers: headers, credentials: 'same-origin', redirect: 'error'});
            if (!response.ok) throw new Error('文件下载失败，请重新登录或重试');
            const blob = await response.blob();
            if (blob.size > MAX_SIZE) throw new Error('文件超过 50MB 限制');
            assertAccount(initial);
            if (!port) throw new Error('下载通道尚未就绪，请重试');
            await send(id, 'begin', {name: filename(response, url, suggested),
                mime: mime || blob.type || 'application/octet-stream', size: blob.size});
            begun = true;
            for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
                assertAccount(initial);
                const bytes = await base64(blob.slice(offset, offset + CHUNK_SIZE));
                assertAccount(initial);
                await send(id, 'chunk', {data: bytes});
            }
            assertAccount(initial);
            await send(id, 'end', {});
        } catch (error) {
            if (begun && port) try { port.postMessage(JSON.stringify({id: id, action: 'cancel'})); } catch (_) { }
            notify(error.message || '文件下载失败，请重试');
        } finally { busy = false; }
    }

    document.addEventListener('click', function (event) {
        const target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!target || !isDownload(target.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        download(target.href, target.download, '');
    }, true);
    // exportChat clicks a detached <a>. It never reaches document's click listener.
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (isDownload(this.href)) download(this.href, this.download, '');
        else anchorClick.call(this);
    };
    window.open = function (value) {
        if (isDownload(value)) download(value, '', '');
        else {
            try {
                const url = new URL(value, location.href);
                if (url.protocol === 'https:') location.assign(url.href);
            } catch (_) { }
        }
        return null;
    };
    window.__jlNativeDownloads = {download: download, bindNonce: function (nonce) {
        channelVersion++;
        expectedNonce = nonce;
        if (port) port.close();
        port = null;
        if (waiting) {
            const previous = waiting;
            waiting = null;
            clearTimeout(previous.timer);
            previous.reject(new Error('页面已切换，下载已取消'));
        }
    }};
})();
