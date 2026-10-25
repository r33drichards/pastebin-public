// Real-time collaborative editing for pbin.
//
// Implements the client side of the OT protocol served at /collab (see
// collab.go). Operations use the ot.js wire format: positive integers retain,
// negative integers delete, strings insert. Offsets are UTF-16 code units,
// which matches both JavaScript strings and Monaco model offsets.
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // TextOperation
  // ---------------------------------------------------------------------------

  function isRetain(c) { return typeof c === 'number' && c > 0; }
  function isDelete(c) { return typeof c === 'number' && c < 0; }
  function isInsert(c) { return typeof c === 'string'; }

  function TextOperation() {
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  TextOperation.prototype.retain = function (n) {
    if (n <= 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    var last = this.ops.length - 1;
    if (last >= 0 && isRetain(this.ops[last])) this.ops[last] += n;
    else this.ops.push(n);
    return this;
  };

  TextOperation.prototype.insert = function (s) {
    if (!s) return this;
    this.targetLength += s.length;
    var ops = this.ops, last = ops.length - 1;
    if (last >= 0 && isInsert(ops[last])) {
      ops[last] += s;
    } else if (last >= 0 && isDelete(ops[last])) {
      // Keep inserts before deletes (canonical form, same as the server).
      if (last >= 1 && isInsert(ops[last - 1])) ops[last - 1] += s;
      else { ops.push(ops[last]); ops[last] = s; }
    } else {
      ops.push(s);
    }
    return this;
  };

  TextOperation.prototype['delete'] = function (n) {
    if (n <= 0) return this;
    this.baseLength += n;
    var last = this.ops.length - 1;
    if (last >= 0 && isDelete(this.ops[last])) this.ops[last] -= n;
    else this.ops.push(-n);
    return this;
  };

  TextOperation.prototype.isNoop = function () {
    return this.ops.length === 0 || (this.ops.length === 1 && isRetain(this.ops[0]));
  };

  TextOperation.prototype.toJSON = function () { return this.ops; };

  TextOperation.fromJSON = function (ops) {
    var o = new TextOperation();
    for (var i = 0; i < ops.length; i++) {
      var c = ops[i];
      if (isRetain(c)) o.retain(c);
      else if (isDelete(c)) o['delete'](-c);
      else if (isInsert(c)) o.insert(c);
      else throw new Error('invalid operation component ' + JSON.stringify(c));
    }
    return o;
  };

  TextOperation.prototype.apply = function (doc) {
    if (doc.length !== this.baseLength) throw new Error('operation base length does not match document');
    var parts = [], idx = 0;
    for (var i = 0; i < this.ops.length; i++) {
      var c = this.ops[i];
      if (isRetain(c)) { parts.push(doc.slice(idx, idx + c)); idx += c; }
      else if (isInsert(c)) parts.push(c);
      else idx -= c;
    }
    return parts.join('');
  };

  // compose(a, b) returns an operation equivalent to applying a then b.
  TextOperation.prototype.compose = function (b) {
    var a = this;
    if (a.targetLength !== b.baseLength) throw new Error('compose: length mismatch');
    var res = new TextOperation();
    var ops1 = a.ops.slice(), ops2 = b.ops.slice(), i1 = 0, i2 = 0;
    var op1 = ops1[i1++], op2 = ops2[i2++];
    for (;;) {
      if (op1 === undefined && op2 === undefined) break;
      if (isDelete(op1)) { res['delete'](-op1); op1 = ops1[i1++]; continue; }
      if (isInsert(op2)) { res.insert(op2); op2 = ops2[i2++]; continue; }
      if (op1 === undefined || op2 === undefined) throw new Error('compose: operation too short');
      if (isRetain(op1) && isRetain(op2)) {
        if (op1 > op2) { res.retain(op2); op1 -= op2; op2 = ops2[i2++]; }
        else if (op1 === op2) { res.retain(op1); op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { res.retain(op1); op2 -= op1; op1 = ops1[i1++]; }
      } else if (isInsert(op1) && isDelete(op2)) {
        if (op1.length > -op2) { op1 = op1.slice(-op2); op2 = ops2[i2++]; }
        else if (op1.length === -op2) { op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { op2 += op1.length; op1 = ops1[i1++]; }
      } else if (isInsert(op1) && isRetain(op2)) {
        if (op1.length > op2) { res.insert(op1.slice(0, op2)); op1 = op1.slice(op2); op2 = ops2[i2++]; }
        else if (op1.length === op2) { res.insert(op1); op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { res.insert(op1); op2 -= op1.length; op1 = ops1[i1++]; }
      } else if (isRetain(op1) && isDelete(op2)) {
        if (op1 > -op2) { res['delete'](-op2); op1 += op2; op2 = ops2[i2++]; }
        else if (op1 === -op2) { res['delete'](-op2); op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { res['delete'](op1); op2 += op1; op1 = ops1[i1++]; }
      } else {
        throw new Error('compose: unexpected components');
      }
    }
    return res;
  };

  // transform(a, b) returns [a', b'] with apply(apply(S, a), b') == apply(apply(S, b), a').
  TextOperation.transform = function (a, b) {
    if (a.baseLength !== b.baseLength) throw new Error('transform: length mismatch');
    var ap = new TextOperation(), bp = new TextOperation();
    var ops1 = a.ops, ops2 = b.ops, i1 = 0, i2 = 0;
    var op1 = ops1[i1++], op2 = ops2[i2++], m;
    for (;;) {
      if (op1 === undefined && op2 === undefined) break;
      if (isInsert(op1)) { ap.insert(op1); bp.retain(op1.length); op1 = ops1[i1++]; continue; }
      if (isInsert(op2)) { ap.retain(op2.length); bp.insert(op2); op2 = ops2[i2++]; continue; }
      if (op1 === undefined || op2 === undefined) throw new Error('transform: operation too short');
      if (isRetain(op1) && isRetain(op2)) {
        if (op1 > op2) { m = op2; op1 -= op2; op2 = ops2[i2++]; }
        else if (op1 === op2) { m = op2; op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { m = op1; op2 -= op1; op1 = ops1[i1++]; }
        ap.retain(m); bp.retain(m);
      } else if (isDelete(op1) && isDelete(op2)) {
        if (-op1 > -op2) { op1 -= op2; op2 = ops2[i2++]; }
        else if (op1 === op2) { op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { op2 -= op1; op1 = ops1[i1++]; }
      } else if (isDelete(op1) && isRetain(op2)) {
        if (-op1 > op2) { m = op2; op1 += op2; op2 = ops2[i2++]; }
        else if (-op1 === op2) { m = op2; op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { m = -op1; op2 += op1; op1 = ops1[i1++]; }
        ap['delete'](m);
      } else if (isRetain(op1) && isDelete(op2)) {
        if (op1 > -op2) { m = -op2; op1 += op2; op2 = ops2[i2++]; }
        else if (op1 === -op2) { m = op1; op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { m = op1; op2 += op1; op1 = ops1[i1++]; }
        bp['delete'](m);
      }
    }
    return [ap, bp];
  };

  // Map a cursor offset through the operation.
  TextOperation.prototype.transformIndex = function (index) {
    var newIndex = index, i = 0;
    for (var k = 0; k < this.ops.length && i <= index; k++) {
      var c = this.ops[k];
      if (isRetain(c)) i += c;
      else if (isInsert(c)) newIndex += c.length;
      else { newIndex -= Math.min(index - i, -c); i -= c; }
    }
    return newIndex;
  };

  // ---------------------------------------------------------------------------
  // Monaco binding
  // ---------------------------------------------------------------------------

  var NAME_KEY = 'pbinCollabName';
  var RECONNECT_MAX_MS = 10000;
  // After a server restart, the first editor back may restore its copy of the
  // document if it was disconnected for less than this long (the server can
  // lose up to a couple of seconds of edits if it crashes).
  var RESTORE_WINDOW_MS = 60000;

  function loadName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }
  function storeName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* ignore */ }
  }

  function cssString(s) {
    return '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ') + '"';
  }

  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(c) ? c : '#888888';
  }

  // Build the operation for one Monaco content-change event. All change
  // offsets in a single event refer to the document before the event.
  function opFromChanges(changes, oldLength) {
    var sorted = changes.slice().sort(function (a, b) { return a.rangeOffset - b.rangeOffset; });
    var op = new TextOperation(), idx = 0;
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      op.retain(c.rangeOffset - idx);
      op['delete'](c.rangeLength);
      op.insert(c.text);
      idx = c.rangeOffset + c.rangeLength;
    }
    op.retain(oldLength - idx);
    return op;
  }

  // Fallback: a single replace covering everything between the common prefix
  // and suffix of the two strings.
  function opFromDiff(oldText, newText) {
    var start = 0, maxStart = Math.min(oldText.length, newText.length);
    while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
    var endOld = oldText.length, endNew = newText.length;
    while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
      endOld--; endNew--;
    }
    return new TextOperation()
      .retain(start)['delete'](endOld - start)
      .insert(newText.slice(start, endNew))
      .retain(oldText.length - endOld);
  }

  /**
   * Connect a Monaco editor to the collaborative session for a paste.
   *
   * options:
   *   editor      Monaco editor instance
   *   pasteId     paste id
   *   onStatus    function(status) — 'connecting' | 'live' | 'saving' | 'saved' | 'offline' | 'unavailable'
   *   onPeers     function(peers, self) — peers is an array of {id, name, color}
   *   onLanguage  function(lang) — another editor changed the language
   *   onReset     function(info) — called after a reconnect that resent local edits the server had not
   *               confirmed (info.restored is true)
   */
  function start(options) {
    var editor = options.editor;
    var model = editor.getModel();
    var noop = function () {};
    var onStatus = options.onStatus || noop;
    var onPeers = options.onPeers || noop;
    var onLanguage = options.onLanguage || noop;
    var onReset = options.onReset || noop;

    model.setEOL(monaco.editor.EndOfLineSequence.LF);

    var ws = null;
    var connected = false;
    var everConnected = false;
    var stopped = false;
    var retryDelay = 500;
    var pingTimer = null;

    // OT client state (ot.js "Synchronized / AwaitingConfirm / AwaitingWithBuffer").
    var revision = 0;
    var outstanding = null;
    var buffer = null;
    var shadow = model.getValue(); // last text we know the model holds
    var ackedText = shadow;        // server's text at `revision`

    // Reconnect bookkeeping: a stable key for this tab, a sequence number per
    // operation, and the server session we last talked to.
    var clientKey = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var seq = 0;
    var outstandingSeq = 0;
    var session = null;
    var disconnectedAt = 0;
    var applyingRemote = false;

    var self = null;
    var peers = {}; // id -> {peer, sel, decorations, styleEl}
    var savedRev = 0;

    function emitPeers() {
      var list = Object.keys(peers).map(function (id) { return peers[id].peer; });
      onPeers(list, self);
    }

    function updateSaveStatus() {
      if (!connected) return;
      if (outstanding || buffer || savedRev < revision) onStatus('saving');
      else onStatus('saved');
    }

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function sendOp(op) {
      outstanding = op;
      outstandingSeq = ++seq;
      send({ type: 'op', rev: revision, seq: outstandingSeq, op: op });
    }

    // --- remote cursors -----------------------------------------------------

    function ensurePeerStyle(entry) {
      var p = entry.peer;
      var color = safeColor(p.color);
      var cls = 'pb-collab-' + p.id.replace(/[^a-zA-Z0-9_-]/g, '');
      entry.cls = cls;
      if (!entry.styleEl) {
        entry.styleEl = document.createElement('style');
        document.head.appendChild(entry.styleEl);
      }
      entry.styleEl.textContent =
        '.' + cls + '-sel{background-color:' + color + '33;}' +
        '.' + cls + '-caret{position:absolute;height:100%;border-left:2px solid ' + color + ';margin-left:-1px;box-sizing:border-box;z-index:5;}' +
        '.' + cls + '-caret::after{content:' + cssString(p.name) + ';position:absolute;left:-2px;top:-1.35em;' +
        'background:' + color + ';color:#fff;font:600 10px/1.4 var(--font-sans, sans-serif);padding:0 4px;' +
        'border-radius:3px 3px 3px 0;white-space:nowrap;pointer-events:none;opacity:.95;}';
    }

    function renderPeer(entry) {
      var decos = [];
      if (entry.sel) {
        var len = model.getValueLength();
        var a = Math.max(0, Math.min(entry.sel.anchor, len));
        var h = Math.max(0, Math.min(entry.sel.head, len));
        var ps = model.getPositionAt(Math.min(a, h));
        var pe = model.getPositionAt(Math.max(a, h));
        var ph = model.getPositionAt(h);
        if (a !== h) {
          decos.push({
            range: new monaco.Range(ps.lineNumber, ps.column, pe.lineNumber, pe.column),
            options: { className: entry.cls + '-sel', stickiness: 1 }
          });
        }
        decos.push({
          range: new monaco.Range(ph.lineNumber, ph.column, ph.lineNumber, ph.column),
          options: { beforeContentClassName: entry.cls + '-caret', stickiness: 1, hoverMessage: { value: entry.peer.name } }
        });
      }
      entry.decorations = editor.deltaDecorations(entry.decorations || [], decos);
    }

    function addPeer(p) {
      var entry = peers[p.id];
      if (!entry) entry = peers[p.id] = { peer: p, sel: null, decorations: [] };
      else entry.peer = p;
      if (p.sel) entry.sel = p.sel;
      ensurePeerStyle(entry);
      renderPeer(entry);
    }

    function removePeer(id) {
      var entry = peers[id];
      if (!entry) return;
      editor.deltaDecorations(entry.decorations || [], []);
      if (entry.styleEl) entry.styleEl.remove();
      delete peers[id];
    }

    function clearPeers() {
      Object.keys(peers).forEach(removePeer);
    }

    function transformPeers(op) {
      Object.keys(peers).forEach(function (id) {
        var e = peers[id];
        if (e.sel) {
          e.sel = { anchor: op.transformIndex(e.sel.anchor), head: op.transformIndex(e.sel.head) };
        }
      });
    }

    function rerenderPeers() {
      Object.keys(peers).forEach(function (id) { renderPeer(peers[id]); });
    }

    // --- local cursor -------------------------------------------------------

    var cursorTimer = null;
    function currentSelection() {
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) return null;
      var s = editor.getSelection();
      if (!s) return null;
      return {
        anchor: model.getOffsetAt({ lineNumber: s.selectionStartLineNumber, column: s.selectionStartColumn }),
        head: model.getOffsetAt({ lineNumber: s.positionLineNumber, column: s.positionColumn })
      };
    }
    function sendCursorSoon() {
      if (cursorTimer) return;
      cursorTimer = setTimeout(function () {
        cursorTimer = null;
        if (connected) send({ type: 'cursor', sel: currentSelection() });
      }, 40);
    }

    // --- applying operations to Monaco ---------------------------------------

    function applyToModel(op) {
      var edits = [], idx = 0, ops = op.ops;
      for (var i = 0; i < ops.length; i++) {
        var c = ops[i];
        if (isRetain(c)) { idx += c; continue; }
        var text = '', del = 0;
        if (isInsert(c)) {
          text = c;
          if (isDelete(ops[i + 1])) { del = -ops[i + 1]; i++; }
        } else {
          del = -c;
        }
        var s = model.getPositionAt(idx), e = model.getPositionAt(idx + del);
        edits.push({ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: text, forceMoveMarkers: false });
        idx += del;
      }
      if (!edits.length) return;
      applyingRemote = true;
      try {
        model.pushEditOperations(editor.getSelections(), edits, function () { return null; });
      } finally {
        applyingRemote = false;
      }
    }

    function applyRemote(op) {
      ackedText = op.apply(ackedText);
      // Transform the incoming op past our unacknowledged local changes.
      if (outstanding) {
        var t1 = TextOperation.transform(outstanding, op);
        outstanding = t1[0]; op = t1[1];
      }
      if (buffer) {
        var t2 = TextOperation.transform(buffer, op);
        buffer = t2[0]; op = t2[1];
      }
      shadow = op.apply(shadow);
      applyToModel(op);
      if (model.getValue() !== shadow) {
        // Should never happen; recover by trusting the shadow copy.
        console.warn('pbin collab: model out of sync, resetting');
        applyingRemote = true;
        try { model.setValue(shadow); } finally { applyingRemote = false; }
      }
      transformPeers(op);
      rerenderPeers();
    }

    model.onDidChangeContent(function (e) {
      if (applyingRemote) return;
      var newText = model.getValue();
      var delta = 0;
      e.changes.forEach(function (c) { delta += c.text.length - c.rangeLength; });
      var op = opFromChanges(e.changes, newText.length - delta);
      if (op.baseLength !== shadow.length || op.apply(shadow) !== newText) {
        op = opFromDiff(shadow, newText);
      }
      shadow = newText;
      if (op.isNoop()) return;
      transformPeers(op);
      rerenderPeers();
      if (!connected) return; // read-only while offline; nothing should get here
      if (!outstanding) sendOp(op);
      else if (!buffer) buffer = op;
      else buffer = buffer.compose(op);
      updateSaveStatus();
    });

    editor.onDidChangeCursorSelection(sendCursorSoon);

    // --- connection ----------------------------------------------------------

    var wasReadOnly = null;

    function setOffline() {
      if (wasReadOnly === null) {
        wasReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
        editor.updateOptions({ readOnly: true });
      }
    }

    function restoreEditable() {
      if (wasReadOnly !== null) {
        editor.updateOptions({ readOnly: wasReadOnly });
        wasReadOnly = null;
      }
    }

    // Work out which local edits the server has not got, rebased onto the
    // server's current text. Returns null when there is nothing to resend.
    function unsentEdits(msg) {
      var serverText = msg.text;
      if (!everConnected) return null;
      if (msg.session !== session && msg.fresh && Date.now() - disconnectedAt < RESTORE_WINDOW_MS) {
        // The server restarted and nobody has edited since: our copy is the
        // most recent one, including edits the server may have lost.
        return opFromDiff(serverText, shadow);
      }
      if (!outstanding && !buffer) return null;
      var applied = false;
      if (outstanding) {
        applied = msg.session === session
          ? msg.lastSeq >= outstandingSeq
          : outstanding.apply(ackedText) === serverText;
      }
      var base = applied ? outstanding.apply(ackedText) : ackedText;
      var pending = applied ? null : outstanding;
      if (buffer) pending = pending ? pending.compose(buffer) : buffer;
      if (!pending) return null;
      // Rebase onto whatever else changed on the server meanwhile.
      return TextOperation.transform(pending, opFromDiff(base, serverText))[0];
    }

    function handleInit(msg) {
      var resend = null;
      try {
        resend = unsentEdits(msg);
      } catch (e) {
        console.warn('pbin collab: could not rebase local edits', e);
      }
      if (resend && resend.isNoop()) resend = null;

      outstanding = null;
      buffer = null;
      revision = msg.rev;
      savedRev = msg.rev;
      session = msg.session;
      ackedText = msg.text;
      self = msg.peer;
      clearPeers();
      (msg.peers || []).forEach(addPeer);

      var target = resend ? resend.apply(msg.text) : msg.text;
      if (target !== shadow) {
        var reset = opFromDiff(shadow, target);
        shadow = target;
        applyToModel(reset);
        if (model.getValue() !== shadow) {
          applyingRemote = true;
          try { model.setValue(shadow); } finally { applyingRemote = false; }
        }
      }
      if (msg.lang !== undefined && msg.lang !== null) onLanguage(msg.lang);

      connected = true;
      everConnected = true;
      retryDelay = 500;
      restoreEditable();
      if (resend) {
        sendOp(resend);
        onReset({ restored: true });
      }
      emitPeers();
      updateSaveStatus();
      sendCursorSoon();
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'init':
          handleInit(msg);
          break;
        case 'ack':
          revision++;
          ackedText = outstanding.apply(ackedText);
          if (buffer) { var b = buffer; buffer = null; sendOp(b); }
          else { outstanding = null; sendCursorSoon(); }
          updateSaveStatus();
          break;
        case 'op':
          revision++;
          applyRemote(TextOperation.fromJSON(msg.op));
          updateSaveStatus();
          break;
        case 'cursor':
          if (peers[msg.clientId]) {
            peers[msg.clientId].sel = msg.sel || null;
            renderPeer(peers[msg.clientId]);
          }
          break;
        case 'join':
          addPeer(msg.peer);
          emitPeers();
          break;
        case 'leave':
          removePeer(msg.clientId);
          emitPeers();
          break;
        case 'lang':
          onLanguage(msg.lang);
          break;
        case 'saved':
          savedRev = Math.max(savedRev, msg.rev);
          updateSaveStatus();
          break;
        case 'error':
          console.warn('pbin collab:', msg.error);
          if (!everConnected && msg.error === 'paste not found') {
            stopped = true;
            onStatus('unavailable');
          }
          break;
      }
    }

    function connect() {
      if (stopped) return;
      if (!everConnected) onStatus('connecting');
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var url = proto + '//' + location.host + '/collab?id=' + encodeURIComponent(options.pasteId);
      url += '&key=' + encodeURIComponent(clientKey);
      var name = loadName();
      if (name) url += '&name=' + encodeURIComponent(name);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        onStatus('unavailable');
        return;
      }
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        try {
          handleMessage(msg);
        } catch (e) {
          console.error('pbin collab: failed to handle message', e);
          ws.close(); // reconnect and resync
        }
      };
      ws.onclose = function () {
        var hadConnected = connected;
        if (hadConnected) disconnectedAt = Date.now();
        connected = false;
        ws = null;
        clearInterval(pingTimer);
        clearPeers();
        if (stopped) return;
        if (!everConnected && !hadConnected && retryDelay >= 4000) {
          // Never managed to connect: probably no WebSocket support upstream.
          onStatus('unavailable');
          return;
        }
        if (everConnected) {
          setOffline();
          onStatus('offline');
          emitPeers();
        }
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
      };
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { send({ type: 'ping' }); }, 25000);
    }

    connect();

    return {
      isConnected: function () { return connected; },
      hasPendingChanges: function () { return !!(outstanding || buffer); },
      setLanguage: function (lang) { send({ type: 'lang', lang: lang }); },
      setName: function (name) {
        name = String(name || '').trim().slice(0, 32);
        if (!name) return;
        storeName(name);
        if (self) { self.name = name; emitPeers(); }
        send({ type: 'name', name: name });
      },
      // Re-announce the cursor (e.g. after toggling read-only).
      refreshCursor: sendCursorSoon,
      // Keep the editor read-only while offline even if the page toggles edit mode.
      setEditable: function (editable) {
        if (wasReadOnly !== null) wasReadOnly = !editable;
        else editor.updateOptions({ readOnly: !editable });
        sendCursorSoon();
      }
    };
  }

  global.PbinCollab = { start: start, TextOperation: TextOperation };
})(window);
