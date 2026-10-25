// Span waterfall for OpenTelemetry traces a paste emits (otel-shim.js): the
// Tempo/Jaeger-style view — one row per span, nested under its parent, a
// time-proportional bar, events as ticks on the bar, click a row for its
// attributes, events and status.
//
// Traces leave the sandboxes two ways and meet here:
//  - QuickJS plain runs print one sentinel line per trace on stdout (the only
//    channel out of the WASI sandbox); extract() strips those lines back out
//    of the output text and parses them.
//  - Debugger runs return them on the worker's result message directly.
// Either way code-runner.js hands render() the parsed payloads after the
// textual output is in place. Payloads are merged by traceId first, because a
// subtree ending after its root was emitted arrives as a separate fragment of
// the same trace.
//
// Like the other structured-output panels, the raw payload stays on the
// container (__pbOutputRaw) so Copy/Download return the trace as data rather
// than the rendered DOM.

(function () {
  'use strict';

  var SENTINEL = '__PBIN_OTEL_TRACE__';
  var MAX_ROWS = 1500;
  var KIND_NAMES = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
  // Bar colors keyed by tracer name, drawn from the site palette.
  var PALETTE = ['var(--sky)', 'var(--leaf)', 'var(--gold)', 'var(--tang)', 'var(--deep)'];

  // Splits program stdout into the text to display and the trace payloads
  // embedded in it. A sentinel can land mid-line when the program printed a
  // partial line before a trace flushed; the prefix is kept as output.
  function extract(text) {
    if (!text || text.indexOf(SENTINEL) === -1) return { text: text, traces: [] };
    var traces = [];
    var kept = [];
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var at = line.indexOf(SENTINEL);
      if (at === -1) { kept.push(line); continue; }
      var payload = null;
      try { payload = JSON.parse(line.slice(at + SENTINEL.length)); } catch (e) { /* not ours */ }
      if (!payload || payload.pbin !== 'otel-trace' || !Array.isArray(payload.spans)) {
        kept.push(line);
        continue;
      }
      traces.push(payload);
      if (at > 0) kept.push(line.slice(0, at));
    }
    return { text: kept.join('\n'), traces: traces };
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    if (ms < 1) return Math.round(ms * 1000) + 'µs';
    if (ms < 1000) return (ms < 10 ? ms.toFixed(2) : ms.toFixed(1)) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function colorFor(label) {
    var hash = 0;
    for (var i = 0; i < label.length; i++) hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }

  function attrValueText(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  // The rows in display order: parents before children (children sorted by
  // start time), spans whose parent never arrived treated as roots.
  function orderSpans(spans) {
    var byId = Object.create(null);
    var i;
    for (i = 0; i < spans.length; i++) byId[spans[i].spanId] = spans[i];
    var childrenOf = Object.create(null);
    var roots = [];
    for (i = 0; i < spans.length; i++) {
      var span = spans[i];
      var parentId = span.parentSpanId;
      if (parentId && byId[parentId]) {
        (childrenOf[parentId] = childrenOf[parentId] || []).push(span);
      } else {
        roots.push(span);
      }
    }
    var byStart = function (a, b) { return (a.start || 0) - (b.start || 0); };
    roots.sort(byStart);
    var rows = [];
    var walk = function (span, depth) {
      if (rows.length >= MAX_ROWS) return;
      rows.push({ span: span, depth: depth });
      var kids = (childrenOf[span.spanId] || []).sort(byStart);
      for (var k = 0; k < kids.length; k++) walk(kids[k], depth + 1);
    };
    for (i = 0; i < roots.length; i++) walk(roots[i], 0);
    return rows;
  }

  function detailsFor(span, traceStart) {
    var details = el('div', 'pb-trace-details');
    var meta = el('div', 'pb-trace-detail-meta');
    var dur = span.end !== null ? fmtDuration(span.end - span.start) : 'never ended';
    meta.appendChild(el('span', null,
      'span ' + span.spanId + (span.parentSpanId ? ' · parent ' + span.parentSpanId : ' · root') +
      ' · ' + (KIND_NAMES[span.kind] || 'INTERNAL') + ' · ' + (span.tracer || 'default')));
    meta.appendChild(el('span', null,
      'start +' + fmtDuration(span.start - traceStart) + ' · duration ' + dur));
    if (span.status && span.status.code === 2) {
      meta.appendChild(el('span', 'pb-trace-status-error',
        'ERROR' + (span.status.message ? ': ' + span.status.message : '')));
    } else if (span.status && span.status.code === 1) {
      meta.appendChild(el('span', null, 'status OK'));
    }
    details.appendChild(meta);

    var attrKeys = span.attrs ? Object.keys(span.attrs) : [];
    if (attrKeys.length) {
      var attrs = el('div', 'pb-trace-kv');
      for (var i = 0; i < attrKeys.length; i++) {
        var row = el('div', 'pb-trace-kv-row');
        row.appendChild(el('span', 'pb-trace-kv-key', attrKeys[i]));
        row.appendChild(el('span', 'pb-trace-kv-val', attrValueText(span.attrs[attrKeys[i]])));
        attrs.appendChild(row);
      }
      details.appendChild(attrs);
    }
    if (span.droppedAttributes) {
      details.appendChild(el('div', 'pb-trace-dropped', '+' + span.droppedAttributes + ' attributes dropped'));
    }

    var events = span.events || [];
    for (var j = 0; j < events.length; j++) {
      var event = events[j];
      var line = el('div', 'pb-trace-event');
      line.appendChild(el('span', 'pb-trace-kv-key', '◆ ' + event.name));
      var when = '+' + fmtDuration(event.time - span.start);
      var eventAttrKeys = event.attrs ? Object.keys(event.attrs) : [];
      var extra = eventAttrKeys.map(function (k) { return k + '=' + attrValueText(event.attrs[k]); }).join(' ');
      line.appendChild(el('span', 'pb-trace-kv-val', when + (extra ? ' · ' + extra : '')));
      details.appendChild(line);
    }
    if (span.droppedEvents) {
      details.appendChild(el('div', 'pb-trace-dropped', '+' + span.droppedEvents + ' events dropped'));
    }
    return details;
  }

  function renderTrace(outputEl, traceId, spans, rawJson) {
    var rows = orderSpans(spans);
    if (!rows.length) return;

    // The trace's own clock: all bars are laid out against [start, end].
    var start = Infinity;
    var end = -Infinity;
    var i;
    for (i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (typeof s.start === 'number' && s.start < start) start = s.start;
      if (typeof s.end === 'number' && s.end > end) end = s.end;
      if (typeof s.start === 'number' && s.start > end) end = s.start;
    }
    if (!isFinite(start)) return;
    var total = Math.max(end - start, 0.001);
    var pct = function (t) { return Math.min(Math.max(((t - start) / total) * 100, 0), 100); };

    var container = document.createElement('div');
    container.className = 'pb-output-structured pb-trace';
    container.dataset.pbLang = 'otel-trace';
    container.__pbOutputRaw = rawJson.endsWith('\n') ? rawJson : rawJson + '\n';

    var head = el('div', 'pb-trace-head');
    head.appendChild(el('span', 'pb-trace-title', rows[0].span.name));
    head.appendChild(el('span', 'pb-trace-meta',
      rows.length + (rows.length === 1 ? ' span' : ' spans') +
      (spans.length > rows.length ? ' (' + (spans.length - rows.length) + ' not shown)' : '') +
      ' · ' + fmtDuration(total) + ' · trace ' + String(traceId).slice(0, 16)));
    container.appendChild(head);

    var body = el('div', 'pb-trace-body');

    // The time ruler: tick labels over the bar column, aligned with the
    // quarter gridlines the bar cells draw.
    var ruler = el('div', 'pb-trace-row pb-trace-ruler');
    ruler.appendChild(el('span', 'pb-trace-name', ''));
    var rulerCell = el('span', 'pb-trace-barcell');
    for (i = 0; i <= 4; i++) {
      var tick = el('span', 'pb-trace-tick', fmtDuration(total * i / 4));
      tick.style.left = (i * 25) + '%';
      if (i === 4) tick.className += ' pb-trace-tick--last';
      rulerCell.appendChild(tick);
    }
    ruler.appendChild(rulerCell);
    ruler.appendChild(el('span', 'pb-trace-dur', ''));
    body.appendChild(ruler);

    rows.forEach(function (entry) {
      var span = entry.span;
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'pb-trace-row pb-trace-row--span';
      row.title = 'Show attributes and events';

      var name = el('span', 'pb-trace-name');
      name.style.paddingLeft = (entry.depth * 14) + 'px';
      name.appendChild(el('span', span.status && span.status.code === 2 ? 'pb-trace-status-error' : '', span.name));
      if (span.tracer && span.tracer !== 'default') name.appendChild(el('span', 'pb-trace-svc', span.tracer));
      row.appendChild(name);

      var cell = el('span', 'pb-trace-barcell pb-trace-barcell--grid');
      var bar = el('span', 'pb-trace-bar');
      var left = pct(span.start);
      var right = span.end !== null ? pct(span.end) : 100;
      bar.style.left = left + '%';
      bar.style.width = Math.max(right - left, 0.4) + '%';
      bar.style.background = colorFor(span.tracer || 'default');
      if (span.status && span.status.code === 2) bar.className += ' pb-trace-bar--error';
      if (span.end === null) bar.className += ' pb-trace-bar--unended';
      cell.appendChild(bar);
      (span.events || []).forEach(function (event) {
        var dot = el('span', 'pb-trace-evt');
        dot.style.left = pct(event.time) + '%';
        dot.title = event.name;
        cell.appendChild(dot);
      });
      row.appendChild(cell);

      row.appendChild(el('span', 'pb-trace-dur',
        span.end !== null ? fmtDuration(span.end - span.start) : '…'));

      var details = null;
      row.addEventListener('click', function () {
        if (details) {
          details.remove();
          details = null;
          return;
        }
        details = detailsFor(span, start);
        row.insertAdjacentElement('afterend', details);
      });
      body.appendChild(row);
    });

    container.appendChild(body);
    outputEl.appendChild(container);
  }

  // The waterfalls live in their own trace document/tab (paste.html's editor
  // groups) so the output pane stays plain program output; the tab exists
  // only while there are traces to show. Pages without the tab (snapshots)
  // fall back to rendering inline under the output.
  function tracePane() {
    return document.getElementById('traceOutput');
  }

  // Called at the start of every run: the previous run's traces no longer
  // describe what the output shows.
  function clear() {
    var pane = tracePane();
    if (!pane) return;
    pane.textContent = '';
    if (window.pbinSetTraceTabVisible) window.pbinSetTraceTabVisible(false);
  }

  // Renders every trace in the payload list, merging fragments by traceId.
  function render(outputEl, traces) {
    if (!traces || !traces.length) return;
    var pane = tracePane();
    var host = pane || outputEl;
    var order = [];
    var byTrace = Object.create(null);
    traces.forEach(function (payload) {
      var id = String(payload.traceId || '');
      if (!byTrace[id]) {
        byTrace[id] = { spans: [], raws: [] };
        order.push(id);
      }
      byTrace[id].spans = byTrace[id].spans.concat(payload.spans.filter(function (s) {
        return s && typeof s === 'object' && typeof s.spanId === 'string' && typeof s.start === 'number';
      }));
      byTrace[id].raws.push(JSON.stringify(payload));
    });
    order.forEach(function (id) {
      try {
        renderTrace(host, id, byTrace[id].spans, byTrace[id].raws.join('\n'));
      } catch (e) {
        console.error('trace render failed:', e);
      }
    });
    if (pane && pane.childNodes.length && window.pbinSetTraceTabVisible) {
      window.pbinSetTraceTabVisible(true);
    }
  }

  window.PbinTraceView = { SENTINEL: SENTINEL, extract: extract, render: render, clear: clear };
})();
