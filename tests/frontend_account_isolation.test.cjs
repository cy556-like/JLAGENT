'use strict';
// Execute the complete production script. Mock only browser/network services
// and presentation helpers, not authentication, cache or async state guards.
// Run: node --test tests/frontend_account_isolation.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app/static/js/app.js'), 'utf8');

function pending() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function response(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function ownChat(username, suffix = 'one', agent = null) {
    return { chat_id: `${username}_${suffix}`, mode: agent ? 'agent' : 'chat', agent_id: agent };
}

function harness(initialStorage = []) {
    const storage = new Map(initialStorage), nodes = new Map(), rendered = [], lists = [], toasts = [], requests = [];
    const timers = new Map(), windowEvents = new Map(), fileReaders = [];
    let timerId = 0;
    function node() {
        const classes = new Set();
        let html = '';
        return { style: { display: 'none' }, value: '', textContent: '', disabled: false, title: '', children: [], options: [],
            classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
                toggle(x, on) { const enabled = on === undefined ? !classes.has(x) : on; enabled ? classes.add(x) : classes.delete(x); } },
            get innerHTML() { return html; }, set innerHTML(value) { html = value; this.children = []; },
            appendChild(value) { this.children.push(value); this.options.push(value); },
            insertBefore(value) { this.children.unshift(value); },
            addEventListener() {}, setAttribute() {}, getAttribute() {}, querySelector: () => null,
            querySelectorAll: () => [], closest: () => null, focus() {}, remove() {},
            scrollHeight: 100, scrollTop: 0,
        };
    }
    function dom(id) {
        if (!nodes.has(id)) nodes.set(id, node());
        return nodes.get(id);
    }
    const state = vm.createContext({
        console: { log() {}, warn() {}, error() {} }, AbortController, TextDecoder, URL, URLSearchParams,
        navigator: { userAgent: 'test desktop' },
        localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null,
            setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        document: { getElementById: dom, createElement: node, createTextNode: text => ({ textContent: text }),
            createDocumentFragment: node, documentElement: node(), body: node(), addEventListener() {}, querySelectorAll: () => [] },
        window: { innerWidth: 1200, addEventListener: (name, fn) => windowEvents.set(name, fn) },
        history: { state: { page: 'login' }, pushState(value) { this.state = value; }, replaceState(value) { this.state = value; } },
        confirm: () => true, alert() {},
        setTimeout(fn) { const id = ++timerId; timers.set(id, { fn, repeat: false }); return id; },
        clearTimeout: id => timers.delete(id),
        setInterval(fn) { const id = ++timerId; timers.set(id, { fn, repeat: true }); return id; },
        clearInterval: id => timers.delete(id),
        FormData: class { constructor() { this.values = new Map(); } append(key, value) { this.values.set(key, value); } },
        FileReader: class { constructor() { fileReaders.push(this); } readAsDataURL() {} },
    });
    state.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url.includes('/models')) return response({ models: [{ id: 'auto', name: 'Auto' }], current: 'auto' });
        if (url.includes('/agents')) return response({ success: true, agents: [] });
        if (url.includes('/history/')) return response({ messages: [] });
        if (url.includes('/chats')) return response({ success: true, chats: [] });
        throw new Error('Unmocked request: ' + url);
    };
    vm.runInContext(source, state);
    const read = expression => JSON.parse(vm.runInContext('JSON.stringify(' + expression + ')', state));
    const set = values => Object.entries(values).forEach(([key, value]) => vm.runInContext(`${key} = ${JSON.stringify(value)}`, state));
    state.showToast = text => toasts.push(text);
    state.autoResize = () => {};
    state.updateCenteredMode = () => {};
    state.updateWelcomeContent = () => {};
    state.updateKbUploadVisibility = () => {};
    state.updateHeaderKbVisibility = () => {};
    state.renderMyAgents = () => {};
    state.scrollToBottom = () => {};
    state.smartScrollToBottom = () => {};
    state.cleanupExcessMessages = () => {};
    state.renderChatList = () => lists.push({ account: read('currentUser'), ids: read('allChats.map(c => c.chat_id)') });
    state.addMessageToUI = (role, content) => rendered.push({ account: read('currentUser'), role, content });
    state.renderBubbleMarkdown = (bubble, text) => { bubble.innerHTML = text; };
    state.createStreamingBubble = node;
    const login = (username, suffix = 'one') => {
        state.activateAccount(username, username + '-token', 'admin');
        const chat = ownChat(username, suffix);
        set({ currentMode: 'chat', currentChatId: chat.chat_id, currentAgentId: null, allChats: [chat] });
        return chat;
    };
    return { state, storage, nodes, dom, node, rendered, lists, toasts, requests, timers, windowEvents, fileReaders, read, set, login,
        async flushTimeouts() {
            const once = [...timers].filter(([, task]) => !task.repeat);
            for (const [id, task] of once) { timers.delete(id); await task.fn(); }
        } };
}

