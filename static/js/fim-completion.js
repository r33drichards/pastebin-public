// AI tab completion for the room editor.
//
// Registers a Monaco inline completions provider that shows grey ghost text
// after the cursor, accepted with Tab. Suggestions come from POST /complete
// (see complete.go), which runs Qwen2.5-Coder-0.5B as a fill-in-the-middle
// model: the text before and after the cursor is sent, the predicted middle
// comes back.
//
// Prior art: Monaco's inline completions API (microsoft/monaco-editor
// discussion #3917), monacopilot, ghostline, and llama.cpp's /infill server.
(function (global) {
  'use strict';

  var DEBOUNCE_MS = 300;        // wait for a typing pause before asking
  var MAX_DOC_LENGTH = 200000;  // skip huge documents entirely

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // start({ monaco, editor, isEnabled, onAvailable }) probes GET /complete
  // and, when the server has a completion provider configured, registers the
  // Monaco inline completions provider. isEnabled() lets the page gate
  // suggestions (e.g. only while the room is editable, or while the user has
  // AI completions switched on); onAvailable() fires once when the backend is
  // confirmed, so the page can reveal a toggle control.
  function start(opts) {
    var monaco = opts.monaco;
    var editor = opts.editor;
    var endpoint = opts.endpoint || '/complete';
    var isEnabled = opts.isEnabled || function () { return true; };
    var onAvailable = opts.onAvailable || function () {};

    // One in-flight request at a time; newer keystrokes abort older fetches.
    var inflight = null;
    // Remember the last answer so re-rendering at the same spot is free.
    var lastKey = null;
    var lastCompletion = null;

    fetch(endpoint)
      .then(function (r) { return r.json(); })
      .then(function (cfg) { if (cfg && cfg.enabled) { register(); onAvailable(); } })
      .catch(function () { /* no completion backend: stay quiet */ });

    function register() {
      editor.updateOptions({ inlineSuggest: { enabled: true } });
      monaco.languages.registerInlineCompletionsProvider('*', {
        provideInlineCompletions: function (model, position, context, token) {
          return provide(model, position, token);
        },
        freeInlineCompletions: function () {}
      });
    }

    function provide(model, position, token) {
      var empty = { items: [] };
      if (!isEnabled() || editor.getOption(monaco.editor.EditorOption.readOnly)) {
        return empty;
      }
      if (model.getValueLength() > MAX_DOC_LENGTH) return empty;

      var text = model.getValue();
      var offset = model.getOffsetAt(position);
      var prefix = text.slice(0, offset);
      var suffix = text.slice(offset);
      if (prefix.trim() === '' && suffix.trim() === '') return empty;

      var key = prefix + '\u0000' + suffix;
      if (key === lastKey && lastCompletion) {
        return { items: [item(lastCompletion, position)] };
      }

      return sleep(DEBOUNCE_MS).then(function () {
        if (token.isCancellationRequested) return empty;

        if (inflight) inflight.abort();
        var controller = new AbortController();
        inflight = controller;
        token.onCancellationRequested(function () { controller.abort(); });

        return fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: prefix, suffix: suffix }),
          signal: controller.signal
        }).then(function (resp) {
          if (!resp.ok) return empty;
          return resp.json().then(function (data) {
            var completion = (data && data.completion) || '';
            // A whitespace-only suggestion is noise, not help.
            if (completion.trim() === '') return empty;
            lastKey = key;
            lastCompletion = completion;
            if (token.isCancellationRequested) return empty;
            return { items: [item(completion, position)] };
          });
        }).catch(function () {
          return empty; // aborted or network error: just no ghost text
        });
      });
    }

    function item(completion, position) {
      return {
        // Monaco 0.26 reads `text`; later versions read `insertText`.
        text: completion,
        insertText: completion,
        range: new monaco.Range(
          position.lineNumber, position.column,
          position.lineNumber, position.column
        )
      };
    }
  }

  global.PbinFim = { start: start };
})(window);
