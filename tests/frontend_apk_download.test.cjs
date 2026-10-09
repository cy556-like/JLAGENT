'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function downloadHarness(userAgent) {
    const elements = new Map();
    for (const id of ['mobileApkDownload', 'apkDownloadLink', 'apkDownloadHint', 'apkDownloadHintClose']) {
        elements.set(id, {hidden: true, events: new Map(),
            addEventListener(name, handler) { this.events.set(name, handler); }});
    }
    const query = {matches: true, addEventListener() {}};
    const context = {
        document: {getElementById: id => elements.get(id), documentElement: {style: {setProperty() {}, removeProperty() {}}}},
        navigator: {userAgent},
        window: {innerHeight: 844, matchMedia: () => query, addEventListener() {}, requestAnimationFrame() {}},
    };
    vm.runInNewContext(read('app/static/js/mobile.js'), context);
    return elements;
}

test('mobile browser enables a real APK link; installed app never unhides it', () => {
    assert.equal(downloadHarness('Mozilla/5.0 Android Chrome/140').get('mobileApkDownload').hidden, false);
    for (const version of ['1.1.0', '1.2.0', '2.0.0']) {
        const h = downloadHarness('Mozilla/5.0 Android; wv JLAGENTAndroid/' + version);
        assert.equal(h.get('mobileApkDownload').hidden, true);
        assert.equal(h.get('apkDownloadLink').events.size, 0);
    }
});
test('browser downloads use default link behavior, without login/API interception', () => {
    const h = downloadHarness('Android Chrome/140');
    let prevented = false;
    h.get('apkDownloadLink').events.get('click')({preventDefault() { prevented = true; }});
    assert.equal(prevented, false);
    assert.equal(h.get('apkDownloadHint').hidden, true);
});
test('WeChat shows closable instructions instead of pretending installation succeeded', () => {
    const h = downloadHarness('Android MicroMessenger/8.0.63');
    let prevented = false;
    h.get('apkDownloadLink').events.get('click')({preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    assert.equal(h.get('apkDownloadHint').hidden, false);
    h.get('apkDownloadHintClose').events.get('click')();
    assert.equal(h.get('apkDownloadHint').hidden, true);
});
test('App marker takes priority even if another UA marker says WeChat', () => {
    const h = downloadHarness('Android MicroMessenger/8 JLAGENTAndroid/1.2.0');
    assert.equal(h.get('mobileApkDownload').hidden, true);
});
test('download link starts hidden, targets the signed APK and stays outside the login form', () => {
    const html = read('app/static/index.html');
    assert.match(html, /id="mobileApkDownload" hidden/);
    const link = html.match(/<a id="apkDownloadLink"[^>]+>/)[0];
    assert(link.includes('href="/static/downloads/JLAGENT-Android-1.2.0.apk"'));
    assert(link.includes('download="JLAGENT-Android-1.2.0.apk"'));
    assert.equal((html.match(/id="apkDownloadLink"/g) || []).length, 1);
    const apk = fs.readFileSync(path.join(root, 'app/static/downloads/JLAGENT-Android-1.2.0.apk'));
    assert.equal(crypto.createHash('sha256').update(apk).digest('hex'),
        'add94d118307abc1c94faed8082264b05792ae2a3a74f73937972b9f4400b4a1');
});
test('APK bypasses service worker caching and is not downloaded on page load', () => {
    const events = new Map();
    const origin = 'https://47.114.99.132:8003';
    vm.runInNewContext(read('app/static/sw.js'), {
        URL, location: {origin}, self: {addEventListener: (name, handler) => events.set(name, handler)},
    });
    let intercepted = false;
    events.get('fetch')({request: {url: origin + '/static/downloads/JLAGENT-Android-1.2.0.apk', mode: 'navigate'},
        respondWith() { intercepted = true; }});
    assert.equal(intercepted, false);
    const precache = read('app/static/sw.js').match(/const PRECACHE_URLS = \[([\s\S]*?)\];/)[1];
    assert(!precache.includes('.apk'));
});
