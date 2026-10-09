'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.resolve(__dirname, '../mobile/android/assets/downloads.js'), 'utf8');
const ORIGIN = 'https://47.114.99.132:8003';

function harness(options = {}) {
    const events = new Map(), clicks = new Map(), messages = [], requests = [], notices = [], navigations = [];
    const bytes = options.bytes || Buffer.from('JLAGENT 文件下载');
    const blob = options.blob || new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    let inflight = 0, maxInflight = 0;
    const context = {
        location: {origin: options.origin || ORIGIN, href: ORIGIN + '/', assign: url => navigations.push(url)},
        document: {addEventListener: (name, fn) => clicks.set(name, fn)},
        window: {addEventListener: (name, fn) => events.set(name, fn), alert: value => notices.push(value)},
        authToken: 'test-token', accountSessionVersion: 1,
        localStorage: {getItem: () => 'test-token'},
        showToast: value => notices.push(value),
        URL, Blob, Promise, setTimeout, clearTimeout, Date, Math,
        HTMLAnchorElement: class { click() { this.originalClicked = true; } },
        FileReader: class {
            readAsDataURL(value) {
                value.arrayBuffer().then(buffer => {
                    this.result = 'data:application/octet-stream;base64,' + Buffer.from(buffer).toString('base64');
                    this.onload();
                }, error => this.onerror(error));
            }
        },
        fetch: (url, init) => {
            requests.push({url, init});
            if (options.onFetch) options.onFetch(url, init);
            return Promise.resolve({ok: true, headers: {get: () => options.disposition || ''}, blob: async () => blob});
        },
    };
    const port = {
        close() {}, start() {},
        postMessage(text) {
            const item = JSON.parse(text);
            messages.push(item);
            if (item.action === 'cancel') return;
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            if (options.onSend) options.onSend(item, context);
            queueMicrotask(() => {
                inflight--;
                port.onmessage({data: JSON.stringify({id: item.id, ok: true})});
            });
        },
    };
    vm.runInNewContext(script, context);
    if (events.has('message')) events.get('message')({data: 'JLAGENT_NATIVE_DOWNLOADS', ports: [port]});
    return {context, messages, requests, notices, navigations, clicks, bytes,
        download: (...args) => context.window.__jlNativeDownloads.download(...args),
        maxInflight: () => maxInflight};
}

