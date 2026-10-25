// Toolbar clock: a stopwatch and a countdown timer sharing one display.
// Each instrument keeps its own state and both may run at once; the mode
// keys pick which one the display shows. Time is derived from timestamps,
// not tick increments, so a throttled background tab stays accurate and
// a running instrument survives a reload: state is persisted to
// localStorage ('pbin-clock') and restored against the wall clock.
// Uses the .pb-clock classes in static/css/app.css.
(function () {
  "use strict";

  var DEFAULT_TIMER_MS = 5 * 60 * 1000;
  var STORE_KEY = "pbin-clock";

  var sw = { running: false, startedAt: 0, banked: 0 };
  var tm = { running: false, endsAt: 0, remaining: DEFAULT_TIMER_MS, duration: DEFAULT_TIMER_MS, done: false };
  var mode = "stopwatch";
  var ticker = null;

  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';

  var root, display, startBtn, resetBtn, swBtn, tmBtn;

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // Stopwatch: tenths under an hour, whole seconds above.
  function formatElapsed(ms) {
    var tenths = Math.floor(ms / 100);
    var s = Math.floor(tenths / 10), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return h + ":" + pad(m % 60) + ":" + pad(s % 60);
    return pad(m) + ":" + pad(s % 60) + "." + (tenths % 10);
  }

  // Timer: whole seconds, rounded up so it reads 00:01 until it is truly done.
  function formatRemaining(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return h + ":" + pad(m % 60) + ":" + pad(s % 60);
    return pad(m) + ":" + pad(s % 60);
  }

  // Accepts "h:mm:ss", "m:ss", or a bare number of minutes ("5", "1.5").
  function parseDuration(text) {
    var t = text.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) {
      var min = parseFloat(t);
      return min > 0 ? Math.round(min * 60 * 1000) : null;
    }
    var m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
    if (!m) return null;
    var ms = ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
    return ms > 0 ? ms : null;
  }

  function swElapsed(now) { return sw.banked + (sw.running ? now - sw.startedAt : 0); }
  function tmRemaining(now) { return tm.running ? tm.endsAt - now : tm.remaining; }

  function save() {
    try {
      window.pbinStorage.setItem(STORE_KEY, JSON.stringify({ sw: sw, tm: tm, mode: mode }));
    } catch (e) { /* persistence is a nicety; never let it break the clock */ }
  }

  function isMs(v) { return typeof v === "number" && isFinite(v) && v >= 0; }

  // Restore persisted state. Timestamps are absolute, so a stopwatch or
  // countdown that was running when the page went away picks up where the
  // wall clock says it should be, not where it was last rendered.
  function load() {
    var raw = null;
    try { raw = window.pbinStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return; }
    if (!s || typeof s !== "object") return;

    var now = Date.now();
    var p = s.sw;
    if (p && typeof p === "object" && isMs(p.banked) && isMs(p.startedAt)) {
      sw.banked = p.banked;
      sw.running = p.running === true;
      // A startedAt in the future (clock change) would count backwards; clamp it.
      sw.startedAt = sw.running ? Math.min(p.startedAt, now) : 0;
    }
    p = s.tm;
    if (p && typeof p === "object" && isMs(p.duration) && p.duration > 0 && isMs(p.remaining) && isMs(p.endsAt)) {
      tm.duration = p.duration;
      tm.remaining = Math.min(p.remaining, p.duration);
      tm.done = p.done === true;
      tm.running = p.running === true;
      tm.endsAt = p.endsAt;
      if (tm.running && tm.endsAt - now <= 0) {
        // The countdown expired while we were gone; surface it without the
        // alarm, which would be noise long after the moment it marked.
        tm.running = false;
        tm.remaining = 0;
        tm.done = true;
      }
    }
    if (s.mode === "stopwatch" || s.mode === "timer") mode = s.mode;
    if (tm.done) mode = "timer";
  }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      for (var i = 0; i < 3; i++) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        var t0 = ctx.currentTime + i * 0.35;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      }
      setTimeout(function () { ctx.close(); }, 1500);
    } catch (e) { /* audio is a nicety; never let it break the clock */ }
  }

  function render() {
    var now = Date.now();
    var running = mode === "stopwatch" ? sw.running : tm.running;
    if (document.activeElement !== display) {
      display.value = mode === "stopwatch" ? formatElapsed(swElapsed(now)) : formatRemaining(tmRemaining(now));
    }
    root.classList.toggle("is-running", running);
    root.classList.toggle("is-done", mode === "timer" && tm.done);
    swBtn.setAttribute("aria-pressed", mode === "stopwatch" ? "true" : "false");
    tmBtn.setAttribute("aria-pressed", mode === "timer" ? "true" : "false");
    startBtn.innerHTML = running ? ICON_PAUSE : ICON_PLAY;
    startBtn.title = running ? "Pause" : "Start";
    startBtn.setAttribute("aria-label", running ? "Pause " + mode : "Start " + mode);
    // The duration is only editable while the timer is parked.
    display.readOnly = !(mode === "timer" && !tm.running);
    display.title = mode === "timer"
      ? "Countdown — click to type a duration (5 for minutes, 1:30, 1:00:00)"
      : "Stopwatch";
  }

  function tick() {
    var now = Date.now();
    if (tm.running && tm.endsAt - now <= 0) {
      tm.running = false;
      tm.remaining = 0;
      tm.done = true;
      mode = "timer"; // surface the finished countdown even if the stopwatch was showing
      beep();
      save();
    }
    render();
    syncTicker();
  }

  function syncTicker() {
    var need = sw.running || tm.running;
    if (need && ticker === null) ticker = setInterval(tick, 100);
    if (!need && ticker !== null) { clearInterval(ticker); ticker = null; }
  }

  function startPause() {
    var now = Date.now();
    if (mode === "stopwatch") {
      if (sw.running) { sw.banked = swElapsed(now); sw.running = false; }
      else { sw.startedAt = now; sw.running = true; }
    } else {
      if (tm.running) { tm.remaining = Math.max(0, tm.endsAt - now); tm.running = false; }
      else {
        if (tm.done || tm.remaining <= 0) { tm.remaining = tm.duration; tm.done = false; }
        tm.endsAt = now + tm.remaining;
        tm.running = true;
      }
    }
    save();
    syncTicker();
    render();
  }

  function reset() {
    if (mode === "stopwatch") {
      sw.running = false; sw.banked = 0;
    } else {
      tm.running = false; tm.remaining = tm.duration; tm.done = false;
    }
    save();
    syncTicker();
    render();
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    if (mode === "timer" && tm.done) tm.done = false; // looking at it acknowledges the alarm
    save();
    render();
  }

  function commitEdit() {
    var ms = parseDuration(display.value);
    if (ms !== null) { tm.duration = ms; tm.remaining = ms; tm.done = false; save(); }
    display.blur();
    render();
  }

  function init() {
    root = document.getElementById("pbClock");
    if (!root) return;
    display = document.getElementById("clockDisplay");
    startBtn = document.getElementById("clockStartPauseButton");
    resetBtn = document.getElementById("clockResetButton");
    swBtn = document.getElementById("clockStopwatchButton");
    tmBtn = document.getElementById("clockTimerButton");

    swBtn.addEventListener("click", function () { setMode("stopwatch"); });
    tmBtn.addEventListener("click", function () { setMode("timer"); });
    startBtn.addEventListener("click", startPause);
    resetBtn.addEventListener("click", reset);

    display.addEventListener("focus", function () {
      if (!display.readOnly) display.select();
    });
    display.addEventListener("keydown", function (e) {
      if (display.readOnly) return;
      if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
      if (e.key === "Escape") { e.preventDefault(); display.blur(); render(); }
    });
    display.addEventListener("blur", function () {
      if (mode === "timer" && !tm.running) {
        var ms = parseDuration(display.value);
        if (ms !== null) { tm.duration = ms; tm.remaining = ms; tm.done = false; save(); }
      }
      render();
    });

    load();
    syncTicker();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
