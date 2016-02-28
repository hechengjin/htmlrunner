/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

this.EXPORTED_SYMBOLS = ["Services"];

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cr = Components.results;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

this.Services = {};

XPCOMUtils.defineLazyGetter(Services, "prefs", function () {
  return Cc["@mozilla.org/preferences-service;1"]
           .getService(Ci.nsIPrefService)
           .QueryInterface(Ci.nsIPrefBranch);
});

XPCOMUtils.defineLazyGetter(Services, "appinfo", function () {
  let appinfo = Cc["@mozilla.org/xre/app-info;1"]
                  .getService(Ci.nsIXULRuntime);
  try {
    appinfo.QueryInterface(Ci.nsIXULAppInfo);
  } catch (ex if ex instanceof Components.Exception &&
                 ex.result == Cr.NS_NOINTERFACE) {
    // Not all applications implement nsIXULAppInfo (e.g. xpcshell doesn't).
  }
  return appinfo;
});

XPCOMUtils.defineLazyGetter(Services, "dirsvc", function () {
  return Cc["@mozilla.org/file/directory_service;1"]
           .getService(Ci.nsIDirectoryService)
           .QueryInterface(Ci.nsIProperties);
});

//@line 40 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
XPCOMUtils.defineLazyGetter(Services, "crashmanager", () => {
  let ns = {};
  Components.utils.import("resource://gre/modules/CrashManager.jsm", ns);

  return ns.CrashManager.Singleton;
});
//@line 47 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"

let initTable = [
//@line 52 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
  ["appShell", "@mozilla.org/appshell/appShellService;1", "nsIAppShellService"],
  ["cache", "@mozilla.org/network/cache-service;1", "nsICacheService"],
  ["cache2", "@mozilla.org/netwerk/cache-storage-service;1", "nsICacheStorageService"],
  ["console", "@mozilla.org/consoleservice;1", "nsIConsoleService"],
  ["contentPrefs", "@mozilla.org/content-pref/service;1", "nsIContentPrefService"],
  ["cookies", "@mozilla.org/cookiemanager;1", "nsICookieManager2"],
  ["downloads", "@mozilla.org/download-manager;1", "nsIDownloadManager"],
  ["droppedLinkHandler", "@mozilla.org/content/dropped-link-handler;1", "nsIDroppedLinkHandler"],
  ["eTLD", "@mozilla.org/network/effective-tld-service;1", "nsIEffectiveTLDService"],
  ["io", "@mozilla.org/network/io-service;1", "nsIIOService2"],
  ["locale", "@mozilla.org/intl/nslocaleservice;1", "nsILocaleService"],
  ["logins", "@mozilla.org/login-manager;1", "nsILoginManager"],
  ["obs", "@mozilla.org/observer-service;1", "nsIObserverService"],
  ["perms", "@mozilla.org/permissionmanager;1", "nsIPermissionManager"],
  ["prompt", "@mozilla.org/embedcomp/prompt-service;1", "nsIPromptService"],
//@line 68 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
  ["profiler", "@mozilla.org/tools/profiler;1", "nsIProfiler"],
//@line 70 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
  ["scriptloader", "@mozilla.org/moz/jssubscript-loader;1", "mozIJSSubScriptLoader"],
  ["scriptSecurityManager", "@mozilla.org/scriptsecuritymanager;1", "nsIScriptSecurityManager"],
//@line 73 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
  ["search", "@mozilla.org/browser/search-service;1", "nsIBrowserSearchService"],
//@line 75 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
  ["storage", "@mozilla.org/storage/service;1", "mozIStorageService"],
  ["domStorageManager", "@mozilla.org/dom/localStorage-manager;1", "nsIDOMStorageManager"],
  ["strings", "@mozilla.org/intl/stringbundle;1", "nsIStringBundleService"],
  ["telemetry", "@mozilla.org/base/telemetry;1", "nsITelemetry"],
  ["tm", "@mozilla.org/thread-manager;1", "nsIThreadManager"],
  ["urlFormatter", "@mozilla.org/toolkit/URLFormatterService;1", "nsIURLFormatter"],
  ["vc", "@mozilla.org/xpcom/version-comparator;1", "nsIVersionComparator"],
  ["wm", "@mozilla.org/appshell/window-mediator;1", "nsIWindowMediator"],
  ["ww", "@mozilla.org/embedcomp/window-watcher;1", "nsIWindowWatcher"],
  ["startup", "@mozilla.org/toolkit/app-startup;1", "nsIAppStartup"],
  ["sysinfo", "@mozilla.org/system-info;1", "nsIPropertyBag2"],
  ["clipboard", "@mozilla.org/widget/clipboard;1", "nsIClipboard"],
  ["DOMRequest", "@mozilla.org/dom/dom-request-service;1", "nsIDOMRequestService"],
  ["focus", "@mozilla.org/focus-manager;1", "nsIFocusManager"],
  ["uriFixup", "@mozilla.org/docshell/urifixup;1", "nsIURIFixup"],
  ["blocklist", "@mozilla.org/extensions/blocklist;1", "nsIBlocklistService"],
//@line 96 "e:\hg38\comm-esr38\mozilla\toolkit\modules\Services.jsm"
];

initTable.forEach(function ([name, contract, intf])
  XPCOMUtils.defineLazyServiceGetter(Services, name, contract, intf));

initTable = undefined;
