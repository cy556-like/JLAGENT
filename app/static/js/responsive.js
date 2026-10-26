/* Presentation only: no account, chat, model or generation requests. */
(() => {
    const mobile = window.matchMedia('(max-width: 768px)');
    const root = document.documentElement;
    const header = document.querySelector('.chat-header');
    const sidebar = document.getElementById('sidebar');
    const menu = document.querySelector('.mobile-sidebar-toggle, .mobile-sidebar-btn');
    const inner = document.getElementById('qualityInnerSidebar');
    const innerToggle = document.getElementById('qualityInnerMobileToggle');
    let frame = 0;
    function updateSize() {
        frame = 0;
        if (!mobile.matches) {
            root.style.removeProperty('--agent-mobile-height');
            root.style.removeProperty('--agent-header-height');
            return;
        }
        const viewport = window.visualViewport;
        // Pinch zoom should magnify the existing layout instead of reflowing it.
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const height = viewport ? viewport.height : window.innerHeight;
        if (height > 0) root.style.setProperty('--agent-mobile-height', `${Math.round(height)}px`);
        if (header) root.style.setProperty('--agent-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    }
    function schedule() { if (!frame) frame = window.requestAnimationFrame(updateSize); }
    function syncMenu() {
        if (menu && sidebar) {
            menu.setAttribute('aria-controls', 'sidebar');
            menu.setAttribute('aria-expanded', String(sidebar.classList.contains('mobile-open')));
        }
    }
    let overlay;
    if (inner) {
        overlay = document.createElement('div');
        overlay.className = 'responsive-inner-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.addEventListener('click', () => inner.classList.remove('mobile-open'));
        document.body.appendChild(overlay);
        const syncInner = () => {
            const open = inner.classList.contains('mobile-open');
            overlay.classList.toggle('active', open && mobile.matches);
            if (innerToggle) {
                innerToggle.setAttribute('aria-controls', 'qualityInnerSidebar');
                innerToggle.setAttribute('aria-expanded', String(open));
            }
        };
        new MutationObserver(syncInner).observe(inner, {attributes: true, attributeFilter: ['class']});
        syncInner();
    }
    if (sidebar) new MutationObserver(syncMenu).observe(sidebar, {attributes: true, attributeFilter: ['class']});
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (sidebar && sidebar.classList.contains('mobile-open') && typeof closeSidebarMobile === 'function') {
            closeSidebarMobile();
            if (menu) menu.focus();
        }
        if (inner && inner.classList.contains('mobile-open')) {
            inner.classList.remove('mobile-open');
            if (innerToggle) innerToggle.focus();
        }
    });
    function modeChanged() {
        if (typeof closeSidebarMobile === 'function') closeSidebarMobile();
        if (inner) inner.classList.remove('mobile-open');
        schedule();
    }
    window.addEventListener('resize', schedule, {passive: true});
    if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule, {passive: true});
    if (mobile.addEventListener) mobile.addEventListener('change', modeChanged);
    else mobile.addListener(modeChanged);
    if (header && typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(header);
    syncMenu();
    updateSize();
})();
