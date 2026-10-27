/* The existing doLogin() owns authentication; this only reveals the password on request. */
(() => {
    const button = document.getElementById('loginPasswordToggle');
    const input = document.getElementById('loginPass');
    if (!button || !input) return;
    button.addEventListener('click', () => {
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        button.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
        button.setAttribute('aria-pressed', String(reveal));
    });
})();