test('legacy ownerless caches are not inherited; account caches restore independently', () => {
    const h = harness([['forgeAgents', JSON.stringify([{ id: 'agent_private', chat_ids: ['admin_old'] }])],
        ['agentActiveChatIds', JSON.stringify({ 'dfmea-risk-agent': 'admin_old' })]]);
    assert(!h.read('myAgents').some(agent => agent.id === 'agent_private'));
    h.login('admin');
    h.set({ agentActiveChatId: { 'dfmea-risk-agent': 'admin_one' } });
    h.state.saveAgentActiveChatIds();
    h.state.writeAccountCache('forgeAgents', h.read('myAgents'));
    h.login('adminquanzhi');
    assert.equal(h.read("agentActiveChatId['dfmea-risk-agent']"), null);
    h.set({ agentActiveChatId: { 'dfmea-risk-agent': 'adminquanzhi_one' } });
    h.state.saveAgentActiveChatIds();
    h.login('admin');
    assert.equal(h.read("agentActiveChatId['dfmea-risk-agent']"), 'admin_one');
    assert.equal(JSON.parse(h.storage.get('jlagent:adminquanzhi:agentActiveChatIds'))['dfmea-risk-agent'], 'adminquanzhi_one');
    assert(!h.storage.has('forgeAgents') && !h.storage.has('agentActiveChatIds'));
});

test('cache keys encode usernames without prefix or separator collisions', () => {
    const h = harness();
    const keys = ['admin', 'adminquanzhi', 'a:b', 'a%3Ab', 'a/b'].map(username => {
        h.login(username); return h.state.accountCacheKey('forgeAgents');
    });
    assert.equal(new Set(keys).size, keys.length);
});

test('logout clears runtime, sidebar, draft/file/rename state and aborts the old stream', () => {
    const h = harness(); h.login('admin');
    const controller = new AbortController(); h.state.oldController = controller;
    vm.runInContext('currentAbortController = oldController', h.state);
    h.set({ selectedFile: { name: 'old-private.docx' }, selectedFileBase64: 'private', isLoading: true,
        modeChatId: { agent: 'admin_one', chat: 'admin_one' }, agentActiveChatId: { a: 'admin_one' },
        renamingChatId: 'admin_one', lastMessageText: 'old-private-question', _syncAgentsLock: true, _lastSyncedAgentsHash: 'old' });
    h.dom('msgInput').value = 'old-private-draft';
    h.dom('chatList').innerHTML = 'old-list';
    h.dom('chatMessages').innerHTML = 'old-messages';
    h.state.doLogout();
    assert(controller.signal.aborted);
    for (const name of ['currentUser', 'authToken', 'currentChatId', 'selectedFile', 'selectedFileBase64', 'renamingChatId']) assert.equal(h.read(name), null);
    assert.deepEqual(h.read('allChats'), []);
    assert.deepEqual(h.read('modeChatId'), { agent: null, chat: null });
    assert.deepEqual(h.read('agentActiveChatId'), {});
    assert.equal(h.read('_syncAgentsLock'), false);
    assert.equal(h.read('isLoading'), false);
    assert.equal(h.dom('msgInput').value, '');
    assert.equal(h.dom('fileBar').style.display, 'none');
    assert.equal(h.dom('chatList').innerHTML, '');
    assert.equal(h.dom('chatMessages').innerHTML, '');
});