test('binary transfer is chunked with ACK backpressure and preserves every byte', async () => {
    const bytes = Buffer.alloc(150000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const h = harness({bytes});
    await h.download('blob:' + ORIGIN + '/sample', '质量手册.docx', '');
    assert.deepEqual(h.notices, []);
    assert.equal(h.messages[0].action, 'begin');
    assert.equal(h.messages[0].name, '质量手册.docx');
    assert.equal(h.messages[0].size, bytes.length);
    const chunks = h.messages.filter(item => item.action === 'chunk').map(item => Buffer.from(item.data, 'base64'));
    assert(chunks.length > 1);
    assert(chunks.every(chunk => chunk.length <= 49152));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(h.messages.at(-1).action, 'end');
    assert.equal(h.maxInflight(), 1);
    assert(!('Authorization' in h.requests[0].init.headers));
});
test('document API fetch uses current account only and rejects redirects', async () => {
    const h = harness({disposition: "attachment; filename*=UTF-8''%E6%89%8B%E5%86%8C.docx"});
    await h.download('/api/v1/documents/manual.docx/download?agent_id=123', '', '');
    assert.equal(h.requests[0].init.headers.Authorization, 'Bearer test-token');
    assert.equal(h.requests[0].init.credentials, 'same-origin');
    assert.equal(h.requests[0].init.redirect, 'error');
    assert.equal(h.messages[0].name, '手册.docx');
});
test('Blob fetch starts inside captured click before the site revokes its URL', async () => {
    let revoked = false;
    const h = harness({onFetch: () => assert.equal(revoked, false)});
    let prevented = false, stopped = false;
    h.clicks.get('click')({target: {closest: () => ({href: 'blob:' + ORIGIN + '/revoked', download: 'test.docx'})},
        preventDefault: () => {prevented = true;}, stopImmediatePropagation: () => {stopped = true;}});
    revoked = true;
    assert.equal(h.requests.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert(prevented && stopped);
    assert.equal(h.messages.at(-1).action, 'end');
});
test('exportChat detached anchor starts Blob fetch before immediate revocation', async () => {
    let revoked = false;
    const h = harness({onFetch: () => assert.equal(revoked, false)});
    const anchor = new h.context.HTMLAnchorElement();
    anchor.href = 'blob:' + ORIGIN + '/detached';
    anchor.download = '对话记录.docx';
    anchor.click();
    revoked = true;
    assert.equal(h.requests.length, 1);
    assert(!anchor.originalClicked);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages[0].name, '对话记录.docx');
    assert.equal(h.messages.at(-1).action, 'end');
    const ordinary = new h.context.HTMLAnchorElement();
    ordinary.href = 'https://example.com/';
    ordinary.click();
    assert(ordinary.originalClicked);
});
test('account switch during transfer cancels without finalizing the file', async () => {
    const h = harness({bytes: Buffer.alloc(100000), onSend: (item, context) => {
        if (item.action === 'chunk') { context.authToken = 'other-account'; context.accountSessionVersion++; }
    }});
    await h.download('blob:' + ORIGIN + '/switch', 'test.docx', '');
    assert.equal(h.messages.filter(item => item.action === 'chunk').length, 1);
    assert.equal(h.messages.at(-1).action, 'cancel');
    assert(!h.messages.some(item => item.action === 'end'));
    assert(h.notices.some(value => value.includes('账户已切换')));
});
test('untrusted URLs receive neither credentials nor native file access', async () => {
    for (const value of ['https://evil.example/api/v1/documents/test', 'blob:https://evil.example/123',
        'http://47.114.99.132:8003/api/v1/documents/test', 'file:///sdcard/test', ORIGIN + '/api/v1/auth/login']) {
        const h = harness();
        await h.download(value, 'test', '');
        assert.equal(h.requests.length, 0);
        assert.equal(h.messages.length, 0);
        assert.equal(h.notices.length, 1);
    }
});
test('native script does not install on another origin', () => {
    const h = harness({origin: 'https://evil.example'});
    assert.equal(h.context.window.__jlNativeDownloads, undefined);
    assert.equal(h.clicks.size, 0);
});
test('window.open downloads inside app; other HTTPS pages navigate in place', async () => {
    const h = harness();
    assert.equal(h.context.window.open('/api/v1/documents/export-download/report.pdf', '_blank'), null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages.at(-1).action, 'end');
    h.context.window.open('https://example.com/help', '_blank');
    h.context.window.open('intent://browser', '_blank');
    assert.deepEqual(h.navigations, ['https://example.com/help']);
});
test('one transfer at a time; repeated tap does not start another request', async () => {
    const h = harness();
    const first = h.download('blob:' + ORIGIN + '/one', 'test.docx', '');
    await h.download('blob:' + ORIGIN + '/two', 'test.docx', '');
    await first;
    assert.equal(h.requests.length, 1);
    assert.equal(h.messages.filter(item => item.action === 'begin').length, 1);
    assert(h.notices.some(value => value.includes('稍候')));
});
test('zero-byte files finish normally; oversized files never start native transfer', async () => {
    const empty = harness({bytes: Buffer.alloc(0)});
    await empty.download('blob:' + ORIGIN + '/empty', 'test.txt', '');
    assert.deepEqual(empty.messages.map(item => item.action), ['begin', 'end']);
    const large = harness({blob: {size: 50 * 1024 * 1024 + 1}});
    await large.download('blob:' + ORIGIN + '/large', 'test.docx', '');
    assert.equal(large.messages.length, 0);
    assert(large.notices.some(value => value.includes('50MB')));
});
