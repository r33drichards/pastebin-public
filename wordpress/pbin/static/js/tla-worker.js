// TLA+ model checker — Web Worker
//
// The TLA+ check (`check_spec_*`) is a single synchronous WASM call that can
// explore up to 100k states. Running it on the main thread freezes the UI and
// makes the Cancel button a no-op. This module worker runs it off-thread so the
// page stays responsive and Cancel can terminate() the work mid-check.
//
// Served same-origin from /static/, so it is COOP/COEP (require-corp) safe and
// inherits the document's cross-origin isolation.

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const m = await import('/static/wasm/tla-checker/tla_checker.js');
      await m.default({ module_or_path: '/static/wasm/tla-checker/tla_checker_bg.wasm' });
      return m;
    })();
  }
  return modulePromise;
}

self.onmessage = async (e) => {
  const { spec, cfg, options } = e.data || {};
  try {
    const m = await getModule();
    let resultJson;
    if (cfg) {
      // check_spec_with_cfg(spec, cfg, constants_json, max_states, max_depth, allow_deadlock, export_dot)
      resultJson = m.check_spec_with_cfg(spec, cfg, '{}', 100000, 100, false, false);
    } else {
      resultJson = m.check_spec_with_options(spec, options);
    }
    self.postMessage({ ok: true, resultJson });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
