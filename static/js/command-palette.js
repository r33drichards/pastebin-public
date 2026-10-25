// pbin command menu — Ctrl/Cmd+K action palette.
//
// Built on ninja-keys, a dependency-light command-palette web component
// loaded as an ES module from jsDelivr in templates/paste.html (the same
// way the page's other runtime deps are CDN-served). This file owns the
// action catalog: it rebuilds the list every time the palette opens, so the
// menu only offers what the page can do right now — debugger stepping only
// while paused, starters only where one exists for the language, and so on.
//
// Most actions delegate to the toolbar's own handlers (clicking the real
// button keeps its "Copied" feedback flashes and any state it tracks); the
// rest call the globals the other modules export (window.runCode,
// window.PbinDebug, window.pbinSelectTab, ...).
(function () {
  'use strict';

  var ninja = null; // the <ninja-keys> element, once the module has loaded

  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var RUN_KEY = isMac ? '⌘⏎' : 'Ctrl+Enter';

  function el(id) { return document.getElementById(id); }
  // Visible as far as the app's own toggles go: not .hidden, not inline
  // display:none. (Media-query hiding is ignored on purpose — on a phone
  // the palette is how the pb-hide-sm actions stay reachable.)
  function shown(id) {
    var node = el(id);
    return !!node && !node.classList.contains('hidden') && node.style.display !== 'none';
  }
  function click(id) { return function () { var node = el(id); if (node) node.click(); }; }
  function goTo(href) { return function () { window.location.href = href; }; }
  function pressed(id) { var node = el(id); return !!node && node.getAttribute('aria-pressed') === 'true'; }

  // The paste's effective language (kept in sync by the picker's change
  // handler); debuggable means the debugger modules can drive it.
  function currentLang() { var node = el('language'); return node ? node.value : ''; }
  function isDebuggable() {
    var lang = currentLang();
    return lang === 'python' || lang === 'javascript' || lang === 'typescript';
  }

  // ---- the action catalog ---------------------------------------------------
  //
  // Submenus use the flat form — child actions carry an explicit `parent`
  // and the parent lists its children's ids — because ninja-keys' nested
  // flattener mis-parents every action that follows an inline submenu.

  function languageChildren() {
    var select = el('languageSelect');
    if (!select) return [];
    // runnable languages first, alphabetically — the same order as the
    // toolbar's language picker
    var options = Array.prototype.slice.call(select.options).sort(function (a, b) {
      var ra = a.textContent.trim().indexOf('▶') === 0;
      var rb = b.textContent.trim().indexOf('▶') === 0;
      if (ra !== rb) return ra ? -1 : 1;
      return ra ? a.textContent.trim().localeCompare(b.textContent.trim()) : 0;
    });
    return options.map(function (option) {
      var label = option.textContent.trim();
      var current = option.value === select.value;
      return {
        id: 'lang:' + (option.value || 'text'),
        parent: 'switch-language',
        title: label + (current ? ' — current' : ''),
        section: label.indexOf('▶') === 0 ? 'Runnable' : 'Other languages',
        keywords: option.value,
        handler: function () {
          if (option.value === select.value) return;
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        },
      };
    });
  }

  function themeChildren() {
    var mode = window.pbinThemeMode ? window.pbinThemeMode() : 'system';
    return ['light', 'dark', 'system'].map(function (m) {
      return {
        id: 'theme:' + m,
        parent: 'theme',
        title: m.charAt(0).toUpperCase() + m.slice(1) + (m === mode ? ' — current' : ''),
        keywords: 'theme ' + m,
        handler: function () { if (window.pbinSetTheme) window.pbinSetTheme(m); },
      };
    });
  }

  function buildActions() {
    var actions = [];
    var dbg = window.PbinDebug;
    var paused = !!(dbg && dbg.isPaused());
    var debuggable = isDebuggable();

    function add(action) { actions.push(action); }

    // ---- Run ----
    var runLabel = (el('runButtonLabel') || {}).textContent || 'Run';
    add({
      id: 'run', section: 'Run', keywords: 'run execute command start',
      title: runLabel + ' the code (' + RUN_KEY + ')',
      handler: function () { if (window.runCode) window.runCode(); },
    });
    if (shown('cancelButton')) {
      add({
        id: 'cancel', section: 'Run', keywords: 'cancel stop kill abort',
        title: 'Cancel: stop the running program',
        handler: function () { if (window.cancelExecution) window.cancelExecution(); },
      });
    }
    if (debuggable && dbg) {
      var mode = dbg.getRunMode ? dbg.getRunMode() : 'plain';
      add({
        id: 'run-mode', section: 'Run', keywords: 'run mode debugger breakpoints plain',
        title: mode === 'debug'
          ? 'Run mode: switch to plain run (ignore breakpoints)'
          : 'Run mode: switch to run in debugger (pause at breakpoints)',
        handler: function () { dbg.setRunMode(mode === 'debug' ? 'plain' : 'debug'); },
      });
    }
    var autoRun = el('autoRunCheckbox');
    if (autoRun) {
      add({
        id: 'auto-run', section: 'Run', keywords: 'auto run automatic rerun watch',
        title: 'Auto run: turn ' + (autoRun.checked ? 'off' : 'on'),
        handler: function () {
          autoRun.checked = !autoRun.checked;
          autoRun.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    }

    // ---- Debug ----
    if (debuggable && dbg) {
      add({
        id: 'toggle-breakpoint', section: 'Debug', keywords: 'breakpoint set toggle bp F9',
        title: 'Toggle breakpoint on the current line (F9)',
        handler: function () {
          var editor = window.pbinEditor;
          var pos = editor && editor.getPosition();
          if (pos) dbg.toggleBreakpoint(pos.lineNumber);
        },
      });
      add({
        id: 'pause-exceptions', section: 'Debug', keywords: 'pause exceptions errors raise throw',
        title: 'Pause on exceptions: turn ' + (dbg.getPauseOnException() ? 'off' : 'on'),
        handler: function () { dbg.setPauseOnException(!dbg.getPauseOnException()); },
      });
      if (shown('pbDbgBpsToggle')) {
        add({
          id: 'bps-toggle', section: 'Debug', keywords: 'breakpoints enable disable all',
          title: (el('pbDbgBpsToggle').textContent || 'toggle all') .replace(/^./, function (c) { return c.toUpperCase(); }) + ' breakpoints',
          handler: click('pbDbgBpsToggle'),
        });
        add({
          id: 'bps-clear', section: 'Debug', keywords: 'breakpoints delete remove clear all',
          title: 'Delete all breakpoints',
          handler: click('pbDbgBpsClear'),
        });
      }
      if (paused) {
        [
          ['dbg-continue', 'pbDbgContinue', 'Continue to the next breakpoint (F8)', 'continue resume go'],
          ['dbg-over', 'pbDbgOver', 'Step over (F10)', 'step over next'],
          ['dbg-into', 'pbDbgInto', 'Step into (F11)', 'step into'],
          ['dbg-out', 'pbDbgOut', 'Step out (Shift+F11)', 'step out finish'],
          ['dbg-back', 'pbDbgBack', 'Step back through history', 'step back rewind history'],
          ['dbg-fwd', 'pbDbgFwd', 'Step forward through history', 'step forward history'],
          ['dbg-restart', 'pbDbgRestart', 'Restart the run from the beginning', 'restart rerun'],
          ['dbg-stop', 'pbDbgStop', 'Stop the program', 'stop quit end'],
        ].forEach(function (entry) {
          add({ id: entry[0], section: 'Debug', title: entry[2], keywords: entry[3], handler: click(entry[1]) });
        });
      }
    }

    // ---- Language ----
    var langs = languageChildren();
    add({
      id: 'switch-language', section: 'Language',
      title: 'Switch language…',
      keywords: 'language lang syntax switch change ' + currentLang(),
      // no handler: selecting it opens the submenu
      children: langs.map(function (c) { return c.id; }),
    });
    langs.forEach(add);

    // ---- Edit ----
    if (shown('formatButton')) {
      add({
        id: 'format', section: 'Edit', keywords: 'format prettier beautify indent',
        title: 'Format code (Ctrl+Shift+F)',
        handler: function () { if (window.formatCode) window.formatCode(); },
      });
    }
    add({
      id: 'word-wrap', section: 'Edit', keywords: 'word wrap lines toggle',
      title: 'Word wrap: turn ' + (pressed('toggleWordWrapButton') ? 'off' : 'on'),
      handler: function () { if (window.toggleWordWrap) window.toggleWordWrap(); },
    });
    if (shown('toggleAiButton')) {
      add({
        id: 'ai-completions', section: 'Edit', keywords: 'ai completions ghost text suggestions copilot',
        title: 'AI completions: turn ' + (pressed('toggleAiButton') ? 'off' : 'on'),
        handler: function () { if (window.toggleAiCompletions) window.toggleAiCompletions(); },
      });
    }
    if (shown('helloWorldButton')) {
      add({
        id: 'hello-world', section: 'Edit', keywords: 'hello world example starter insert',
        title: 'Insert a Hello World example',
        handler: function () { if (window.insertHelloWorld) window.insertHelloWorld(); },
      });
    }
    if (shown('echoStdinButton')) {
      add({
        id: 'echo-stdin', section: 'Edit', keywords: 'echo input stdin example insert',
        title: 'Insert an example that echoes the Input tab',
        handler: function () { if (window.insertEchoStdin) window.insertEchoStdin(); },
      });
    }
    if (shown('jsonStdinButton')) {
      add({
        id: 'json-stdin', section: 'Edit', keywords: 'json parse input stdin example insert',
        title: 'Insert an example that parses JSON from the Input tab',
        handler: function () { if (window.insertJsonStdin) window.insertJsonStdin(); },
      });
    }
    if (shown('effectTracingButton')) {
      add({
        id: 'effect-tracing', section: 'Edit', keywords: 'effect trace spans otel waterfall example starter insert',
        title: 'Insert an Effect example with traced spans',
        handler: function () { if (window.insertEffectTracing) window.insertEffectTracing(); },
      });
    }
    if (el('attachFileButton')) {
      add({
        id: 'attach-files', section: 'Edit', keywords: 'attach files upload input stdin',
        title: 'Attach input files…',
        handler: click('attachFileButton'),
      });
    }
    if (shown('formatInputButton')) {
      add({
        id: 'format-input', section: 'Edit', keywords: 'format input json pretty print',
        title: 'Format the JSON input',
        handler: function () { if (window.formatInput) window.formatInput(); },
      });
    }

    // ---- Share ----
    add({
      id: 'copy-text', section: 'Share', keywords: 'copy text clipboard paste',
      title: 'Copy paste text', handler: click('copyTextButton'),
    });
    add({
      id: 'share-link', section: 'Share', keywords: 'share link url copy clipboard',
      title: 'Copy share link', handler: click('sharePasteButton'),
    });
    if (el('snapshotButton')) {
      add({
        id: 'snapshot', section: 'Share', keywords: 'snapshot freeze immutable version save',
        title: 'Create an immutable snapshot…', handler: click('snapshotButton'),
      });
    }
    add({
      id: 'copy-output', section: 'Share', keywords: 'copy output result clipboard',
      title: 'Copy output', handler: click('copyOutputButton'),
    });
    add({
      id: 'download-output', section: 'Share', keywords: 'download output save file',
      title: 'Download output', handler: click('downloadOutputButton'),
    });

    // ---- View ----
    [['code', 'Code'], ['input', 'Input'], ['output', 'Output']].forEach(function (doc) {
      add({
        id: 'tab-' + doc[0], section: 'View', keywords: 'switch show go tab pane ' + doc[0],
        title: 'Switch to the ' + doc[1] + ' tab',
        handler: function () { if (window.pbinSelectTab) window.pbinSelectTab(doc[0]); },
      });
    });
    if (shown('paneTabTrace')) {
      add({
        id: 'tab-trace', section: 'View', keywords: 'switch show go tab pane trace spans waterfall otel',
        title: 'Switch to the Trace tab',
        handler: function () { if (window.pbinSelectTab) window.pbinSelectTab('trace'); },
      });
    }
    if (shown('paneTabDebug')) {
      add({
        id: 'tab-debug', section: 'View', keywords: 'switch show go tab pane debug debugger breakpoints',
        title: 'Switch to the Debug tab',
        handler: function () { if (window.pbinSelectTab) window.pbinSelectTab('debug'); },
      });
    }
    var themes = themeChildren();
    add({
      id: 'theme', section: 'View', title: 'Change theme…',
      keywords: 'theme dark light system color mode',
      children: themes.map(function (c) { return c.id; }),
    });
    themes.forEach(add);

    // ---- Go to ----
    add({ id: 'go-new', section: 'Go to', title: 'New paste', keywords: 'new paste create fresh', handler: goTo('/') });
    add({ id: 'go-diff', section: 'Go to', title: 'Diff tool', keywords: 'diff compare', handler: goTo('/diff') });
    var snapshots = el('snapshotsButton');
    if (snapshots && snapshots.getAttribute('href')) {
      add({ id: 'go-history', section: 'Go to', title: 'Snapshot history', keywords: 'history snapshots versions', handler: goTo(snapshots.getAttribute('href')) });
    }
    var raw = el('rawButton');
    if (raw && raw.getAttribute('href')) {
      add({ id: 'go-raw', section: 'Go to', title: 'View raw text', keywords: 'raw plain text curl', handler: goTo(raw.getAttribute('href')) });
    }
    var htmlView = document.querySelector('a[href^="/html?id="]');
    if (htmlView) {
      add({ id: 'go-html', section: 'Go to', title: 'View rendered HTML', keywords: 'html markdown rendered preview', handler: goTo(htmlView.getAttribute('href')) });
    }

    return actions;
  }

  // ---- opening and closing ----------------------------------------------------

  function openPalette(parent) {
    if (!ninja) return;
    ninja.data = buildActions();
    ninja.open(parent ? { parent: parent } : {});
  }

  function togglePalette() {
    if (!ninja) return;
    if (ninja.visible) ninja.close();
    else openPalette();
  }

  // Capture-phase so the shortcut works everywhere: before Monaco's
  // keybinding service (which treats Ctrl/Cmd+K as a chord prefix) and
  // before ninja-keys' own hotkey (which ignores keystrokes coming from
  // inputs, Monaco's hidden textarea included). stopPropagation keeps the
  // two from both firing.
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
    }
  }, true);

  // The element is created once the CDN module has registered the custom
  // element; until then the toolbar button stays hidden and the shortcut is
  // a no-op (the palette degrades away like the page's other CDN features).
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('ninja-keys').then(function () {
      ninja = document.createElement('ninja-keys');
      ninja.placeholder = 'Type a command or search…';
      // our capture listener owns the shortcut; neutralize the built-in one
      ninja.openHotkey = '';
      document.body.appendChild(ninja);
      var button = el('commandMenuButton');
      if (button) button.classList.remove('hidden');
    });
  }

  window.PbinPalette = {
    open: openPalette,
    toggle: togglePalette,
    // the live catalog, for tests and console users
    actions: buildActions,
  };
})();