test('late old-account history response never renders under a new account', async () => {
    const h = harness(); h.login('admin');
    const old = pending(); h.state.fetch = () => old.promise;
    const request = h.state.loadChatHistory('admin_one');
    h.state.doLogout(); h.login('adminquanzhi');
    old.resolve(response({ messages: [{ role: 'user', content: 'old-private' }] }));
    await request;
    assert.deepEqual(h.rendered, []);
});

test('response body decoding delayed across account switch is also rejected', async () => {
    const h = harness(); h.login('admin');
    const body = pending(); h.state.fetch = async () => ({ ok: true, json: () => body.promise });
    const request = h.state.loadChatHistory('admin_one');
    await Promise.resolve();
    h.state.doLogout(); h.login('adminquanzhi');
    body.resolve({ messages: [{ role: 'user', content: 'old-private' }] });
    await request;
    assert.deepEqual(h.rendered, []);
});

test('old login lifetime is invalid even if username and JWT are identical after relogin', async () => {
    const h = harness(); h.login('admin');
    const old = pending(); h.state.fetch = () => old.promise;
    const request = h.state.loadChatHistory('admin_one');
    h.state.doLogout(); h.login('admin');
    old.resolve(response({ messages: [{ role: 'user', content: 'expired-lifetime' }] }));
    await request;
    assert.deepEqual(h.rendered, []);
});

test('latest same-chat history request wins over an earlier response', async () => {
    const h = harness(); h.login('admin');
    const old = pending(), fresh = pending(); let count = 0;
    h.state.fetch = () => ++count === 1 ? old.promise : fresh.promise;
    const first = h.state.loadChatHistory('admin_one'), second = h.state.loadChatHistory('admin_one');
    fresh.resolve(response({ messages: [{ role: 'user', content: 'fresh' }] })); await second;
    old.resolve(response({ messages: [{ role: 'user', content: 'obsolete' }] })); await first;
    assert.deepEqual(h.rendered.map(message => message.content), ['fresh']);
});

test('switching chats rejects the previous chat history; own history still renders', async () => {
    const h = harness(); h.login('admin');
    const old = pending(); h.state.fetch = url => url.endsWith('admin_one') ? old.promise
        : Promise.resolve(response({ messages: [{ role: 'user', content: 'own-two' }] }));
    const first = h.state.loadChatHistory('admin_one');
    h.set({ currentChatId: 'admin_two' });
    await h.state.loadChatHistory('admin_two');
    old.resolve(response({ messages: [{ role: 'user', content: 'own-one' }] })); await first;
    assert.deepEqual(h.rendered.map(message => message.content), ['own-two']);
});

test('failed history fetch is not silently treated as a successful empty conversation', async () => {
    const h = harness(); h.login('admin');
    h.state.fetch = async () => response({ detail: 'not found' }, 404);
    await h.state.loadChatHistory('admin_one');
    assert.equal(h.toasts.length, 1);
    assert.deepEqual(h.rendered, []);
});

test('late old-account list cannot replace new-account sessions or current chat', async () => {
    const h = harness(); h.login('admin'); const old = pending();
    h.state.fetch = () => old.promise;
    const request = h.state.loadChatList();
    h.state.doLogout(); h.login('adminquanzhi');
    old.resolve(response({ success: true, chats: [ownChat('admin')] })); await request;
    assert.equal(h.read('currentChatId'), 'adminquanzhi_one');
    assert.deepEqual(h.read('allChats').map(chat => chat.chat_id), ['adminquanzhi_one']);
    assert.deepEqual(h.lists, []);
});

test('latest list refresh wins and cannot undo navigation while fetching', async () => {
    const h = harness(); h.login('admin'); const old = pending(), fresh = pending(); let count = 0;
    h.state.fetch = () => ++count === 1 ? old.promise : fresh.promise;
    const first = h.state.loadChatList(), second = h.state.loadChatList();
    h.set({ currentChatId: null, currentMode: 'agent', currentAgentId: 'dfmea-risk-agent' });
    fresh.resolve(response({ success: true, chats: [ownChat('admin', 'fresh')] })); await second;
    old.resolve(response({ success: true, chats: [ownChat('admin', 'old')] })); await first;
    assert.deepEqual(h.read('allChats').map(chat => chat.chat_id), ['admin_fresh']);
    assert.equal(h.read('currentChatId'), null);
    assert.equal(count, 2); // No implicit new-chat POST after navigation.
});

