// Execute production selector/send functions with a minimal DOM and fake fetch.
// Run: node --test tests/frontend_model_selection.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const section = source.slice(source.indexOf('// ===== Model Management ====='), source.indexOf('// ===== Auth ====='));
const send = source.slice(source.indexOf('async function sendMessage()'), source.indexOf('function sendQuick('));
const retry = source.slice(source.indexOf('async function regenerateMessage('), source.indexOf('function showTyping('));

function harness() {
    const select = { options: [], disabled: false, value: 'auto', title: '',
        appendChild(option) { this.options.push(option); },
        set innerHTML(html) { this.options = html ? [{ value: 'auto', textContent: 'Auto' }] : []; },
        get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
    };
    const input = { value: 'hi' }, sendBtn = { disabled: false };
    const toasts = [], requests = [], streams = [];
    const context = vm.createContext({
        console: { error() {} },
        document: { getElementById(id) {
            return { modelSelect: select, msgInput: input, sendBtn,
                chatContent: { classList: { remove() {} } } }[id];
        }, createElement() { return {}; } },
        showToast(text) { toasts.push(text); },
        apiHeaders() { return { Authorization: 'Bearer ' + context.authToken }; },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ models: [{ id: 'auto', name: 'Auto' },
                { id: 'kimi-k3', name: 'Kimi' }], current: 'auto', effective: 'glm-5.2', success: true }) };
        },
        FormData: class {
            constructor() { this.values = new Map(); }
            append(name, value) { this.values.set(name, value); }
            get(name) { return this.values.get(name); }
        },
        currentUser: 'admin', authToken: 'admin-token', currentChatId: 'admin-session',
        selectedFile: null, selectedFileBase64: null, isLoading: false, selectedSkill: '',
        currentAgentId: null, myAgents: [], webSearchEnabled: false, currentMode: 'agent',
        deepThinkEnabled: false, lastMessageText: '',
        streamChat: async (url, options) => streams.push({ url, options }),
        addMessageToUI() {}, autoResize() {}, createStreamingBubble() { return {}; },
        async createNewChat() { context.currentChatId = 'created'; },
        removeFile() { context.selectedFile = null; }, async loadChatList() {}, scrollToBottom() {},
        resetStreamingUI() { context.isLoading = false; },
    });
    vm.runInContext(section + '\n' + send + '\n' + retry, context);
    return { context, select, input, toasts, requests, streams,
        current: () => vm.runInContext('currentModelId', context),
        setCurrent: value => vm.runInContext('currentModelId = ' + JSON.stringify(value), context),
        switching: () => vm.runInContext('modelSwitchInProgress', context) };
}

function pending() {
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    return { promise, finish: current => finish({ ok: true, json: async () => ({ current, success: true,
        models: [{ id: 'auto', name: 'Auto' }, { id: 'kimi-k3', name: 'Kimi' }], effective: 'glm-5.2' }) }) };
}

test('load selector uses authenticated account and saved choice', async () => {
    const h = harness();
    await h.context.loadModels();
    assert.equal(h.requests[0].options.headers.Authorization, 'Bearer admin-token');
    assert.equal(h.current(), 'auto');
    assert.equal(h.select.disabled, false);
});

test('switch commits selected id only after successful server response', async () => {
    const h = harness();
    await h.context.loadModels();
    const request = pending();
    h.context.fetch = async () => request.promise;
    h.select.value = 'kimi-k3';
    const switched = h.context.switchModel();
    assert.equal(h.current(), 'auto');
    assert.equal(h.select.disabled, true);
    request.finish('kimi-k3');
    await switched;
    assert.equal(h.current(), 'kimi-k3');
    assert.equal(h.switching(), false);
});

test('failed switch keeps previous committed choice', async () => {
    const h = harness();
    await h.context.loadModels();
    h.context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ success: false }) });
    h.select.value = 'kimi-k3';
    await h.context.switchModel();
    assert.equal(h.current(), 'auto');
    assert.equal(h.select.value, 'auto');
    assert.equal(h.select.disabled, false);
});

