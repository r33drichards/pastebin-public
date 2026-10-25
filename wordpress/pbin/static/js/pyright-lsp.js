// Real Python language support: basedpyright running in a web worker.
//
// browser-basedpyright is a build of the basedpyright language server
// (a maintained pyright fork, MIT) that runs entirely in the browser with
// typeshed embedded — the same artifact that powers basedpyright's
// playground. It speaks ordinary LSP (JSON-RPC objects over postMessage,
// no Content-Length framing), so a small hand-rolled client is enough; no
// monaco-languageclient or bundler required. This file maps LSP onto stock
// Monaco provider APIs: diagnostics (markers), completions with resolve,
// hovers, signature help, go-to-definition (plus type definition,
// declaration and implementation), references, document highlights,
// document symbols, rename, inlay hints, semantic tokens, and code
// actions (quick fixes and organize imports).
//
// The worker script (~3.2 MB gzipped, ~18 MB parsed) is fetched lazily from
// jsDelivr the first time a paste is in Python, via a Blob URL because
// cross-origin worker scripts can't be loaded directly. The bundle uses no
// importScripts, so a Blob URL is safe. Prior art: the basedpyright
// playground's LspClient.ts / MonacoEditor.tsx.
(function (global) {
  'use strict';

  var VERSION = '1.40.2';
  var WORKER_URL = 'https://cdn.jsdelivr.net/npm/browser-basedpyright@' + VERSION + '/dist/pyright.worker.js';
  var ROOT = '/src/';
  var FILE = ROOT + 'Untitled.py';
  var URI = 'file://' + FILE;
  var DEBOUNCE_MS = 150;

  // LSP CompletionItemKind (1-based) → monaco CompletionItemKind.
  function completionKind(monaco, k) {
    var K = monaco.languages.CompletionItemKind;
    return [null, K.Text, K.Method, K.Function, K.Constructor, K.Field,
      K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit,
      K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference,
      K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator,
      K.TypeParameter][k] || K.Text;
  }

  function markerSeverity(monaco, s) {
    var S = monaco.MarkerSeverity;
    return [null, S.Error, S.Warning, S.Info, S.Hint][s] || S.Info;
  }

  // LSP ranges are 0-based, Monaco's 1-based.
  function toMonacoRange(r) {
    return {
      startLineNumber: r.start.line + 1,
      startColumn: r.start.character + 1,
      endLineNumber: r.end.line + 1,
      endColumn: r.end.character + 1
    };
  }

  function toLspPosition(position) {
    return { line: position.lineNumber - 1, character: position.column - 1 };
  }

  function toLspRange(range) {
    return {
      start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
      end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
    };
  }

  function hoverText(contents) {
    if (!contents) return '';
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) return contents.map(hoverText).join('\n\n');
    return contents.value || '';
  }

  function start(opts) {
    var monaco = opts.monaco;
    var editor = opts.editor;
    var api = { state: 'idle' };
    global.PbinPyright.session = api;

    var state = 'idle'; // idle → starting → ready | failed
    function setState(s) { state = s; api.state = s; }
    var worker = null;
    var blobUrl = null;
    var nextId = 1;
    var pending = {};
    var docVersion = 1;
    var backgroundCount = 0;
    var changeTimer = null;
    var semanticLegend = null; // from the server's initialize result

    function isPython() {
      var model = editor.getModel();
      return !!model && model.getLanguageId() === 'python';
    }

    function request(method, params) {
      return new Promise(function (resolve, reject) {
        if (!worker) return reject(new Error('pyright worker gone'));
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        worker.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params });
      });
    }

    function notify(method, params) {
      if (worker) worker.postMessage({ jsonrpc: '2.0', method: method, params: params });
    }
    // Console/debugging and e2e-test handle for raw LSP requests.
    api.request = request;

    // The text edits a WorkspaceEdit holds for the paste, whichever of the
    // two shapes (changes / documentChanges) the server used.
    function workspaceEditTextEdits(edit) {
      var textEdits = (edit && edit.changes && edit.changes[URI]) || [];
      ((edit && edit.documentChanges) || []).forEach(function (change) {
        if (change.textDocument && change.textDocument.uri === URI) {
          textEdits = textEdits.concat(change.edits || []);
        }
      });
      return textEdits;
    }

    // Applies a server-sent WorkspaceEdit (workspace/applyEdit) to the
    // paste as a regular edit, so undo and the collab room both see it.
    function applyWorkspaceEdit(edit) {
      var model = editor.getModel();
      var textEdits = workspaceEditTextEdits(edit);
      if (!model || !textEdits.length) return false;
      model.pushEditOperations([], textEdits.map(function (e) {
        return { range: toMonacoRange(e.range), text: e.newText };
      }), function () { return null; });
      return true;
    }

    function onDiagnostics(params) {
      var model = editor.getModel();
      if (!model || !isPython()) return;
      var markers = (params.diagnostics || []).map(function (d) {
        var range = toMonacoRange(d.range);
        return {
          severity: markerSeverity(monaco, d.severity),
          message: d.message,
          code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : undefined),
          source: d.source || 'basedpyright',
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: range.endLineNumber,
          endColumn: range.endColumn,
          tags: (d.tags || []).map(function (t) {
            return t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated;
          })
        };
      });
      monaco.editor.setModelMarkers(model, 'basedpyright', markers);
    }

    function onWorkerMessage(e) {
      var m = e.data;
      if (!m) return;
      // The foreground worker asks the page to spawn its background threads.
      if (m.type === 'browser/newWorker') {
        var b = new Worker(blobUrl, { name: 'Pyright-background-' + (++backgroundCount) });
        b.postMessage(
          { type: 'browser/boot', mode: 'background', initialData: m.initialData, port: m.port },
          [m.port]
        );
        return;
      }
      if (m.jsonrpc !== '2.0') return;
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        var p = pending[m.id];
        if (p) {
          delete pending[m.id];
          if (m.error) p.reject(new Error(m.error.message || 'LSP error'));
          else p.resolve(m.result);
        }
        return;
      }
      if (m.method === 'textDocument/publishDiagnostics') {
        onDiagnostics(m.params || {});
      } else if (m.id !== undefined) {
        // Server→client requests. workspace/applyEdit carries the result of
        // an executed command (e.g. organize imports); workspace/configuration
        // wants an array; anything else is satisfied by null.
        var result = null;
        if (m.method === 'workspace/applyEdit') {
          result = { applied: applyWorkspaceEdit(m.params && m.params.edit) };
        } else if (m.method === 'workspace/configuration') {
          result = [];
        }
        worker.postMessage({ jsonrpc: '2.0', id: m.id, result: result });
      }
    }

    function boot() {
      if (state !== 'idle') return;
      setState('starting');
      fetch(WORKER_URL)
        .then(function (r) {
          if (!r.ok) throw new Error('fetch ' + r.status);
          return r.text();
        })
        .then(function (code) {
          blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          worker = new Worker(blobUrl, { name: 'Pyright-foreground' });
          worker.onmessage = onWorkerMessage;
          worker.postMessage({ type: 'browser/boot', mode: 'foreground' });
          var text = editor.getValue();
          return request('initialize', {
            processId: 1,
            rootPath: ROOT,
            rootUri: 'file://' + ROOT,
            capabilities: {
              textDocument: {
                publishDiagnostics: { tagSupport: { valueSet: [1, 2] }, versionSupport: true },
                hover: { contentFormat: ['markdown', 'plaintext'] },
                signatureHelp: {},
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                codeAction: {
                  codeActionLiteralSupport: {
                    codeActionKind: {
                      valueSet: ['quickfix', 'source', 'source.organizeImports', 'source.fixAll']
                    }
                  }
                }
              }
            },
            initializationOptions: {
              files: (function () {
                var files = {};
                files[FILE] = text;
                // "basic" keeps a pastebin's diagnostics helpful, not pedantic.
                files[ROOT + 'pyrightconfig.json'] = JSON.stringify({ typeCheckingMode: 'basic' });
                return files;
              })()
            }
          }).then(function (init) {
            var tokensProvider = init && init.capabilities && init.capabilities.semanticTokensProvider;
            semanticLegend = (tokensProvider && tokensProvider.legend) || null;
            notify('initialized', {});
            notify('workspace/didChangeConfiguration', { settings: {} });
            notify('textDocument/didOpen', {
              textDocument: { uri: URI, languageId: 'python', version: docVersion, text: text }
            });
            setState('ready');
            // The keyword word list is noise once real completions exist;
            // PbinLSP keeps serving its snippets.
            if (global.PbinLSP && global.PbinLSP.claim) global.PbinLSP.claim('python');
          });
        })
        .catch(function (err) {
          setState('failed'); // no retry loop: stay quiet like the FIM client
          if (global.console && console.warn) console.warn('basedpyright unavailable:', err);
        });
    }

    function syncDocument() {
      if (state !== 'ready' || !isPython()) return;
      notify('textDocument/didChange', {
        textDocument: { uri: URI, version: ++docVersion },
        contentChanges: [{ text: editor.getValue() }]
      });
    }

    editor.onDidChangeModelContent(function () {
      if (state !== 'ready' || !isPython()) return;
      clearTimeout(changeTimer);
      changeTimer = setTimeout(syncDocument, DEBOUNCE_MS);
    });

    function onLanguage() {
      if (isPython()) {
        if (state === 'idle') boot();
        else if (state === 'ready') syncDocument();
      } else if (editor.getModel()) {
        monaco.editor.setModelMarkers(editor.getModel(), 'basedpyright', []);
      }
    }
    editor.onDidChangeModelLanguage(onLanguage);
    onLanguage();

    function ready() { return state === 'ready' && isPython(); }

    monaco.languages.registerCompletionItemProvider('python', {
      triggerCharacters: ['.', '[', '"', "'"],
      provideCompletionItems: function (model, position) {
        if (!ready()) return { suggestions: [] };
        syncDocument();
        return request('textDocument/completion', {
          textDocument: { uri: URI },
          position: toLspPosition(position)
        }).then(function (result) {
          var items = (result && (result.items || result)) || [];
          var word = model.getWordUntilPosition(position);
          var defaultRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          };
          return {
            incomplete: !!(result && result.isIncomplete),
            suggestions: items.map(function (item) {
              var edit = item.textEdit;
              return {
                label: item.label,
                kind: completionKind(monaco, item.kind),
                detail: item.detail,
                sortText: item.sortText,
                filterText: item.filterText,
                insertText: (edit && edit.newText) || item.insertText || item.label,
                insertTextRules: item.insertTextFormat === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
                range: edit && (edit.range || edit.insert) ? toMonacoRange(edit.range || edit.insert) : defaultRange,
                _lsp: item
              };
            })
          };
        }).catch(function () { return { suggestions: [] }; });
      },
      resolveCompletionItem: function (item) {
        if (!item._lsp || state !== 'ready') return item;
        return request('completionItem/resolve', item._lsp).then(function (resolved) {
          if (resolved && resolved.documentation) {
            item.documentation = { value: hoverText(resolved.documentation) };
          }
          if (resolved && resolved.detail) item.detail = resolved.detail;
          return item;
        }).catch(function () { return item; });
      }
    });

    monaco.languages.registerHoverProvider('python', {
      provideHover: function (model, position) {
        if (!ready()) return null;
        return request('textDocument/hover', {
          textDocument: { uri: URI },
          position: toLspPosition(position)
        }).then(function (result) {
          if (!result || !result.contents) return null;
          return {
            range: result.range ? toMonacoRange(result.range) : undefined,
            contents: [{ value: hoverText(result.contents) }]
          };
        }).catch(function () { return null; });
      }
    });

    // Shared by the "go to ..." providers. The server answers with a
    // Location {uri, range}, a Location[], or a LocationLink[] {targetUri,
    // targetRange, targetSelectionRange}. Only the paste itself is
    // navigable; locations in typeshed stubs have no model to jump to.
    function sameFileLocations(method, model, position) {
      if (!ready()) return Promise.resolve(null);
      syncDocument();
      return request(method, {
        textDocument: { uri: URI },
        position: toLspPosition(position)
      }).then(function (result) {
        if (!result) return null;
        var locations = Array.isArray(result) ? result : [result];
        var mapped = [];
        locations.forEach(function (loc) {
          var uri = loc.uri || loc.targetUri;
          var range = loc.range || loc.targetSelectionRange || loc.targetRange;
          if (uri === URI && range) {
            mapped.push({ uri: model.uri, range: toMonacoRange(range) });
          }
        });
        return mapped.length ? mapped : null;
      }).catch(function () { return null; });
    }

    monaco.languages.registerDefinitionProvider('python', {
      provideDefinition: function (model, position) {
        return sameFileLocations('textDocument/definition', model, position);
      }
    });

    monaco.languages.registerTypeDefinitionProvider('python', {
      provideTypeDefinition: function (model, position) {
        return sameFileLocations('textDocument/typeDefinition', model, position);
      }
    });

    monaco.languages.registerDeclarationProvider('python', {
      provideDeclaration: function (model, position) {
        return sameFileLocations('textDocument/declaration', model, position);
      }
    });

    monaco.languages.registerImplementationProvider('python', {
      provideImplementation: function (model, position) {
        return sameFileLocations('textDocument/implementation', model, position);
      }
    });

    monaco.languages.registerReferenceProvider('python', {
      provideReferences: function (model, position, context) {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/references', {
          textDocument: { uri: URI },
          position: toLspPosition(position),
          context: { includeDeclaration: !!(context && context.includeDeclaration) }
        }).then(function (result) {
          return (result || []).filter(function (loc) { return loc.uri === URI; })
            .map(function (loc) {
              return { uri: model.uri, range: toMonacoRange(loc.range) };
            });
        }).catch(function () { return null; });
      }
    });

    monaco.languages.registerDocumentHighlightProvider('python', {
      provideDocumentHighlights: function (model, position) {
        if (!ready()) return null;
        return request('textDocument/documentHighlight', {
          textDocument: { uri: URI },
          position: toLspPosition(position)
        }).then(function (result) {
          var K = monaco.languages.DocumentHighlightKind;
          return (result || []).map(function (h) {
            return {
              range: toMonacoRange(h.range),
              kind: h.kind === 3 ? K.Write : h.kind === 2 ? K.Read : K.Text
            };
          });
        }).catch(function () { return null; });
      }
    });

    // LSP SymbolKind is Monaco's SymbolKind shifted by one. The hierarchical
    // DocumentSymbol shape is requested via the client capabilities above;
    // the flat SymbolInformation shape is handled anyway for safety.
    function toDocumentSymbol(s) {
      var range = s.range || (s.location && s.location.range);
      return {
        name: s.name,
        detail: s.detail || '',
        kind: Math.max(0, (s.kind || 1) - 1),
        tags: [],
        range: toMonacoRange(range),
        selectionRange: toMonacoRange(s.selectionRange || range),
        children: (s.children || []).map(toDocumentSymbol)
      };
    }

    monaco.languages.registerDocumentSymbolProvider('python', {
      provideDocumentSymbols: function () {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/documentSymbol', {
          textDocument: { uri: URI }
        }).then(function (result) {
          return (result || []).map(toDocumentSymbol);
        }).catch(function () { return null; });
      }
    });

    monaco.languages.registerRenameProvider('python', {
      provideRenameEdits: function (model, position, newName) {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/rename', {
          textDocument: { uri: URI },
          position: toLspPosition(position),
          newName: newName
        }).then(function (result) {
          var textEdits = workspaceEditTextEdits(result);
          if (!textEdits.length) return null;
          return {
            edits: textEdits.map(function (e) {
              return {
                resource: model.uri,
                textEdit: { range: toMonacoRange(e.range), text: e.newText }
              };
            })
          };
        }).catch(function () { return null; });
      },
      resolveRenameLocation: function (model, position) {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/prepareRename', {
          textDocument: { uri: URI },
          position: toLspPosition(position)
        }).then(function (result) {
          // Range | {range, placeholder} | {defaultBehavior} | null.
          // defaultBehavior means renameable at the word under the cursor,
          // which is Monaco's own fallback when we return null.
          if (result && result.defaultBehavior) return null;
          var range = result && (result.range || (result.start && result));
          if (!range) {
            var word = model.getWordAtPosition(position);
            return {
              rejectReason: 'This element can’t be renamed.',
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word ? word.startColumn : position.column,
                endColumn: word ? word.endColumn : position.column
              },
              text: word ? word.word : ''
            };
          }
          var monacoRange = toMonacoRange(range);
          return {
            range: monacoRange,
            text: (result && result.placeholder) || model.getValueInRange(monacoRange)
          };
        }).catch(function () { return null; });
      }
    });

    monaco.languages.registerSignatureHelpProvider('python', {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: function (model, position) {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/signatureHelp', {
          textDocument: { uri: URI },
          position: toLspPosition(position)
        }).then(function (result) {
          if (!result || !result.signatures || !result.signatures.length) return null;
          return {
            value: {
              signatures: result.signatures.map(function (s) {
                return {
                  label: s.label,
                  documentation: s.documentation ? { value: hoverText(s.documentation) } : undefined,
                  parameters: (s.parameters || []).map(function (p) {
                    return {
                      label: p.label,
                      documentation: p.documentation ? { value: hoverText(p.documentation) } : undefined
                    };
                  })
                };
              }),
              activeSignature: result.activeSignature || 0,
              activeParameter: result.activeParameter || 0
            },
            dispose: function () {}
          };
        }).catch(function () { return null; });
      }
    });

    monaco.languages.registerInlayHintsProvider('python', {
      provideInlayHints: function (model, range) {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/inlayHint', {
          textDocument: { uri: URI },
          range: toLspRange(range)
        }).then(function (result) {
          return {
            hints: (result || []).map(function (h) {
              return {
                position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
                label: typeof h.label === 'string' ? h.label : h.label.map(function (part) {
                  return part.value;
                }).join(''),
                kind: h.kind === 2
                  ? monaco.languages.InlayHintKind.Parameter
                  : monaco.languages.InlayHintKind.Type,
                paddingLeft: !!h.paddingLeft,
                paddingRight: !!h.paddingRight
              };
            }),
            dispose: function () {}
          };
        }).catch(function () { return null; });
      }
    });

    // The legend arrives with the initialize result; until then Monaco gets
    // an empty one and no tokens. Needs 'semanticHighlighting.enabled' on
    // the editor to have a visible effect.
    monaco.languages.registerDocumentSemanticTokensProvider('python', {
      getLegend: function () {
        return semanticLegend || { tokenTypes: [], tokenModifiers: [] };
      },
      provideDocumentSemanticTokens: function () {
        if (!ready() || !semanticLegend) return null;
        syncDocument();
        return request('textDocument/semanticTokens/full', {
          textDocument: { uri: URI }
        }).then(function (result) {
          if (!result || !result.data) return null;
          return { data: new Uint32Array(result.data), resultId: result.resultId };
        }).catch(function () { return null; });
      },
      releaseDocumentSemanticTokens: function () {}
    });

    // Server-defined commands (e.g. basedpyright.organizeimports) attached
    // to code actions are echoed back as workspace/executeCommand; their
    // effect comes back as a workspace/applyEdit request, handled above.
    var registeredCommands = {};
    function commandId(command) {
      if (!registeredCommands[command]) {
        registeredCommands[command] = true;
        monaco.editor.registerCommand(command, function () {
          var args = Array.prototype.slice.call(arguments, 1);
          request('workspace/executeCommand', { command: command, arguments: args })
            .catch(function () {});
        });
      }
      return command;
    }

    function markerToDiagnostic(marker) {
      var S = monaco.MarkerSeverity;
      return {
        range: toLspRange(marker),
        message: marker.message,
        severity: marker.severity === S.Error ? 1
          : marker.severity === S.Warning ? 2
          : marker.severity === S.Info ? 3 : 4,
        code: marker.code,
        source: marker.source
      };
    }

    // Monaco kind filters match a kind and its sub-kinds ('source' matches
    // 'source.organizeImports').
    function kindMatches(kind, filter) {
      return !filter || kind === filter || kind.indexOf(filter + '.') === 0;
    }

    // The metadata matters: Monaco's Organize Imports action is enabled
    // only when some provider declares source.organizeImports.
    monaco.languages.registerCodeActionProvider('python', {
      provideCodeActions: function (model, range, context) {
        if (!ready()) return null;
        syncDocument();
        return request('textDocument/codeAction', {
          textDocument: { uri: URI },
          range: toLspRange(range),
          context: {
            diagnostics: (context.markers || []).map(markerToDiagnostic),
            only: context.only ? [context.only] : undefined
          }
        }).then(function (result) {
          var actions = (result || []).map(function (a) {
              // A bare Command has a string `command`; a CodeAction nests one.
              if (typeof a.command === 'string') {
                return {
                  title: a.title,
                  kind: 'quickfix',
                  command: { id: commandId(a.command), title: a.title, arguments: a.arguments }
                };
              }
              var action = {
                title: a.title,
                kind: a.kind,
                isPreferred: !!a.isPreferred,
                diagnostics: []
              };
              if (a.edit) {
                action.edit = {
                  edits: workspaceEditTextEdits(a.edit).map(function (e) {
                    return {
                      resource: model.uri,
                      textEdit: { range: toMonacoRange(e.range), text: e.newText }
                    };
                  })
                };
              }
              if (a.command) {
                action.command = {
                  id: commandId(a.command.command),
                  title: a.command.title,
                  arguments: a.command.arguments
                };
              }
              return action;
            });
          // The server only exposes organize imports as a command, not as a
          // code action, so synthesize the source action Monaco's Organize
          // Imports action (Shift+Alt+O) and "Source Action..." menu ask for.
          if (context.only && kindMatches('source.organizeImports', context.only)) {
            actions.push({
              title: 'Organize Imports',
              kind: 'source.organizeImports',
              command: {
                id: commandId('basedpyright.organizeimports'),
                title: 'Organize Imports',
                arguments: [URI]
              }
            });
          }
          return { actions: actions, dispose: function () {} };
        }).catch(function () { return null; });
      }
    }, { providedCodeActionKinds: ['quickfix', 'source.organizeImports'] });
  }

  global.PbinPyright = { start: start };
})(window);
