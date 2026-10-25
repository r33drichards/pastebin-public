// Preview preferences stay in their tenant. Normal installs retain existing keys.
(function () {
  'use strict';
  const prefix = String(window.pbinStoragePrefix || '');
  window.pbinStorage = Object.freeze({
    getItem(key) { return window.localStorage.getItem(prefix + key); },
    setItem(key, value) { return window.localStorage.setItem(prefix + key, value); },
    removeItem(key) { return window.localStorage.removeItem(prefix + key); }
  });
})();
