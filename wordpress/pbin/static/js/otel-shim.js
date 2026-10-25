// An in-paste OpenTelemetry tracer: the subset of @opentelemetry/api that a
// JavaScript/TypeScript paste needs to create spans, with an in-memory span
// processor in place of an OTLP exporter. A paste opts in by importing it —
// `import { trace } from '@opentelemetry/api'` — written exactly as it would
// be against the real API, so the same paste runs unchanged in Node with the
// actual SDK. Pastes that don't import it see no change at all.
//
// The file defines one factory, __pbOtelCreate(emit, now), and deliberately
// exports nothing itself, because it runs in two very different places:
//
//  - QuickJS plain runs: code-runner.js appends an ES-module footer and
//    places the result at /@opentelemetry/api in the program's virtual
//    filesystem (next to the /std and /os shims), where QuickJS's module
//    loader resolves the bare import. There `emit` prints a sentinel line to
//    stdout — the only channel out of the WASI sandbox — which the runner
//    strips back out and renders as a waterfall (trace-view.js).
//
//  - Debugger runs: js-debug-worker.js serves require('@opentelemetry/api')
//    (Babel rewrites the paste's imports to requires) from this same factory,
//    with `emit` collecting payloads for the worker's result message instead
//    of printing them.
//
// A trace is emitted when its root span ends (and a late-ending subtree whose
// root was already emitted becomes its own fragment with the same traceId;
// the renderer merges by traceId). Spans still unended at that point are
// included with end: null. A root span that never ends is never emitted —
// same as the real SDK dropping what was never flushed.
//
// Known limit, shared with any environment without AsyncLocalStorage: the
// active span is a plain stack, correct for synchronous code and sequential
// awaits. Concurrent branches (Promise.all of traced work) must pass parent
// context explicitly — tracer.startSpan(name, opts, ctx) — which the real
// API supports in the same shape.

'use strict';

