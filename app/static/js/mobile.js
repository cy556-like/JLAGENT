/* Use the visible height when the Android keyboard covers the layout viewport. */
(() => {
    const mobile = window.matchMedia('(max-width: 768px)');
    let frame = 0;
    function updateHeight() {
        frame = 0;
        if (!mobile.matches) {
            document.documentElement.style.removeProperty('--jl-mobile-height');
            return;
        }
        const viewport = window.visualViewport;
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const height = viewport ? viewport.height : window.innerHeight;
        if (height > 0) document.documentElement.style.setProperty('--jl-mobile-height', `${Math.round(height)}px`);
    }
    function schedule() { if (!frame) frame = window.requestAnimationFrame(updateHeight); }
    window.addEventListener('resize', schedule, {passive: true});
    if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule, {passive: true});
    if (mobile.addEventListener) mobile.addEventListener('change', schedule);
    else mobile.addListener(schedule);
    updateHeight();
})();

/* Download is a normal public link, not an API call or a login action. */
(() => {
    const controls = document.getElementById('mobileApkDownload');
    if (!controls) return;
    const userAgent = navigator.userAgent || '';
    // Start hidden in HTML to avoid a download-button flash while the app restores login.
    if (/\bJLAGENTAndroid\//i.test(userAgent)) return;
    controls.hidden = false; // CSS limits visibility to phone/tablet browsers.
    const link = document.getElementById('apkDownloadLink');
    const hint = document.getElementById('apkDownloadHint');
    const close = document.getElementById('apkDownloadHintClose');
    if (!link || !hint || !close) return;
    link.addEventListener('click', event => {
        if (!/MicroMessenger/i.test(userAgent)) return;
        event.preventDefault();
        hint.hidden = false;
    });
    close.addEventListener('click', () => { hint.hidden = true; });
    link.addEventListener('keydown', event => {
        if (event.key === 'Escape') hint.hidden = true;
    });
})();