test('rebuild removes foreign/deleted IDs, preserves owned legacy mappings and trusts server agent_id', async () => {
    const h = harness(); h.login('adminquanzhi');
    h.set({ myAgents: [{ id: 'dfmea-risk-agent', chat_ids: ['admin_foreign', 'adminquanzhi_legacy', 'adminquanzhi_moved'] }],
        agentActiveChatId: { 'dfmea-risk-agent': 'admin_foreign', deleted: 'admin_foreign' },
        modeChatId: { agent: 'admin_foreign', chat: null } });
    const chats = [ownChat('adminquanzhi', 'new', 'dfmea-risk-agent'),
        ownChat('adminquanzhi', 'legacy'), ownChat('adminquanzhi', 'moved', 'another-agent')];
    h.state.fetch = async () => response({ success: true, chats });
    await h.state.rebuildChatIdsFromServer();
    assert.deepEqual(h.read('myAgents[0].chat_ids'), ['adminquanzhi_new', 'adminquanzhi_legacy']);
    assert.deepEqual(h.read('agentActiveChatId'), { 'dfmea-risk-agent': null });
    assert.equal(h.read('modeChatId.agent'), null);
    assert(!h.storage.has('forgeAgents'));
});

test('late previous-account mapping rebuild cannot contaminate the new account cache', async () => {
    const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
    const request = h.state.rebuildChatIdsFromServer();
    h.state.doLogout(); h.login('adminquanzhi');
    const before = h.storage.get('jlagent:adminquanzhi:forgeAgents');
    old.resolve(response({ success: true, chats: [ownChat('admin', 'old', 'dfmea-risk-agent')] })); await request;
    assert.equal(h.storage.get('jlagent:adminquanzhi:forgeAgents'), before);
    assert(!h.read('myAgents').some(agent => agent.chat_ids.includes('admin_old')));
});

for (const method of ['saveAgents', 'syncAgentsFromServer']) {
    test(`late previous-account ${method} cannot overwrite new account agent config`, async () => {
        const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
        const request = h.state[method](true);
        h.state.doLogout(); h.login('adminquanzhi');
        h.set({ _syncAgentsLock: true });
        const before = h.storage.get('jlagent:adminquanzhi:forgeAgents');
        old.resolve(response({ success: true, agents: [{ id: 'dfmea-risk-agent', task: 'old-private-task', updated_at: 9999999999 }] }));
        await request;
        assert.equal(h.storage.get('jlagent:adminquanzhi:forgeAgents'), before);
        assert(!h.read('myAgents').some(agent => agent.task === 'old-private-task'));
        assert.equal(h.read('_syncAgentsLock'), true); // Old finally cannot release a new lock.
    });
}

for (const method of ['createNewChat', 'createNewChatForAgent']) {
    test(`late previous-account ${method} response cannot select the foreign session`, async () => {
        const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
        const request = h.state[method]('dfmea-risk-agent');
        h.state.doLogout(); h.login('adminquanzhi');
        old.resolve(response({ success: true, chat: ownChat('admin', 'new') })); await request;
        assert.equal(h.read('currentChatId'), 'adminquanzhi_one');
    });
}

test('ordinary new-chat creation remains authenticated and preserves association/history', async () => {
    const h = harness(); h.login('admin'); const created = ownChat('admin', 'created', 'dfmea-risk-agent');
    h.set({ currentChatId: null, currentMode: 'agent', currentAgentId: 'dfmea-risk-agent' });
    h.state.fetch = async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer admin-token');
        if (options.method === 'POST' && url.includes('/chats?')) return response({ success: true, chat: created });
        if (url.includes('/agents')) return response({ success: true, agents: [] });
        return response({ success: true, chats: [created] });
    };
    await h.state.createNewChat();
    assert.equal(h.read('currentChatId'), 'admin_created');
    assert.deepEqual(h.read("myAgents.find(a => a.id === 'dfmea-risk-agent').chat_ids"), ['admin_created']);
});

