// Tauri spike mock for window.settings / window.utils.
// Real Electron preload runs FIRST and populates these objects; this script
// detects that and bails out. In Tauri (no preload), this fills in stub values
// so the React app can boot to render — no real persistence, no real IPC.
//
// IIFE is intentional: it must run at module-evaluation time (before reducer.ts
// imports trigger `createStore` → reducer init → window.settings.* calls).
// Listed in package.json's `sideEffects` so webpack does NOT tree-shake it.

(function () {
  if (typeof window.settings === "object" && window.settings !== null) {
    return; // Electron preload already set up — do nothing.
  }

  var noop = function () {};
  var asyncNoop = function () { return Promise.resolve(); };
  var listenerNoop = function () {};

  window.settings = {
    saveGroups: noop,
    loadGroups: function () { return []; },

    getDefaultMenu: function () { return false; },
    setDefaultMenu: noop,

    getProxyStatus: function () { return false; },
    toggleProxyStatus: noop,
    getProxy: function () { return ""; },
    setProxy: noop,

    getDefaultView: function () { return 0; }, // ViewType.Cards
    setDefaultView: noop,

    getThemeSettings: function () { return "system"; },
    setThemeSettings: noop,
    shouldUseDarkColors: function () {
      return window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
    },
    addThemeUpdateListener: listenerNoop,

    setLocaleSettings: function (option) {
      try { localStorage.setItem("spike-locale", option); } catch (e) {}
    },
    getLocaleSettings: function () {
      try { return localStorage.getItem("spike-locale") || "default"; }
      catch (e) { return "default"; }
    },
    getCurrentLocale: function () {
      var stored = null;
      try { stored = localStorage.getItem("spike-locale"); } catch (e) {}
      if (stored && stored !== "default") return stored;
      return navigator.language || "en-US";
    },

    getFontSize: function () { return 16; },
    setFontSize: noop,

    getFont: function () { return ""; },
    setFont: noop,

    getFetchInterval: function () { return 0; },
    setFetchInterval: noop,

    getSearchEngine: function () { return 0; }, // Google
    setSearchEngine: noop,

    getServiceConfigs: function () { return { type: 0 }; }, // SyncService.None
    setServiceConfigs: noop,

    getFilterType: function () { return 0; },
    setFilterType: noop,

    getViewConfigs: function () { return 0; },
    setViewConfigs: noop,

    getNeDBStatus: function () { return false; },
    setNeDBStatus: noop,

    getUnreadSourcesOnly: function () { return false; },
    setUnreadSourcesOnly: noop,

    getAll: function () { return {}; },
    setAll: noop,
  };

  window.utils = {
    platform: "win32",

    getVersion: function () { return "1.2.2-spike"; },

    openExternal: function (url) {
      try { window.open(url, "_blank"); } catch (e) { /* ignore */ }
    },

    showErrorBox: function (title, content) {
      console.error("[mock showErrorBox]", title, content);
    },
    showMessageBox: function () { return Promise.resolve(false); },
    showSaveDialog: function () { return Promise.resolve(null); },
    showOpenDialog: function () { return Promise.resolve(null); },

    getCacheSize: function () { return Promise.resolve(0); },
    clearCache: asyncNoop,

    addMainContextListener: listenerNoop,
    addWebviewContextListener: listenerNoop,
    imageCallback: noop,

    addWebviewKeydownListener: listenerNoop,
    addWebviewErrorListener: listenerNoop,

    writeClipboard: function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
    },

    closeWindow: noop,
    minimizeWindow: noop,
    maximizeWindow: noop,
    isMaximized: function () { return false; },
    isFullscreen: function () { return false; },
    isFocused: function () { return true; },
    focus: noop,
    requestAttention: noop,
    addWindowStateListener: listenerNoop,

    addTouchBarEventsListener: listenerNoop,
    initTouchBar: noop,
    destroyTouchBar: noop,

    initFontList: function () { return Promise.resolve([]); },
  };

  console.log("[spike-mock] window.settings / window.utils stubs installed.");
})();