function __pbOtelCreate(emit, now) {
  // Caps, so a runaway loop can't build an unrenderable payload. Everything
  // over a cap is counted in dropped* fields rather than silently vanishing.
  var MAX_SPANS_PER_TRACE = 1000;
  var MAX_ATTRIBUTES = 64;
  var MAX_EVENTS = 128;
  var MAX_VALUE_LENGTH = 2048;

  var SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
  var SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };

  function randomHex(chars) {
    var s = '';
    for (var i = 0; i < chars; i++) s += (Math.random() * 16 | 0).toString(16);
    return s;
  }

  // Attribute values per the OTel spec: strings, numbers, booleans, or
  // homogeneous arrays of them. Anything else is stringified rather than
  // rejected — a playground favors keeping the data over strictness.
  function cleanValue(value) {
    var t = typeof value;
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'string') return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) + '…' : value;
    if (Array.isArray(value)) return value.slice(0, 128).map(cleanValue);
    if (value === null || value === undefined) return value === null ? null : undefined;
    try { return cleanValue(String(value)); } catch (e) { return '<unrepresentable>'; }
  }

  function setClean(target, key, value, counts) {
    if (typeof key !== 'string' || !key) return;
    if (!(key in target) && Object.keys(target).length >= MAX_ATTRIBUTES) {
      counts.dropped++;
      return;
    }
    var v = cleanValue(value);
    if (v !== undefined) target[key] = v;
  }

  // ---- live span store -------------------------------------------------------
  // Spans stay here (keyed by spanId) until the trace they belong to is
  // emitted; children lists let a root's end collect its whole subtree.
  var live = Object.create(null);
  var children = Object.create(null);
  var liveCountByTrace = Object.create(null);

  function flushSubtree(root) {
    var spans = [];
    var queue = [root];
    while (queue.length) {
      var span = queue.shift();
      spans.push(span);
      var kids = children[span._id] || [];
      for (var i = 0; i < kids.length; i++) {
        var kid = live[kids[i]];
        if (kid) queue.push(kid);
      }
      delete live[span._id];
      delete children[span._id];
    }
    spans.sort(function (a, b) { return a._start - b._start; });
    var payload = {
      pbin: 'otel-trace',
      traceId: root._traceId,
      spans: spans.map(function (s) {
        var out = {
          spanId: s._id,
          parentSpanId: s._parentId,
          name: s.name,
          kind: s._kind,
          tracer: s._tracer,
          start: s._start,
          end: s._end,
          attrs: s._attrs,
          events: s._events,
          status: s._status,
        };
        if (s._droppedAttrs.dropped) out.droppedAttributes = s._droppedAttrs.dropped;
        if (s._droppedEvents) out.droppedEvents = s._droppedEvents;
        return out;
      }),
    };
    emit(JSON.stringify(payload));
  }

  // ---- Span -------------------------------------------------------------------
  function Span(name, tracerLabel, kind, parent, traceId) {
    this.name = String(name);
    this._tracer = tracerLabel;
    this._kind = kind;
    this._id = randomHex(16);
    this._parentId = parent ? parent._id : null;
    this._traceId = traceId;
    this._start = now();
    this._end = null;
    this._flushed = false;
    this._attrs = {};
    this._events = [];
    this._status = { code: SpanStatusCode.UNSET };
    this._droppedAttrs = { dropped: 0 };
    this._droppedEvents = 0;
  }

  Span.prototype.spanContext = function () {
    return { traceId: this._traceId, spanId: this._id, traceFlags: 1 };
  };
  Span.prototype.isRecording = function () { return this._end === null && !this._flushed; };
  Span.prototype.setAttribute = function (key, value) {
    if (this.isRecording()) setClean(this._attrs, key, value, this._droppedAttrs);
    return this;
  };
  Span.prototype.setAttributes = function (attrs) {
    if (attrs && typeof attrs === 'object') {
      for (var key in attrs) this.setAttribute(key, attrs[key]);
    }
    return this;
  };
  Span.prototype.addEvent = function (name, attrsOrTime, maybeTime) {
    if (!this.isRecording()) return this;
    if (this._events.length >= MAX_EVENTS) { this._droppedEvents++; return this; }
    var attrs = (attrsOrTime && typeof attrsOrTime === 'object') ? attrsOrTime : null;
    var event = { name: String(name), time: now(), attrs: {} };
    if (attrs) {
      var counts = { dropped: 0 };
      for (var key in attrs) setClean(event.attrs, key, attrs[key], counts);
    }
    this._events.push(event);
    return this;
  };
  Span.prototype.recordException = function (err) {
    var attrs = {
      'exception.type': (err && err.name) || typeof err,
      'exception.message': err && err.message !== undefined ? String(err.message) : String(err),
    };
    if (err && err.stack) attrs['exception.stacktrace'] = String(err.stack);
    return this.addEvent('exception', attrs);
  };
  Span.prototype.setStatus = function (status) {
    if (this.isRecording() && status && typeof status.code === 'number') {
      this._status = { code: status.code };
      if (status.message !== undefined) this._status.message = String(status.message);
    }
    return this;
  };
  Span.prototype.updateName = function (name) {
    if (this.isRecording()) this.name = String(name);
    return this;
  };
  Span.prototype.end = function () {
    if (this._end !== null || this._flushed) return; // idempotent, like the SDK
    this._end = now();
    // A root emits its whole subtree. A span whose parent is no longer live
    // (its trace was already emitted) becomes a fragment of the same trace —
    // the renderer merges by traceId — instead of being lost.
    if (!live[this._id]) return; // dropped at creation (over the span cap)
    if (this._parentId === null || !live[this._parentId]) {
      flushSubtree(this);
      this._flushed = true;
    }
  };

  // ---- context ----------------------------------------------------------------
  // A context is just {_span}; "active" is the top of a plain stack, pushed
  // and popped around context.with / startActiveSpan callbacks.
  var ROOT_CONTEXT = { _span: null };
  var activeStack = [];

  var contextApi = {
    active: function () {
      return activeStack.length ? activeStack[activeStack.length - 1] : ROOT_CONTEXT;
    },
    with: function (ctx, fn, thisArg) {
      activeStack.push(ctx && typeof ctx === 'object' ? ctx : ROOT_CONTEXT);
      try {
        return fn.apply(thisArg, Array.prototype.slice.call(arguments, 3));
      } finally {
        activeStack.pop();
      }
    },
  };

  // ---- Tracer -----------------------------------------------------------------
  function Tracer(label) { this._label = label; }

  Tracer.prototype.startSpan = function (name, options, ctx) {
    options = options || {};
    var parent = null;
    if (!options.root) {
      var base = (ctx && typeof ctx === 'object') ? ctx : contextApi.active();
      parent = base._span || null;
    }
    var traceId = parent ? parent._traceId : randomHex(32);
    var span = new Span(name, this._label, typeof options.kind === 'number' ? options.kind : SpanKind.INTERNAL,
      parent, traceId);
    if (options.attributes) span.setAttributes(options.attributes);
    if ((liveCountByTrace[traceId] || 0) >= MAX_SPANS_PER_TRACE) {
      return span; // recorded nowhere: over the cap, API still works
    }
    liveCountByTrace[traceId] = (liveCountByTrace[traceId] || 0) + 1;
    live[span._id] = span;
    if (parent && live[parent._id]) {
      (children[parent._id] = children[parent._id] || []).push(span._id);
    }
    return span;
  };

  // startActiveSpan(name, fn) / (name, options, fn) / (name, options, ctx, fn),
  // the real API's overloads. One playground-friendly extra: a throw out of fn
  // (or a rejection of the promise it returns) records the exception, marks
  // the span ERROR and ends it before rethrowing — otherwise the whole trace
  // would vanish with the program.
  Tracer.prototype.startActiveSpan = function (name, a, b, c) {
    var options, ctx, fn;
    if (typeof a === 'function') { fn = a; }
    else if (typeof b === 'function') { options = a; fn = b; }
    else { options = a; ctx = b; fn = c; }
    if (typeof fn !== 'function') throw new TypeError('startActiveSpan requires a callback');
    var span = this.startSpan(name, options, ctx);
    var base = (ctx && typeof ctx === 'object') ? ctx : contextApi.active();
    var fail = function (err) {
      if (span.isRecording()) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err && err.message !== undefined ? String(err.message) : String(err) });
        span.end();
      }
    };
    try {
      var result = contextApi.with(traceApi.setSpan(base, span), fn, undefined, span);
      if (result && typeof result.then === 'function') {
        return result.then(
          function (value) { return value; },
          function (err) { fail(err); throw err; }
        );
      }
      return result;
    } catch (err) {
      fail(err);
      throw err;
    }
  };

  var tracers = Object.create(null);
  var traceApi = {
    getTracer: function (name, version) {
      var label = String(name || 'default') + (version ? '@' + String(version) : '');
      return tracers[label] || (tracers[label] = new Tracer(label));
    },
    getSpan: function (ctx) { return (ctx && ctx._span) || undefined; },
    getActiveSpan: function () { return contextApi.active()._span || undefined; },
    setSpan: function (ctx, span) { return { _span: span }; },
    deleteSpan: function (ctx) { return { _span: null }; },
  };

  return {
    trace: traceApi,
    context: contextApi,
    SpanStatusCode: SpanStatusCode,
    SpanKind: SpanKind,
    ROOT_CONTEXT: ROOT_CONTEXT,
  };
}