for (const method of ['deleteChatItem', 'confirmRename', 'clearCurrentChat']) {
    test(`late previous-account ${method} cannot change new account state`, async () => {
        const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
        h.set({ renamingChatId: 'admin_one' }); h.dom('renameInput').value = 'renamed';
        const request = h.state[method]('admin_one');
        h.state.doLogout(); h.login('adminquanzhi');
        h.dom('chatMessages').innerHTML = 'new-private-message';
        h.set({ renamingChatId: 'adminquanzhi_one' });
        old.resolve(response({ success: true })); await request;
        assert.equal(h.read('currentChatId'), 'adminquanzhi_one');
        assert.equal(h.read('renamingChatId'), 'adminquanzhi_one');
        assert.equal(h.dom('chatMessages').innerHTML, 'new-private-message');
    });
}

test('pending login response cannot resurrect an account after logout', async () => {
    const h = harness(); const old = pending(); h.state.fetch = () => old.promise;
    h.dom('loginUser').value = 'admin'; h.dom('loginPass').value = 'test-only';
    const request = h.state.doLogin(); h.state.doLogout();
    old.resolve(response({ success: true, token: 'admin-token', role: 'admin' })); await request;
    assert.equal(h.read('currentUser'), null);
    assert(!h.storage.has('authToken'));
});

test('delayed login UI callback cannot reopen the logged-out chat page', async () => {
    const h = harness();
    h.dom('loginUser').value = 'admin'; h.dom('loginPass').value = 'test-only';
    h.state.fetch = async () => response({ success: true, token: 'admin-token', role: 'admin' });
    await h.state.doLogin(); h.state.doLogout();
    await h.flushTimeouts();
    assert.equal(h.read('currentUser'), null);
    assert.equal(h.dom('chatPage').style.display, 'none');
});

test('pending auto-login cannot replace a later explicit login', async () => {
    const h = harness([['authToken', 'admin-token']]); const old = pending(); h.state.fetch = () => old.promise;
    const request = h.state.tryAutoLogin(); h.state.doLogout(); h.login('adminquanzhi');
    old.resolve(response({ valid: true, username: 'admin', role: 'admin' })); await request;
    assert.equal(h.read('currentUser'), 'adminquanzhi');
});

test('browser-back logout uses the same isolation reset', () => {
    const h = harness(); h.login('admin'); h.set({ modeChatId: { agent: 'admin_one', chat: 'admin_one' } });
    h.windowEvents.get('popstate')({ state: { page: 'login' } });
    assert.equal(h.read('currentUser'), null);
    assert.deepEqual(h.read('modeChatId'), { agent: null, chat: null });
});

test('old stream 401 cannot log out the new account or reset its busy buttons/controller', async () => {
    const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
    const request = h.state.streamChat('/api/v1/chat/stream', {}, h.node());
    const oldController = vm.runInContext('currentAbortController', h.state);
    h.state.doLogout(); h.login('adminquanzhi');
    h.set({ isLoading: true }); h.dom('sendBtn').disabled = true;
    const freshController = new AbortController(); h.state.freshController = freshController;
    vm.runInContext('currentAbortController = freshController', h.state);
    old.resolve(response({ detail: 'expired' }, 401)); await request;
    assert(oldController.signal.aborted);
    assert.equal(h.read('currentUser'), 'adminquanzhi');
    assert.equal(h.read('isLoading'), true);
    assert.equal(h.dom('sendBtn').disabled, true);
    assert.equal(vm.runInContext('currentAbortController', h.state), freshController);
    assert(!freshController.signal.aborted);
});

test('old stream reader chunks never render after account switch', async () => {
    const h = harness(); h.login('admin'); const chunk = pending(), bubble = h.node();
    h.state.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: () => chunk.promise }) } });
    const request = h.state.streamChat('/api/v1/chat/stream', {}, bubble); await Promise.resolve();
    h.state.doLogout(); h.login('adminquanzhi');
    chunk.resolve({ done: false, value: new TextEncoder().encode('data: {"type":"token","content":"private"}\n') });
    await request; await h.flushTimeouts();
    assert.equal(bubble.innerHTML, '');
});