test('late previous-account selector response cannot overwrite new account', async () => {
    const h = harness(), old = pending(), fresh = pending();
    let counter = 0;
    h.context.fetch = async () => (++counter === 1 ? old.promise : fresh.promise);
    const first = h.context.loadModels();
    h.context.currentUser = 'quanzhiadmin'; h.context.authToken = 'quanzhi-token';
    const second = h.context.loadModels();
    fresh.finish('auto'); await second;
    old.finish('kimi-k3'); await first;
    assert.equal(h.current(), 'auto');
    assert.equal(h.select.disabled, false);
});

test('late same-account load is ignored after a more recent load', async () => {
    const h = harness(), old = pending(), fresh = pending();
    let counter = 0;
    h.context.fetch = async () => (++counter === 1 ? old.promise : fresh.promise);
    const first = h.context.loadModels(), second = h.context.loadModels();
    fresh.finish('kimi-k3'); await second;
    old.finish('auto'); await first;
    assert.equal(h.current(), 'kimi-k3');
});

test('late previous-account switch cannot change new-account selector or flags', async () => {
    const h = harness();
    await h.context.loadModels();
    const old = pending(), fresh = pending();
    let counter = 0;
    h.context.fetch = async () => (++counter === 1 ? old.promise : fresh.promise);
    h.select.value = 'kimi-k3';
    const first = h.context.switchModel();
    h.context.currentUser = 'quanzhiadmin'; h.context.authToken = 'quanzhi-token';
    const second = h.context.loadModels();
    fresh.finish('auto'); await second;
    old.finish('kimi-k3'); await first;
    assert.equal(h.current(), 'auto');
    assert.equal(h.switching(), false);
    assert.equal(h.select.disabled, false);
});

test('normal send includes selected model in JSON request', async () => {
    const h = harness();
    h.setCurrent('kimi-k3');
    await h.context.sendMessage();
    assert.equal(h.streams[0].url, '/api/v1/chat/stream');
    assert.equal(JSON.parse(h.streams[0].options.body).model_id, 'kimi-k3');
});

test('new account does not inherit previous choice while its preferences load', async () => {
    const h = harness();
    h.setCurrent('kimi-k3');
    h.context.currentUser = 'quanzhiadmin'; h.context.authToken = 'quanzhi-token';
    const request = pending();
    h.context.fetch = async () => request.promise;
    const loading = h.context.loadModels();
    assert.equal(h.current(), 'auto');
    assert.equal(h.select.value, 'auto');
    request.finish('auto'); await loading;
});

test('model selection is captured before asynchronous new-chat creation', async () => {
    const h = harness();
    h.setCurrent('kimi-k3');
    h.context.currentChatId = null;
    h.context.createNewChat = async () => { h.setCurrent('auto'); h.context.currentChatId = 'created'; };
    await h.context.sendMessage();
    assert.equal(JSON.parse(h.streams[0].options.body).model_id, 'kimi-k3');
});

test('both file send branches include selected model in multipart request', async () => {
    for (const message of ['hi', '']) {
        const h = harness();
        h.setCurrent('kimi-k3'); h.input.value = message;
        h.context.selectedFile = { name: 'report.pdf', type: 'application/pdf' };
        await h.context.sendMessage();
        assert.equal(h.streams[0].url, '/api/v1/chat-with-file/stream');
        assert.equal(h.streams[0].options.body.get('model_id'), 'kimi-k3');
    }
});

test('regenerate includes selected model in JSON request', async () => {
    const h = harness();
    h.setCurrent('kimi-k3');
    const btn = { closest: () => ({ previousElementSibling: { classList: { contains: () => true },
        querySelector: () => ({ textContent: 'hi' }) }, remove() {} }) };
    await h.context.regenerateMessage(btn);
    assert.equal(JSON.parse(h.streams[0].options.body).model_id, 'kimi-k3');
});

test('script version and service worker precache match updated assets', () => {
    const html = fs.readFileSync(path.join(root, 'app/static/index.html'), 'utf8');
    const worker = fs.readFileSync(path.join(root, 'app/static/sw.js'), 'utf8');
    const version = html.match(/app\.js\?v=([^"']+)/)[1];
    assert.ok(worker.includes('/static/js/app.js?v=' + version));
    assert.ok(html.includes('/static/sw.js?v=' + version));
    assert.ok(!worker.includes("STATIC_CACHE = 'jlagent-static-v1.1.0'"));
});
