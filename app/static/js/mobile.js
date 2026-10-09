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
