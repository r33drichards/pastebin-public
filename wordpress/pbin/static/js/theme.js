// pbin theme + icons — shared by every page.
//
// Loaded synchronously in <head> so the theme is applied before first paint
// (no flash of the wrong theme). Three states: 'light' | 'dark' | 'system';
// 'system' follows prefers-color-scheme live. The choice persists in
// localStorage ('pbin-theme'; absent = system). ?theme=dark|light in the URL
// pins the theme (useful for embeds and tests).
(function () {
  'use strict';

  // ---- inline SVG icon set (replaces the Font Awesome CDN kit) -------------
  var P = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  var ICONS = {
    play: P + '<path d="M7 5v14l12-7z" fill="currentColor" stroke="none"/></svg>',
    stop: P + '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></svg>',
    sparkle: P + '<path d="M12 3l1.9 5.6L20 10.5l-5.1 2.9L13 19l-1.9-5.6L5 10.5l6.1-1.9z" fill="currentColor" stroke="none"/></svg>',
    copy: P + '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    link: P + '<path d="M10 13a5 5 0 0 0 7.1 0l2.8-2.8a5 5 0 0 0-7.1-7.1L11 5"/><path d="M14 11a5 5 0 0 0-7.1 0l-2.8 2.8a5 5 0 0 0 7.1 7.1L13 19"/></svg>',
    raw: P + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    eye: P + '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: P + '<path d="M2 12s3.5-7 10-7c2 0 3.8.7 5.3 1.6M22 12s-3.5 7-10 7c-2 0-3.8-.7-5.3-1.6"/><path d="M4 20 20 4"/></svg>',
    wrap: P + '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 15-2.5 3 2.5 3"/><path d="M3 18h7"/></svg>',
    code: P + '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    check: P + '<path d="M20 6 9 17l-5-5"/></svg>',
    x: P + '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    save: P + '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
    sun: P + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: P + '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
    monitor: P + '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>'
  };
  window.pbinIcon = function (name) { return ICONS[name] || ''; };

  // ---- theme state machine -------------------------------------------------
  var mq = matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try { return window.pbinStorage.getItem('pbin-theme'); } catch (e) { return null; }
  }
  function mode() { var s = stored(); return s === 'light' || s === 'dark' ? s : 'system'; }
  function resolve(m) { return m === 'system' ? (mq.matches ? 'dark' : 'light') : m; }

  // Monaco keeps its stock themes: syntax highlighting is the one place
  // color stays, whatever the shell design does.
  window.pbinEnsureMonacoThemes = function () {
    return !!(window.monaco && monaco.editor);
  };
  window.pbinMonacoTheme = function () {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs-light';
  };

  function apply() {
    var t = resolve(mode());
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#090D18' : '#EAF2FA');
    if (window.pbinEnsureMonacoThemes()) monaco.editor.setTheme(window.pbinMonacoTheme());
    window.dispatchEvent(new CustomEvent('pbin:theme', { detail: t }));
  }

  function renderButton() {
    var btn = document.getElementById('themeToggleButton');
    var ico = document.getElementById('themeIcon');
    if (!btn || !ico) return;
    var m = mode();
    var label = {
      system: 'Theme: follows your system. Click for light.',
      light: 'Theme: light. Click for dark.',
      dark: 'Theme: dark. Click to follow your system.'
    }[m];
    ico.innerHTML = ICONS[{ system: 'monitor', light: 'sun', dark: 'moon' }[m]];
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  var q = (location.search.match(/[?&]theme=(dark|light)/) || [])[1];
  if (q) { try { window.pbinStorage.setItem('pbin-theme', q); } catch (e) {} }

  window.pbinThemeMode = mode;
  window.pbinRenderThemeButton = renderButton;
  window.pbinSetTheme = function (m) {
    try {
      if (m === 'system') window.pbinStorage.removeItem('pbin-theme');
      else window.pbinStorage.setItem('pbin-theme', m);
    } catch (e) {}
    apply();
    renderButton();
  };
  // The toggle cycles system -> light -> dark -> system.
  window.pbinToggleTheme = function () {
    window.pbinSetTheme({ system: 'light', light: 'dark', dark: 'system' }[mode()]);
  };

  var onSystemChange = function () { if (mode() === 'system') apply(); };
  mq.addEventListener ? mq.addEventListener('change', onSystemChange) : mq.addListener(onSystemChange);

  // Before first paint: set the attribute now; finish wiring once the DOM is in.
  document.documentElement.setAttribute('data-theme', resolve(mode()));
  window.addEventListener('DOMContentLoaded', function () {
    apply();
    renderButton();
    // Monaco loads later from a CDN; keep nudging until it follows the theme.
    var n = 0, iv = setInterval(function () {
      if ((window.monaco && monaco.editor && (apply(), true)) || ++n > 60) clearInterval(iv);
    }, 150);
  });
})();
