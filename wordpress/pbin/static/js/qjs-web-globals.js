// Minimal web globals for QuickJS runs that use URL module imports
// (code-runner.js): CDN-served ESM routinely references browser/Node globals
// at module-evaluation time that the bare qjs runtime lacks — unenv's
// node-builtin polyfills extend Blob, Effect's Encoding/Schema modules touch
// TextEncoder and URL, schedulers reach for setTimeout. Each is defined only
// when missing, and only to the depth those eval-time references need; this
// is not an attempt at a faithful web platform.
//
// The runner serves this file at /pbin-globals in the program's virtual
// filesystem and starts such runs from a /pbin-main wrapper that imports it
// before /program, so the globals exist before any user import evaluates
// while /program keeps its own line numbers for error reporting.

import * as os from 'qjs:os';

const g = globalThis;

if (typeof g.Blob === 'undefined') {
  // Enough to be subclassed by polyfills; not a working Blob.
  g.Blob = class Blob {
    constructor(parts) { this.size = 0; this.type = ''; }
  };
}

if (typeof g.setTimeout === 'undefined' && typeof os.setTimeout === 'function') {
  g.setTimeout = (fn, ms, ...args) => os.setTimeout(() => fn(...args), ms || 0);
  g.clearTimeout = (handle) => os.clearTimeout(handle);
  g.setInterval = (fn, ms, ...args) => {
    const state = { handle: null, stopped: false };
    const tick = () => {
      if (state.stopped) return;
      fn(...args);
      if (!state.stopped) state.handle = os.setTimeout(tick, ms || 0);
    };
    state.handle = os.setTimeout(tick, ms || 0);
    return state;
  };
  g.clearInterval = (state) => {
    if (state) { state.stopped = true; os.clearTimeout(state.handle); }
  };
}

if (typeof g.queueMicrotask === 'undefined') {
  g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
}

if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input) {
      const s = String(input === undefined ? '' : input);
      const out = [];
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
      return new Uint8Array(out);
    }
  };
}

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class TextDecoder {
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input === undefined) return '';
      const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input);
      let s = '';
      for (let i = 0; i < b.length;) {
        const x = b[i];
        let cp, n;
        if (x < 0x80) { cp = x; n = 1; }
        else if (x < 0xe0) { cp = x & 31; n = 2; }
        else if (x < 0xf0) { cp = x & 15; n = 3; }
        else { cp = x & 7; n = 4; }
        for (let k = 1; k < n && i + k < b.length; k++) cp = (cp << 6) | (b[i + k] & 63);
        s += String.fromCodePoint(cp);
        i += n;
      }
      return s;
    }
  };
}

if (typeof g.URL === 'undefined') {
  // Absolute and base-relative parsing with ./.. normalization: what modules
  // referencing URL at eval time (and simple runtime uses) need.
  g.URL = class URL {
    constructor(url, base) {
      url = String(url);
      if (base !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        const b = String(base);
        const origin = (b.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i) || [''])[0];
        if (url.startsWith('//')) url = (b.match(/^[a-z][a-z0-9+.-]*:/i) || [''])[0] + url;
        else if (url.startsWith('/')) url = origin + url;
        else url = b.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + url;
      }
      const m = url.match(/^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
      if (!m) throw new TypeError('Invalid URL: ' + url);
      this.protocol = m[1];
      this.host = m[2];
      const parts = [];
      for (const seg of (m[3] || '/').split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
      }
      this.pathname = parts.join('/') || '/';
      this.search = m[4] || '';
      this.hash = m[5] || '';
      const hp = this.host.split(':');
      this.hostname = hp[0];
      this.port = hp[1] || '';
      this.origin = this.protocol + '//' + this.host;
      this.href = this.origin + this.pathname + this.search + this.hash;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  };
}
