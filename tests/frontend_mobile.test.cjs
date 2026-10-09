'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function viewportHarness(width, height, legacy = false) {
    const styles = new Map(), events = new Map(), frames = [];
    const query = {matches: width <= 768};
    if (legacy) query.addListener = fn => events.set('change', fn);
    else query.addEventListener = (name, fn) => events.set(name, fn);
    const viewport = {height, scale: 1, addEventListener: (name, fn) => events.set('visual-' + name, fn)};
    const context = {
        document: {documentElement: {style: {
            setProperty: (name, value) => styles.set(name, value),
            removeProperty: name => styles.delete(name),
        }}},
        window: {innerWidth: width, innerHeight: height, visualViewport: viewport,
            matchMedia: () => query, requestAnimationFrame: fn => {frames.push(fn); return frames.length;},
            addEventListener: (name, fn) => events.set(name, fn)},
    };
    vm.runInNewContext(read('app/static/js/mobile.js'), context);
    return {styles, events, frames, query, viewport,
        flush: () => {const queue = frames.splice(0); queue.forEach(fn => fn());}};
}

test('phone viewport follows visible height when keyboard shrinks it', () => {
    const h = viewportHarness(390, 844);
    assert.equal(h.styles.get('--jl-mobile-height'), '844px');
    h.viewport.height = 460;
    h.events.get('visual-resize')();
    h.flush();
    assert.equal(h.styles.get('--jl-mobile-height'), '460px');
});
test('resize work is batched instead of repeatedly changing layout', () => {
    const h = viewportHarness(390, 844);
    for (let i = 0; i < 30; i++) h.events.get('resize')();
    assert.equal(h.frames.length, 1);
});
test('desktop does not inherit mobile height; resizing to desktop removes it', () => {
    const h = viewportHarness(390, 844);
    h.query.matches = false;
    h.events.get('change')();
    h.flush();
    assert(!h.styles.has('--jl-mobile-height'));
    assert(!viewportHarness(1440, 900).styles.has('--jl-mobile-height'));
});
test('pinch zoom does not incorrectly shrink the page layout', () => {
    const h = viewportHarness(390, 844);
    h.viewport.scale = 2;
    h.viewport.height = 422;
    h.events.get('visual-resize')();
    h.flush();
    assert.equal(h.styles.get('--jl-mobile-height'), '844px');
});
test('older mobile browser matchMedia API is supported', () => {
    const h = viewportHarness(390, 844, true);
    h.query.matches = false;
    h.events.get('change')();
    h.flush();
    assert(!h.styles.has('--jl-mobile-height'));
});
test('mobile assets are linked and precached; zoom remains accessible', () => {
    const html = read('app/static/index.html'), sw = read('app/static/sw.js');
    const version = html.match(/app\.js\?v=([^"']+)/)[1];
    for (const asset of ['/static/css/mobile.css', '/static/js/mobile.js']) {
        assert(html.includes(asset + '?v=' + version));
        assert(sw.includes(asset + '?v=' + version));
    }
    assert(html.includes('interactive-widget=resizes-content'));
    assert(!html.includes('user-scalable=no'));
    assert(html.includes('onclick="toggleSidebar()"'));
});
test('mobile script has no network, token or account mutation paths', () => {
    const source = read('app/static/js/mobile.js');
    assert(!/fetch\(|XMLHttpRequest|localStorage|authToken|doLogin|doLogout/.test(source));
});
test('APK embeds supplied HTTPS site instead of launching a browser; bridge is origin-bound', () => {
    const source = read('mobile/android/src/com/cy556/jlagent/MainActivity.java');
    const downloads = read('mobile/android/src/com/cy556/jlagent/EmbeddedDownloads.java');
    const manifest = read('mobile/android/AndroidManifest.xml');
    assert(source.includes('https://47.114.99.132:8003'));
    assert(source.includes('web = new WebView(this)'));
    assert(source.includes('web.loadUrl(SITE)'));
    assert(source.includes('handler.cancel()'));
    assert(source.includes('WebSettings.MIXED_CONTENT_NEVER_ALLOW'));
    assert(source.includes('settings.setAllowFileAccess(false)'));
    assert(source.includes('settings.setAllowContentAccess(false)'));
    assert(!/addJavascriptInterface|\.proceed\(|Intent\.ACTION_VIEW|customtabs\.extra|getStringExtra|http:\/\//.test(source + downloads));
    assert(downloads.includes('Uri.parse(MainActivity.ORIGIN)'));
    assert(!downloads.includes('Uri.EMPTY)'));
    assert(source.includes('Intent.ACTION_OPEN_DOCUMENT'));
    assert(source.includes('Intent.ACTION_CREATE_DOCUMENT'));
    assert.equal((manifest.match(/<uses-permission/g) || []).length, 1);
    assert(manifest.includes('android.permission.INTERNET'));
    assert(manifest.includes('android:versionCode="2"'));
    assert(manifest.includes('android:windowSoftInputMode="adjustResize"'));
    assert(manifest.includes('android:debuggable="false"'));
    assert(manifest.includes('android:usesCleartextTraffic="false"'));
});
