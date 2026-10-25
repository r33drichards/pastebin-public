// Debugger panel (breakpoints, stepping, inspection) for Python and
// JavaScript runs.
//
// The page is cross-origin isolated (main.go sets COOP/COEP), so a worker
// can block on Atomics.wait while the main thread decides what to do next.
// A line tracer inside the language's worker — a sys.settrace hook in the
// Pyodide worker (static/js/pyodide-worker.js), Babel-instrumented hooks in
// the JavaScript debug worker (static/js/js-debug-worker.js) — pauses on
// breakpoint lines: it posts a JSON snapshot of the user stack and then
// waits on a SharedArrayBuffer until this controller stores a command
// (continue / step / evaluate / watches / history) and notifies. Both
// workers speak the same protocol, so this controller is shared.
//
// Features:
// - Breakpoints are Monaco glyph-margin decorations, toggled by clicking the
//   gutter or pressing F9, with an optional condition (right-click the
//   gutter) evaluated in the paused frame. The panel lists them with
//   enable/disable checkboxes; disabled breakpoints keep their place but are
//   not sent to the tracer. Remembered per paste in this browser (like the
//   Input tab's stdin) — not shared with the room.
// - While paused: call stack, per-frame variables (click a value to edit it
//   — assignments write through to the live frame), watch expressions
//   re-evaluated on every pause/frame switch, and an eval box.
// - Step back: the tracer records the last ~200 executed lines; the back /
//   forward buttons browse that history read-only, then return to live.
//
// code-runner.js integration: runPythonCode and runJavaScriptDebugCode call
// PbinDebug.prepareRun() and, if a session comes back, forward the worker's
// debug-* and stream messages to session.handleMessage and call
// session.end() when the run finishes. The worker terminators call
// PbinDebug.sessionEnded() so a cancelled worker tears the panel down too.

