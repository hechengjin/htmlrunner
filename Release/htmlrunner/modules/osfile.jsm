/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Common front for various implementations of OS.File
 */

if (typeof Components != "undefined") {
  this.EXPORTED_SYMBOLS = ["OS"];
  Components.utils.import("resource://gre/modules/osfile/osfile_async_front.jsm", this);
} else {
  // At this stage, we need to import all sources at once to avoid
  // a unique failure on tbpl + talos that seems caused by a
  // what looks like a nested event loop bug (see bug 794091).
//@line 17 "e:\hg38\comm-esr38\mozilla\toolkit\components\osfile\osfile.jsm"
  importScripts(
    "resource://gre/modules/workers/require.js",
    "resource://gre/modules/osfile/osfile_win_back.jsm",
    "resource://gre/modules/osfile/osfile_shared_front.jsm",
    "resource://gre/modules/osfile/osfile_win_front.jsm"
  );
//@line 31 "e:\hg38\comm-esr38\mozilla\toolkit\components\osfile\osfile.jsm"
  OS.Path = require("resource://gre/modules/osfile/ospath.jsm");
}
