/* ═══════════════════════════════════════════
   Theme toggle (light / dark)

   The dark theme is the default. When a user toggles light mode we set
   `data-theme="light"` on <html> — board.css contains :root[data-theme="light"]
   overrides for the BB CSS custom properties. The choice is persisted to
   localStorage under `bb-theme`. A small inline boot script in index.html
   applies the saved theme before paint to avoid a FOUC.
   ═══════════════════════════════════════════ */
(function () {
    var STORAGE_KEY = 'bb-theme';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function applyTheme(theme) {
        if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* ignore */ }
        updateButton(theme);
    }

    function updateButton(theme) {
        var btn = document.getElementById('btn-theme-toggle');
        if (!btn) return;
        // Show what clicking will switch you TO.
        if (theme === 'light') {
            btn.textContent = '🌙';
            btn.title = 'Switch to dark mode';
        } else {
            btn.textContent = '☀️';
            btn.title = 'Switch to light mode';
        }
    }

    function init() {
        // Reflect whatever the inline boot script (or default) put in place.
        updateButton(currentTheme());
        var btn = document.getElementById('btn-theme-toggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