(function () {
  'use strict';

  // Commands stored in control[0]; control[1] is the byte length of the JSON
  // payload in the data buffer: the enabled breakpoints for resume commands,
  // {frame, code} for EVAL, {frame, exprs} for WATCHES, {index} for HISTORY.
  // Mirrored in pyodide-worker.js.
  const CMD = { CONTINUE: 1, STEP_OVER: 2, STEP_INTO: 3, STEP_OUT: 4, EVAL: 5, WATCHES: 6, HISTORY: 7, EXPAND: 8 };
  const DATA_BYTES = 64 * 1024;

  let ctx = null;             // {monaco, editor, pasteId, debugLang}
  let bps = [];               // [{id: decoration id, condition, enabled}]
  let watches = [];           // watch expression strings
  let lineDecorations = null; // the paused/history line highlight
  let session = null;         // the active debug run, or null
  let ui = null;              // cached panel elements
  let persistTimer = null;
  let runMode = 'plain';      // persistent 'plain' | 'debug' (the Run-mode toggle)
  let pauseOnException = false; // persistent: pause where an exception is thrown
  // Which expandable values are open, keyed by a stable name-path (e.g.
  // "v\0acc\0stack") rather than by the worker's ref ids — refs are
  // reassigned on every pause, but the path to a value is the same, so a
  // tree you opened stays open across continue/step. Lives at module scope
  // so it survives pauses (and runs).
  const expandedPaths = new Set();
  const PATH_SEP = '\u0000';

  // The paste's language when the debugger supports it ('python',
  // 'javascript'), else null; everything below gates on it.
  function debugLang() { return ctx ? ctx.debugLang() : null; }

  function bpStorageKey() { return 'pbin-bp-' + ctx.pasteId; }
  function watchStorageKey() { return 'pbin-watch-' + ctx.pasteId; }
  function runModeKey() { return 'pbin-runmode-' + ctx.pasteId; }
  function pauseExcKey() { return 'pbin-pauseexc-' + ctx.pasteId; }

  // ---- breakpoints -------------------------------------------------------------

  function bpLine(bp) {
    const model = ctx.editor.getModel();
    const range = model && model.getDecorationRange(bp.id);
    return range ? range.startLineNumber : null;
  }

  function decoOptions(bp) {
    let cls = 'pb-bp';
    let hover = 'Breakpoint — click to remove, right-click for a condition';
    if (!bp.enabled) {
      cls += ' pb-bp--off';
      hover = 'Disabled breakpoint — re-enable it in the debug panel list, click to remove';
    } else if (bp.condition) {
      cls += ' pb-bp--cond';
      hover = 'Breakpoint when `' + bp.condition + '` is truthy — click to remove, right-click to edit';
    }
    return {
      glyphMarginClassName: cls,
      glyphMarginHoverMessage: { value: hover },
      stickiness: ctx.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    };
  }

  function makeDecoration(line, bp) {
    return { range: new ctx.monaco.Range(line, 1, line, 1), options: decoOptions(bp) };
  }

  // The list, pruned of decorations that edits deleted, one per line.
  function breakpointList() {
    const byLine = new Map();
    const alive = [];
    for (const bp of bps) {
      const line = bpLine(bp);
      if (line === null || byLine.has(line)) {
        ctx.editor.deltaDecorations([bp.id], []);
        continue;
      }
      byLine.set(line, bp);
      alive.push(bp);
    }
    bps = alive;
    return Array.from(byLine, ([line, bp]) => ({ line, bp }))
      .sort((a, b) => a.line - b.line);
  }

  function findBpAt(line) {
    const hit = breakpointList().find((e) => e.line === line);
    return hit ? hit.bp : null;
  }

  // The payload the tracer sees: enabled breakpoints only.
  function enabledBreakpoints() {
    return breakpointList()
      .filter((e) => e.bp.enabled)
      .map((e) => ({ line: e.line, condition: e.bp.condition }));
  }

  // The config a resume command carries: the live breakpoints plus the
  // pause-on-exception flag, so both take effect on the next resume.
  function resumeConfig() {
    return { breakpoints: enabledBreakpoints(), pauseOnException: pauseOnException };
  }

  function breakpointsChanged() {
    renderBpList();
    updatePanelVisibility();
    schedulePersist();
  }

  function addBreakpoint(line, condition) {
    const bp = { id: null, condition: condition || null, enabled: true };
    bp.id = ctx.editor.deltaDecorations([], [makeDecoration(line, bp)])[0];
    bps.push(bp);
    breakpointsChanged();
  }

  function removeBreakpoint(bp) {
    ctx.editor.deltaDecorations([bp.id], []);
    bps = bps.filter((b) => b !== bp);
    breakpointsChanged();
  }

  function redecorate(bp) {
    const line = bpLine(bp);
    if (line === null) return;
    bp.id = ctx.editor.deltaDecorations([bp.id], [makeDecoration(line, bp)])[0];
  }

  function toggleBreakpoint(line, condition) {
    const model = ctx.editor.getModel();
    if (!model || line < 1 || line > model.getLineCount()) return;
    const bp = findBpAt(line);
    if (bp) removeBreakpoint(bp);
    else addBreakpoint(line, condition);
  }

  function setBreakpointEnabled(line, enabled) {
    const bp = findBpAt(line);
    if (!bp) return;
    bp.enabled = !!enabled;
    redecorate(bp);
    breakpointsChanged();
  }

  // Right-clicking the gutter prompts for a condition (empty clears it; the
  // breakpoint is created first if the line has none).
  function editCondition(line) {
    const bp = findBpAt(line);
    const current = (bp && bp.condition) || '';
    const input = prompt(
      'Pause at line ' + line + ' only when this expression (in the paste’s language) is truthy (leave empty to always pause):',
      current
    );
    if (input === null) return;
    const condition = input.trim() || null;
    if (!bp) {
      addBreakpoint(line, condition);
      return;
    }
    bp.condition = condition;
    if (!bp.enabled) bp.enabled = true;
    redecorate(bp);
    breakpointsChanged();
  }

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const stored = breakpointList().map((e) => ({ line: e.line, condition: e.bp.condition, enabled: e.bp.enabled }));
        window.pbinStorage.setItem(bpStorageKey(), JSON.stringify(stored));
      } catch (e) {}
      renderBpList();
    }, 400);
  }

  function restoreBreakpoints() {
    let stored = [];
    try { stored = JSON.parse(window.pbinStorage.getItem(bpStorageKey()) || '[]'); } catch (e) {}
    const model = ctx.editor.getModel();
    const max = model ? model.getLineCount() : 0;
    for (const entry of stored) {
      // Older versions stored plain line numbers.
      const line = typeof entry === 'number' ? entry : entry && entry.line;
      if (!Number.isInteger(line) || line < 1 || line > max) continue;
      if (findBpAt(line)) continue;
      const bp = {
        id: null,
        condition: (entry && entry.condition) || null,
        enabled: typeof entry === 'number' ? true : entry.enabled !== false,
      };
      bp.id = ctx.editor.deltaDecorations([], [makeDecoration(line, bp)])[0];
      bps.push(bp);
    }
    if (bps.length) breakpointsChanged();
  }

  // ---- Run-mode toggle (plain run vs run in the debugger) --------------------
  // A persistent choice (per paste) that decides what the Run button does.

  function restoreRunMode() {
    try {
      const saved = window.pbinStorage.getItem(runModeKey());
      runMode = saved === 'debug' ? 'debug' : 'plain';
    } catch (e) { runMode = 'plain'; }
  }

  // ---- pause-on-exception toggle (persistent per paste) ----------------------

  function restorePauseOnException() {
    try { pauseOnException = window.pbinStorage.getItem(pauseExcKey()) === 'on'; }
    catch (e) { pauseOnException = false; }
  }

  function updatePauseExcUi() {
    const box = document.getElementById('pbDbgPauseExc');
    if (box) box.checked = pauseOnException;
  }

  function setPauseOnException(on) {
    pauseOnException = !!on;
    try { window.pbinStorage.setItem(pauseExcKey(), pauseOnException ? 'on' : 'off'); } catch (e) {}
    updatePauseExcUi();
    // If a live run is sitting paused, the new value rides the next resume
    // (resumeConfig); nothing else to push now.
  }

  function updateRunModeUi() {
    const split = document.getElementById('pbRunSplit');
    const caret = document.getElementById('runMenuButton');
    const label = document.getElementById('runButtonLabel');
    const runBtn = document.getElementById('runButton');
    const show = !!debugLang();
    if (split) split.classList.toggle('has-menu', show);
    if (caret) caret.classList.toggle('hidden', !show);
    const debug = show && runMode === 'debug';
    if (label) label.textContent = debug ? 'Debug' : 'Run';
    if (runBtn) {
      runBtn.classList.toggle('is-debug', debug);
      runBtn.title = debug
        ? 'Run in the debugger (Ctrl/Cmd+Enter) — pauses at breakpoints, or the first line'
        : 'Run the code (Ctrl/Cmd+Enter)';
    }
    document.querySelectorAll('#runMenu [data-mode]').forEach((item) => {
      item.setAttribute('aria-checked', item.dataset.mode === runMode ? 'true' : 'false');
    });
  }

  function setRunMode(mode) {
    runMode = mode === 'debug' ? 'debug' : 'plain';
    try { window.pbinStorage.setItem(runModeKey(), runMode); } catch (e) {}
    updateRunModeUi();
    updatePanelVisibility();
  }

  function restoreWatches() {
    try {
      const stored = JSON.parse(window.pbinStorage.getItem(watchStorageKey()) || '[]');
      watches = stored.filter((w) => typeof w === 'string' && w.trim() !== '').slice(0, 20);
    } catch (e) { watches = []; }
  }

  function persistWatches() {
    try { window.pbinStorage.setItem(watchStorageKey(), JSON.stringify(watches)); } catch (e) {}
  }

  // ---- panel -----------------------------------------------------------------

  function els() {
    if (ui) return ui;
    ui = {
      panel: document.getElementById('pbDebug'),
      status: document.getElementById('pbDebugStatus'),
      cont: document.getElementById('pbDbgContinue'),
      over: document.getElementById('pbDbgOver'),
      into: document.getElementById('pbDbgInto'),
      out: document.getElementById('pbDbgOut'),
      back: document.getElementById('pbDbgBack'),
      fwd: document.getElementById('pbDbgFwd'),
      restart: document.getElementById('pbDbgRestart'),
      stop: document.getElementById('pbDbgStop'),
      bpList: document.getElementById('pbDbgBps'),
      stackBlock: document.getElementById('pbDbgStackBlock'),
      frames: document.getElementById('pbDbgFrames'),
      vars: document.getElementById('pbDbgVars'),
      watchList: document.getElementById('pbDbgWatches'),
      watchForm: document.getElementById('pbDbgWatchForm'),
      watchInput: document.getElementById('pbDbgWatchInput'),
      evalForm: document.getElementById('pbDbgEvalForm'),
      evalInput: document.getElementById('pbDbgEvalInput'),
      evalLog: document.getElementById('pbDbgEvalLog'),
      pauseExc: document.getElementById('pbDbgPauseExc'),
    };
    if (ui.pauseExc) ui.pauseExc.onchange = () => setPauseOnException(ui.pauseExc.checked);
    ui.cont.onclick = () => resume(CMD.CONTINUE);
    ui.over.onclick = () => resume(CMD.STEP_OVER);
    ui.into.onclick = () => resume(CMD.STEP_INTO);
    ui.out.onclick = () => resume(CMD.STEP_OUT);
    ui.back.onclick = stepBack;
    ui.fwd.onclick = stepForward;
    ui.restart.onclick = restart;
    ui.stop.onclick = () => { if (window.cancelExecution) window.cancelExecution(); };
    ui.evalForm.onsubmit = (e) => { e.preventDefault(); submitEval(); };
    ui.watchForm.onsubmit = (e) => {
      e.preventDefault();
      const expr = ui.watchInput.value.trim();
      if (expr) { addWatch(expr); ui.watchInput.value = ''; }
    };
    return ui;
  }

  function inHistory() { return !!(session && session.historyIndex !== null); }

  function setPausedUi(paused) {
    const u = els();
    [u.cont, u.over, u.into, u.out].forEach((b) => { b.disabled = !paused; });
    u.evalInput.disabled = !paused || inHistory();
    u.panel.classList.toggle('is-paused', paused);
    updateNavButtons();
  }

  function updateNavButtons() {
    const u = els();
    const len = (session && session.paused && session.state && session.state.historyLen) || 0;
    const idx = session ? session.historyIndex : null;
    u.back.disabled = !(len >= 2 && (idx === null || idx > 0));
    u.fwd.disabled = idx === null;
  }

  // The debugger is its own document in the editor-group tab system
  // (templates/paste.html); the tab only exists while there is something to
  // show, and a pause brings it on screen.
  function setTabVisible(show) {
    if (window.pbinSetDebugTabVisible) window.pbinSetDebugTabVisible(show);
  }

  function showPanel(statusText, paused) {
    const u = els();
    u.panel.classList.remove('hidden', 'is-idle');
    u.status.textContent = statusText;
    setPausedUi(paused);
    setTabVisible(true);
  }

  function hidePanel() {
    setTabVisible(false);
    if (!ui) return;
    ui.panel.classList.add('hidden');
    ui.panel.classList.remove('is-idle', 'is-paused');
    ui.frames.innerHTML = '';
    ui.vars.innerHTML = '';
    ui.evalLog.innerHTML = '';
    ui.evalInput.value = '';
  }

  // The debug tab is always available on debuggable pastes (Python,
  // JavaScript): with no run live it holds the breakpoint list and watches
  // (to edit between runs), even with no breakpoints set yet. It is hidden
  // on other languages.
  function updatePanelVisibility() {
    renderWatches();
    renderBpList();
    if (session || !ctx) return;
    if (debugLang()) {
      const u = els();
      u.panel.classList.remove('hidden');
      u.panel.classList.add('is-idle');
      u.panel.classList.remove('is-paused');
      const count = breakpointList().length;
      const bpText = count === 0 ? 'no breakpoints' : count + ' breakpoint' + (count === 1 ? '' : 's');
      u.status.textContent = runMode === 'debug'
        ? bpText + ' — Run is set to the debugger'
        : bpText + ' — switch Run to “run in debugger” to use them';
      setTabVisible(true);
    } else {
      hidePanel();
    }
  }

  function clearPausedLine() {
    if (lineDecorations) lineDecorations.clear();
  }

  function markPausedLine(line, history) {
    const monaco = ctx.monaco;
    lineDecorations.set([{
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: history ? 'pb-debug-line pb-debug-line--hist' : 'pb-debug-line',
        glyphMarginClassName: history ? 'pb-debug-arrow pb-debug-arrow--hist' : 'pb-debug-arrow',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }]);
    ctx.editor.revealLineInCenterIfOutsideViewport(line);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Flip every breakpoint on or off at once (the "all" toggle); a live run
  // picks the change up on the next resume, like any other list edit.
  function setAllBreakpoints(enabled) {
    let changed = false;
    for (const entry of breakpointList()) {
      if (entry.bp.enabled !== !!enabled) {
        entry.bp.enabled = !!enabled;
        redecorate(entry.bp);
        changed = true;
      }
    }
    if (changed) breakpointsChanged();
  }

  // Remove every breakpoint at once ("delete all").
  function removeAllBreakpoints() {
    if (!bps.length) return;
    ctx.editor.deltaDecorations(bps.map((b) => b.id), []);
    bps = [];
    breakpointsChanged();
  }

  function renderBpList() {
    if (!ctx) return;
    const u = els();
    const list = breakpointList();

    // Header controls: enable/disable all (toggles by current state) and
    // delete all. Both hidden when the list is empty.
    const toggle = document.getElementById('pbDbgBpsToggle');
    if (toggle) {
      toggle.classList.toggle('hidden', list.length === 0);
      const anyOff = list.some((e) => !e.bp.enabled);
      toggle.textContent = anyOff ? 'enable all' : 'disable all';
      toggle.onclick = () => setAllBreakpoints(anyOff);
    }
    const clear = document.getElementById('pbDbgBpsClear');
    if (clear) {
      clear.classList.toggle('hidden', list.length === 0);
      clear.onclick = removeAllBreakpoints;
    }

    u.bpList.innerHTML = '';
    if (list.length === 0) {
      u.bpList.innerHTML = '<li class="pb-debug-empty">none — click the gutter next to a line</li>';
      return;
    }
    for (const entry of list) {
      const li = document.createElement('li');
      li.className = 'pb-debug-bp' + (entry.bp.enabled ? '' : ' is-off');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = entry.bp.enabled;
      check.title = entry.bp.enabled ? 'Disable (keeps the breakpoint)' : 'Enable';
      check.setAttribute('aria-label', 'Breakpoint at line ' + entry.line + ' enabled');
      check.onchange = () => setBreakpointEnabled(entry.line, check.checked);

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'pb-debug-bp-label';
      label.textContent = 'line ' + entry.line + (entry.bp.condition ? ' when ' + entry.bp.condition : '');
      label.title = 'Go to line ' + entry.line + ' — right-click the gutter dot to edit the condition';
      label.onclick = () => {
        ctx.editor.revealLineInCenter(entry.line);
        ctx.editor.setPosition({ lineNumber: entry.line, column: 1 });
        ctx.editor.focus();
      };

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'pb-debug-bp-x';
      edit.textContent = '✎';
      edit.title = 'Edit the condition';
      edit.setAttribute('aria-label', 'Edit condition for breakpoint at line ' + entry.line);
      edit.onclick = () => editCondition(entry.line);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pb-debug-bp-x';
      remove.textContent = '×';
      remove.title = 'Remove the breakpoint';
      remove.setAttribute('aria-label', 'Remove breakpoint at line ' + entry.line);
      remove.onclick = () => removeBreakpoint(entry.bp);

      li.append(check, label, edit, remove);
      u.bpList.appendChild(li);
    }
  }

  // Click a value to rewrite the variable in the live frame (not in history
  // snapshots — those frames are gone).
  function startVarEdit(valueEl, name, current) {
    if (!session || !session.paused || inHistory() || valueEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'pb-debug-var-edit';
    input.value = current;
    input.setAttribute('aria-label', 'New value for ' + name);
    valueEl.textContent = '';
    valueEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const cancel = () => { if (!done) { done = true; renderState(session.state); } };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const expr = input.value.trim();
        done = true;
        if (!expr || expr === current) { renderState(session.state); return; }
        session.evalExpr = name + ' = ' + expr;
        sendQuery(CMD.EVAL, { frame: session.selectedFrame, code: name + ' = (' + expr + ')' });
      }
    };
    input.onblur = cancel;
  }

  function renderState(state, history) {
    const u = els();
    if (!history) session.state = state;
    if (session.selectedFrame >= state.frames.length) session.selectedFrame = 0;
    u.frames.innerHTML = '';
    state.frames.forEach((frame, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pb-debug-frame' + (i === session.selectedFrame ? ' is-active' : '');
      btn.textContent = frame.name + ' — line ' + frame.line;
      btn.onclick = () => {
        session.selectedFrame = i;
        renderState(history ? state : session.state, history);
        markPausedLine(frame.line, !!history);
        if (!history) requestWatches();
      };
      li.appendChild(btn);
      u.frames.appendChild(li);
    });
    const frame = state.frames[session.selectedFrame];
    u.vars.innerHTML = '';
    if (!frame || !frame.locals.length) {
      u.vars.innerHTML = '<div class="pb-debug-empty">no variables yet</div>';
    } else {
      // History snapshots carry no expand refs, so they render flat.
      renderVarRows(u.vars, frame.locals, 0, !history, 'v');
    }
    updateNavButtons();
  }

  // Copy a value to the clipboard, flashing a check on the button.
  function copyValue(text, btn) {
    const flash = (ok) => {
      const prev = btn.textContent;
      btn.textContent = ok ? '✓' : '✗';
      btn.classList.toggle('is-ok', ok);
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('is-ok'); }, 1200);
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        flash(ok);
      } catch (e) { flash(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flash(true), fallback);
    } else {
      fallback();
    }
  }

  // ---- expandable object introspection ---------------------------------------
  // Each expandable value carries a `ref`; expanding it asks the worker for
  // that object's children (lazily, one level at a time) and renders them
  // nested. Refs are valid only for the current pause, so what stays open is
  // tracked by `path` (a stable name-chain) and re-fetched each pause.

  function buildTwisty(entry, path) {
    const t = document.createElement('span');
    t.className = 'pb-debug-twisty';
    if (entry && entry.ref != null) {
      t.classList.add('is-toggle');
      const open = expandedPaths.has(path);
      t.textContent = open ? '▾' : '▸';
      t.title = open ? 'Collapse' : 'Expand';
      t.onclick = (e) => { e.stopPropagation(); toggleExpand(path, entry.ref); };
    }
    return t;
  }

  // Ask the worker for a ref's children once per pause (deduped): the paused
  // query protocol answers with a debug-expand message handled below.
  function requestExpand(ref) {
    if (!session || !session.paused || inHistory() || ref == null) return;
    if (session.childrenByRef[ref] || session.expandPending.has(ref)) return;
    session.expandPending.add(ref);
    sendQuery(CMD.EXPAND, { ref });
  }

  function buildCopy(text) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'pb-debug-bp-x pb-debug-copy';
    c.textContent = '⧉';
    c.title = 'Copy value to clipboard';
    c.setAttribute('aria-label', 'Copy value');
    c.onclick = (e) => { e.stopPropagation(); copyValue(text, c); };
    return c;
  }

  function toggleExpand(path, ref) {
    if (!session || !session.paused || inHistory()) return;
    if (expandedPaths.has(path)) {
      expandedPaths.delete(path);
    } else {
      expandedPaths.add(path);
      requestExpand(ref);
    }
    rerenderValues();
  }

  function rerenderValues() {
    if (session && session.state && session.paused && !inHistory()) renderState(session.state);
    renderWatches();
  }

  // Render variable rows (name / value / copy), with a disclosure twisty for
  // expandable values and their fetched children indented beneath. editable
  // makes the top level's values click-to-edit (live locals only). parentPath
  // is the stable name-path of the container (e.g. "v" for a frame's locals,
  // or a value's own path for its children), extended by each row's name.
  function renderVarRows(container, entries, depth, editable, parentPath) {
    for (const v of entries) {
      const path = parentPath + PATH_SEP + v.n;
      const row = document.createElement('div');
      row.className = 'pb-debug-var';
      if (depth) row.style.paddingLeft = (depth * 12) + 'px';
      row.appendChild(buildTwisty(v, path));

      const name = document.createElement('span');
      name.className = 'pb-debug-var-name';
      name.textContent = v.n;

      const value = document.createElement('span');
      value.className = 'pb-debug-var-value';
      value.textContent = v.v;
      value.title = v.t || '';
      if (editable && depth === 0) {
        value.classList.add('is-editable');
        value.title = (v.t || '') + ' — click to set a new value';
        value.onclick = () => startVarEdit(value, v.n, v.v);
      }

      row.append(name, value, buildCopy(v.v));
      container.appendChild(row);

      if (v.ref != null && expandedPaths.has(path)) {
        const kids = session.childrenByRef[v.ref];
        if (kids) {
          renderVarRows(container, kids, depth + 1, false, path);
        } else {
          // Still open from a previous pause: re-fetch this ref's children.
          requestExpand(v.ref);
          const loading = document.createElement('div');
          loading.className = 'pb-debug-var pb-debug-empty';
          loading.style.paddingLeft = ((depth + 1) * 12) + 'px';
          loading.textContent = 'expanding…';
          container.appendChild(loading);
        }
      }
    }
  }

  // Click a watch's expression to rewrite it in place; Enter saves (an empty
  // value removes it), Escape cancels.
  function startWatchEdit(nameEl, index) {
    if (nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'pb-debug-var-edit';
    input.value = watches[index];
    input.setAttribute('aria-label', 'Edit watch expression');
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const cancel = () => { if (!done) { done = true; renderWatches(); } };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        done = true;
        const expr = input.value.trim();
        if (!expr) watches.splice(index, 1);
        else watches[index] = expr;
        persistWatches();
        renderWatches();
        requestWatches();
      }
    };
    input.onblur = cancel;
  }

  function renderWatches() {
    if (!ui && !ctx) return;
    const u = els();
    u.watchList.innerHTML = '';
    const values = (session && session.watchValues) || {};
    watches.forEach((expr, i) => {
      const got = values[expr];
      const watchPath = 'w' + PATH_SEP + expr;
      const row = document.createElement('div');
      row.className = 'pb-debug-watch';
      row.appendChild(buildTwisty(got || {}, watchPath));

      const name = document.createElement('span');
      name.className = 'pb-debug-var-name is-editable';
      name.textContent = expr;
      name.title = expr + ' — click to edit';
      name.onclick = () => startWatchEdit(name, i);
      const value = document.createElement('span');
      value.className = 'pb-debug-var-value' + (got && !got.ok ? ' is-err' : '');
      value.textContent = got ? got.v : (session && session.paused ? '…' : '—');

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'pb-debug-bp-x pb-debug-copy';
      copy.textContent = '⧉';
      copy.title = 'Copy value to clipboard';
      copy.setAttribute('aria-label', 'Copy value of ' + expr);
      copy.disabled = !got;
      copy.onclick = () => { if (got) copyValue(got.v, copy); };

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pb-debug-bp-x';
      remove.textContent = '×';
      remove.title = 'Remove the watch';
      remove.setAttribute('aria-label', 'Remove watch ' + expr);
      remove.onclick = () => {
        watches.splice(i, 1);
        persistWatches();
        renderWatches();
      };
      row.append(name, value, copy, remove);
      u.watchList.appendChild(row);

      // Expanded children of a complex watch value, nested beneath it.
      if (got && got.ref != null && expandedPaths.has(watchPath)) {
        const kids = session.childrenByRef[got.ref];
        if (kids) {
          renderVarRows(u.watchList, kids, 1, false, watchPath);
        } else {
          requestExpand(got.ref);
          const loading = document.createElement('div');
          loading.className = 'pb-debug-var pb-debug-empty';
          loading.style.paddingLeft = '12px';
          loading.textContent = 'expanding…';
          u.watchList.appendChild(loading);
        }
      }
    });
  }

  function addWatch(expr) {
    if (watches.includes(expr) || watches.length >= 20) return;
    watches.push(expr);
    persistWatches();
    renderWatches();
    requestWatches();
  }

  function appendEvalLog(expr, value, ok) {
    const u = els();
    const row = document.createElement('div');
    row.className = 'pb-debug-evalrow' + (ok ? '' : ' is-err');
    const q = document.createElement('span');
    q.className = 'pb-debug-evalexpr';
    q.textContent = expr;
    const a = document.createElement('span');
    a.textContent = '→ ' + value;
    row.appendChild(q);
    row.appendChild(a);
    u.evalLog.prepend(row);
    while (u.evalLog.children.length > 20) u.evalLog.lastChild.remove();
  }

  // ---- session ----------------------------------------------------------------

  function sendCommand(cmd, payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.length > DATA_BYTES) return false;
    session.data.set(bytes, 0);
    Atomics.store(session.ctrl, 1, bytes.length);
    Atomics.store(session.ctrl, 0, cmd);
    Atomics.notify(session.ctrl, 0);
    return true;
  }

  // EVAL/WATCHES/HISTORY expect an answer; send one at a time so a response
  // is never paired with the wrong request. Resume commands skip the queue —
  // the worker drains the pending answer first, then resumes.
  function sendQuery(cmd, payload) {
    if (!session || !session.paused) return;
    if (session.queryBusy) {
      session.queryQueue.push([cmd, payload]);
      return;
    }
    session.queryBusy = true;
    sendCommand(cmd, payload);
  }

  function queryDone() {
    if (!session) return;
    session.queryBusy = false;
    const next = session.queryQueue.shift();
    if (next && session.paused) {
      session.queryBusy = true;
      sendCommand(next[0], next[1]);
    }
  }

  function requestWatches() {
    if (!session || !session.paused || inHistory() || !watches.length) return;
    sendQuery(CMD.WATCHES, { frame: session.selectedFrame, exprs: watches.slice() });
  }

  function resume(cmd) {
    if (!session || !session.paused) return;
    session.paused = false;
    session.historyIndex = null;
    session.queryQueue = [];
    setPausedUi(false);
    els().status.textContent = 'running…';
    clearPausedLine();
    // Every resume carries the live config (breakpoints + pause-on-exception),
    // so list toggles, gutter clicks and the exception toggle made while
    // paused take effect.
    sendCommand(cmd, resumeConfig());
  }

  // Restart: tear down the current debug run and start a fresh one from the
  // beginning. Deferred so the cancelled run's teardown settles before the
  // new run starts (avoids the two runs racing over executionState).
  function restart() {
    if (!session) return;
    setRunMode('debug');   // a restart always re-runs under the debugger
    if (window.cancelExecution) window.cancelExecution();
    setTimeout(() => { if (window.runCode) window.runCode(); }, 0);
  }

  function stepBack() {
    if (!session || !session.paused) return;
    const len = (session.state && session.state.historyLen) || 0;
    const target = session.historyIndex === null ? len - 2 : session.historyIndex - 1;
    if (target < 0 || len < 2) return;
    sendQuery(CMD.HISTORY, { index: target });
  }

  function stepForward() {
    if (!session || !session.paused || session.historyIndex === null) return;
    const len = (session.state && session.state.historyLen) || 0;
    const target = session.historyIndex + 1;
    if (target >= len - 1) exitHistory();
    else sendQuery(CMD.HISTORY, { index: target });
  }

  function exitHistory() {
    if (!session || session.historyIndex === null) return;
    session.historyIndex = null;
    els().status.textContent = 'paused at line ' + session.state.line;
    renderState(session.state);
    markPausedLine(session.state.line, false);
    els().evalInput.disabled = false;
    requestWatches();
  }

  function submitEval() {
    const u = els();
    const code = u.evalInput.value.trim();
    if (!code || !session || !session.paused || inHistory() || session.evalBusy) return;
    session.evalBusy = true;
    session.evalExpr = code;
    u.evalInput.disabled = true;
    sendQuery(CMD.EVAL, { frame: session.selectedFrame, code });
  }

  function onStream(msg) {
    if (!session.outputEl) return;
    if (!session.streamPre) {
      session.outputEl.innerHTML =
        '<div class="text-green-600 font-bold">Output (live):</div><pre class="whitespace-pre-wrap"></pre>';
      session.streamPre = session.outputEl.querySelector('pre');
    }
    session.streamPre.append(msg.text);
  }

  function handleMessage(msg) {
    if (!session) return false;
    switch (msg.type) {
      case 'stream':
        onStream(msg);
        return true;
      case 'debug-paused': {
        let state;
        try { state = JSON.parse(msg.state); } catch (e) { return true; }
        session.paused = true;
        session.selectedFrame = 0;
        session.historyIndex = null;
        session.queryBusy = false;
        session.queryQueue = [];
        session.watchValues = {};
        // Expand refs are only valid for this pause; the open paths persist
        // (renderVarRows re-fetches their children below).
        session.childrenByRef = {};
        session.expandPending = new Set();
        showPanel('paused at line ' + state.line, true);
        if (window.pbinRevealDebug) window.pbinRevealDebug();
        renderState(state);
        renderWatches();
        markPausedLine(state.line, false);
        if (state.note) appendEvalLog('breakpoint', state.note, false);
        requestWatches();
        els().evalInput.focus();
        return true;
      }
      case 'debug-eval': {
        let payload;
        try { payload = JSON.parse(msg.payload); } catch (e) { payload = { ok: false, value: 'bad response' }; }
        queryDone();
        session.evalBusy = false;
        const u = els();
        u.evalInput.disabled = !session.paused || inHistory();
        appendEvalLog(session.evalExpr || '', payload.value, payload.ok);
        if (payload.ok) u.evalInput.value = '';
        if (payload.state && session.paused && !inHistory()) {
          // A mutation may change children already expanded; reload them
          // (the open paths stay, so renderState re-fetches).
          session.childrenByRef = {};
          session.expandPending = new Set();
          renderState(payload.state);
          // A mutation may change what the watches see.
          requestWatches();
        }
        if (session.paused && !inHistory()) u.evalInput.focus();
        return true;
      }
      case 'debug-expand': {
        let payload;
        try { payload = JSON.parse(msg.payload); } catch (e) { payload = null; }
        queryDone();
        if (payload && payload.ref != null) {
          session.expandPending.delete(payload.ref);
          session.childrenByRef[payload.ref] = payload.expired ? [] : (payload.children || []);
        }
        rerenderValues();
        return true;
      }
      case 'debug-watches': {
        let payload;
        try { payload = JSON.parse(msg.payload); } catch (e) { payload = { values: [] }; }
        queryDone();
        session.watchValues = {};
        for (const v of payload.values || []) session.watchValues[v.e] = v;
        renderWatches();
        return true;
      }
      case 'debug-history': {
        let payload;
        try { payload = JSON.parse(msg.payload); } catch (e) { payload = null; }
        queryDone();
        if (!payload || !payload.state || !session.paused) return true;
        session.historyIndex = payload.index;
        if (session.state) session.state.historyLen = payload.len;
        els().status.textContent =
          'history ' + (payload.index + 1) + '/' + payload.len + ' — line ' + payload.state.line + ' (read-only)';
        els().evalInput.disabled = true;
        renderState(payload.state, true);
        markPausedLine(payload.state.line, true);
        return true;
      }
      case 'debug-resumed':
        session.paused = false;
        return true;
      default:
        return false;
    }
  }

  function endSession() {
    if (!session) return;
    session = null;
    clearPausedLine();
    if (ui) {
      ui.frames.innerHTML = '';
      ui.vars.innerHTML = '';
      ui.evalInput.value = '';
    }
    // Transition straight to the idle view (or hide on other languages) without
    // toggling the tab off and back on, which would collapse the split and
    // drop the debugger pane off screen.
    updatePanelVisibility();
  }

  function prepareRun() {
    if (!ctx || session) return null;
    // The Run-mode toggle decides: "run" never attaches the debugger (even
    // with breakpoints set); "run in debugger" always does, pausing at a
    // breakpoint or, when there are none, at the first line.
    if (runMode !== 'debug') return null;
    const breakpoints = enabledBreakpoints();
    // With no breakpoints we pause on the first line so a program can be
    // stepped from the start — unless pause-on-exception is on, where the
    // intent is "run until it throws", so let it run.
    const breakOnEntry = breakpoints.length === 0 && !pauseOnException;
    if (typeof SharedArrayBuffer === 'undefined' || !window.crossOriginIsolated) {
      console.warn('pbin: the debugger needs cross-origin isolation (SharedArrayBuffer); running without it');
      return null;
    }
    const controlBuffer = new SharedArrayBuffer(8);
    const dataBuffer = new SharedArrayBuffer(DATA_BYTES);
    session = {
      lang: debugLang(),
      ctrl: new Int32Array(controlBuffer),
      data: new Uint8Array(dataBuffer),
      paused: false,
      evalBusy: false,
      queryBusy: false,
      queryQueue: [],
      selectedFrame: 0,
      historyIndex: null,
      watchValues: {},
      expandPending: new Set(),
      childrenByRef: {},
      state: null,
      outputEl: null,
      streamPre: null,
      workerConfig: { breakpoints, breakOnEntry, pauseOnException, controlBuffer, dataBuffer },
      handleMessage,
      attachOutput(el) { session.outputEl = el; },
      end: endSession,
    };
    const pausesOn = breakpoints.length
      ? 'a breakpoint' + (pauseOnException ? ' or an exception' : '')
      : (pauseOnException ? 'an exception' : 'the first line');
    showPanel('running… (pauses at ' + pausesOn + ')', false);
    renderBpList();
    renderWatches();
    return session;
  }

  // ---- wiring -----------------------------------------------------------------

  function init(options) {
    ctx = options;
    const monaco = ctx.monaco;
    lineDecorations = ctx.editor.createDecorationsCollection();
    restoreWatches();
    restoreBreakpoints();
    restorePauseOnException();
    updatePauseExcUi();
    updatePanelVisibility();

    // Click in the glyph margin toggles a breakpoint; right-click edits its
    // condition (debuggable pastes only).
    ctx.editor.onMouseDown((e) => {
      if (!e.target || e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      if (!debugLang() || !e.target.position) return;
      if (e.event.rightButton) return; // handled by onContextMenu
      toggleBreakpoint(e.target.position.lineNumber);
    });
    ctx.editor.onContextMenu((e) => {
      if (!e.target || e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      if (!debugLang() || !e.target.position) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      editCondition(e.target.position.lineNumber);
    });

    // F9 toggles a breakpoint on the cursor's line, like VS Code.
    ctx.editor.addCommand(monaco.KeyCode.F9, () => {
      if (!debugLang()) return;
      const pos = ctx.editor.getPosition();
      if (pos) toggleBreakpoint(pos.lineNumber);
    });

    // Edits move the decorations; keep the stored lines and the list in step.
    ctx.editor.onDidChangeModelContent(schedulePersist);

    // The Run caret: a persistent toggle between a plain run and a debugger
    // run. The chosen mode sticks (per paste) and is what the Run button does.
    restoreRunMode();
    const runMenuButton = document.getElementById('runMenuButton');
    const runMenu = document.getElementById('runMenu');
    function closeRunMenu() {
      if (!runMenu || runMenu.classList.contains('hidden')) return;
      runMenu.classList.add('hidden');
      runMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (runMenuButton && runMenu) {
      runMenuButton.onclick = (e) => {
        e.stopPropagation();
        if (!runMenu.classList.contains('hidden')) { closeRunMenu(); return; }
        const rect = runMenuButton.getBoundingClientRect();
        runMenu.style.left = Math.max(8, rect.right - 280) + 'px';
        runMenu.style.top = rect.bottom + 6 + 'px';
        runMenu.classList.remove('hidden');
        runMenuButton.setAttribute('aria-expanded', 'true');
      };
      runMenu.querySelectorAll('[data-mode]').forEach((item) => {
        item.onclick = () => { closeRunMenu(); setRunMode(item.dataset.mode); };
      });
      document.addEventListener('click', (e) => {
        if (!runMenu.contains(e.target) && e.target !== runMenuButton) closeRunMenu();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRunMenu(); });
    }
    updateRunModeUi();

    // The language picker can switch away from a debuggable language; the
    // debug tab and the Run caret follow.
    const languageSelect = document.getElementById('languageSelect');
    if (languageSelect) {
      languageSelect.addEventListener('change', () => {
        updatePanelVisibility();
        updateRunModeUi();
      });
    }

    renderBpList();
    renderWatches();

    // Stepping shortcuts while paused: F8 continue, F10 over, F11 into,
    // Shift+F11 out.
    document.addEventListener('keydown', (e) => {
      if (!session || !session.paused) return;
      if (e.key === 'F8') { e.preventDefault(); resume(CMD.CONTINUE); }
      else if (e.key === 'F10') { e.preventDefault(); resume(CMD.STEP_OVER); }
      else if (e.key === 'F11' && e.shiftKey) { e.preventDefault(); resume(CMD.STEP_OUT); }
      else if (e.key === 'F11') { e.preventDefault(); resume(CMD.STEP_INTO); }
    });
  }

  window.PbinDebug = {
    init,
    prepareRun,
    toggleBreakpoint,
    setBreakpointEnabled,
    setAllBreakpoints,
    addWatch,
    setRunMode: (mode) => setRunMode(mode),
    getRunMode: () => runMode,
    setPauseOnException: (on) => setPauseOnException(on),
    getPauseOnException: () => pauseOnException,
    getBreakpoints: enabledBreakpoints,
    sessionEnded: endSession,
    isPaused: () => !!(session && session.paused),
  };
  // The name the panel grew up under; e2e tests and console users may still
  // reach for it.
  window.PbinPyDebug = window.PbinDebug;
})();