test('normal stream still renders final text and restores send controls', async () => {
    const h = harness(); h.login('admin'); const bubble = h.node(); let reads = 0;
    h.state.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => ++reads === 1
        ? { done: false, value: new TextEncoder().encode('data: {"type":"token","content":"own reply"}\ndata: {"type":"done"}\n') }
        : { done: true } }) } });
    await h.state.streamChat('/api/v1/chat/stream', {}, bubble);
    assert.equal(bubble.innerHTML, 'own reply');
    assert.equal(h.read('isLoading'), false);
    assert.equal(h.read('currentAbortController'), null);
    assert.equal(h.dom('sendBtn').disabled, false);
});

test('old send waiting for chat creation cannot send a new-account model request', async () => {
    const h = harness(); h.login('admin'); h.set({ currentChatId: null }); const old = pending();
    const calls = []; h.state.fetch = (url, options) => { calls.push(url); return old.promise; };
    h.dom('msgInput').value = 'old private question'; const request = h.state.sendMessage();
    h.state.doLogout(); h.login('adminquanzhi'); h.set({ isLoading: true });
    old.resolve(response({ success: true, chat: ownChat('admin', 'created') })); await request;
    assert.equal(calls.length, 1);
    assert.equal(h.read('isLoading'), true);
    assert.deepEqual(h.rendered, []);
});

test('late old-account FileReader callback cannot restore a private image', () => {
    const h = harness(); h.login('admin');
    h.state.setFilePreview({ name: 'private.png', type: 'image/png' });
    const reader = h.fileReaders[0]; h.state.doLogout(); h.login('adminquanzhi');
    reader.onload({ target: { result: 'private-base64' } });
    assert.equal(h.read('selectedFileBase64'), null);
});

test('ordinary login initialization only requests and displays the authenticated account', async () => {
    const h = harness();
    h.dom('loginUser').value = 'adminquanzhi'; h.dom('loginPass').value = 'test-only';
    h.state.fetch = async (url, options) => {
        if (url.endsWith('/auth/login')) return response({ success: true, token: 'adminquanzhi-token', role: 'admin' });
        assert.equal(options.headers.Authorization, 'Bearer adminquanzhi-token');
        if (url.includes('/models')) return response({ models: [{ id: 'auto', name: 'Auto' }], current: 'auto' });
        if (url.includes('/agents')) return response({ success: true, agents: [] });
        if (url.includes('/history/')) return response({ messages: [] });
        assert(url.includes('username=adminquanzhi'));
        return response({ success: true, chats: [ownChat('adminquanzhi', 'one', 'dfmea-risk-agent')] });
    };
    await h.state.doLogin(); await h.flushTimeouts();
    assert.equal(h.read('currentUser'), 'adminquanzhi');
    assert.equal(h.dom('chatPage').style.display, 'flex');
    assert(h.read('allChats').every(chat => chat.chat_id.startsWith('adminquanzhi_')));
    assert.equal(h.dom('headerUserName').textContent, 'adminquanzhi (管理员)');
});

test('normal own-account list restores only its chat and history without creating another chat', async () => {
    const h = harness(); h.login('adminquanzhi'); h.set({ currentChatId: null });
    const urls = [];
    h.state.fetch = async url => {
        urls.push(url);
        return url.includes('/history/') ? response({ messages: [{ role: 'user', content: 'own-history' }] })
            : response({ success: true, chats: [ownChat('adminquanzhi')] });
    };
    await h.state.loadChatList();
    assert.equal(h.read('currentChatId'), 'adminquanzhi_one');
    assert.deepEqual(h.rendered, [{ account: 'adminquanzhi', role: 'user', content: 'own-history' }]);
    assert.equal(urls.length, 2);
});

test('old file send completion does not remove the new account file or reset its busy state', async () => {
    const h = harness(); h.login('admin'); const old = pending();
    h.state.fetch = () => old.promise;
    h.set({ selectedFile: { name: 'old.docx', type: 'application/docx' } });
    h.dom('msgInput').value = 'old-private-question';
    const request = h.state.sendMessage();
    h.state.doLogout(); h.login('adminquanzhi');
    h.set({ selectedFile: { name: 'new.docx', type: 'application/docx' }, isLoading: true });
    h.dom('sendBtn').disabled = true;
    old.resolve(response({ detail: 'old expired' }, 401)); await request;
    assert.equal(h.read('selectedFile.name'), 'new.docx');
    assert.equal(h.read('isLoading'), true);
    assert.equal(h.dom('sendBtn').disabled, true);
});

test('old regenerate completion does not reset a new account stream', async () => {
    const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
    const btn = { closest: () => ({ previousElementSibling: { classList: { contains: () => true },
        querySelector: () => ({ textContent: 'old question' }) }, remove() {} }) };
    const request = h.state.regenerateMessage(btn);
    h.state.doLogout(); h.login('adminquanzhi'); h.set({ isLoading: true });
    old.resolve(response({ detail: 'old expired' }, 401)); await request;
    assert.equal(h.read('currentUser'), 'adminquanzhi');
    assert.equal(h.read('isLoading'), true);
});

test('old same-account stream cannot reset a newer stream after chat navigation', async () => {
    const h = harness(); h.login('admin'); const old = pending(); h.state.fetch = () => old.promise;
    const request = h.state.streamChat('/api/v1/chat/stream', {}, h.node());
    h.state.stopGeneration(); h.set({ currentChatId: 'admin_two' });
    const next = pending(); h.state.fetch = () => next.promise;
    h.set({ isLoading: true }); const newer = h.state.streamChat('/api/v1/chat/stream', {}, h.node());
    const freshController = vm.runInContext('currentAbortController', h.state);
    old.resolve(response({ detail: 'expired' }, 401)); await request;
    assert.equal(h.read('isLoading'), true);
    assert.equal(vm.runInContext('currentAbortController', h.state), freshController);
    next.resolve({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }); await newer;
    assert.equal(h.read('isLoading'), false);
});

test('pending history is invalidated when a new message starts in the same chat', async () => {
    const h = harness(); h.login('admin'); const old = pending();
    h.state.fetch = () => old.promise;
    const history = h.state.loadChatHistory('admin_one');
    h.dom('msgInput').value = 'new question'; h.state.streamChat = async () => {};
    h.state.loadChatList = async () => {};
    await h.state.sendMessage();
    old.resolve(response({ messages: [{ role: 'user', content: 'outdated-history' }] })); await history;
    assert.deepEqual(h.rendered.map(message => message.content), ['new question']);
});

test('old-account export response cannot start a download under the new account', async () => {
    const h = harness(); h.login('admin'); const old = pending(); let blobReads = 0;
    h.state.fetch = () => old.promise;
    const request = h.state.exportChat('docx'); h.state.doLogout(); h.login('adminquanzhi');
    old.resolve({ ok: true, blob: async () => { ++blobReads; throw Error('must not read old file'); } });
    await request;
    assert.equal(blobReads, 0);
    assert.deepEqual(h.toasts, []);
});

test('export body completing after account switch is discarded before creating a download URL', async () => {
    const h = harness(); h.login('admin'); const body = pending();
    h.state.fetch = async () => ({ ok: true, blob: () => body.promise });
    const request = h.state.exportChat('docx'); await Promise.resolve();
    h.state.doLogout(); h.login('adminquanzhi');
    body.resolve({ privateBody: true }); // Not a Blob: URL creation would fail if guard is absent.
    await request;
    assert.deepEqual(h.toasts, []);
});

test('API requests remain excluded from service worker cache; asset versions match', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/static/index.html'), 'utf8');
    const worker = fs.readFileSync(path.join(__dirname, '../app/static/sw.js'), 'utf8');
    const version = html.match(/app\.js\?v=([^"']+)/)[1];
    assert.match(version, /^\d{8}-[a-z0-9-]+$/);
    assert(worker.includes('/static/js/app.js?v=' + version));
    assert(html.includes('/static/sw.js?v=' + version));
    assert(worker.includes('/\\/api\\/v1\\//'));
});
