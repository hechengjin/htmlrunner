/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 6 "e:\hg38\comm-esr38\mozilla\xulrunner\app\xulrunner.js"

// We need to override the default values of these preferences since all.js
// assumes these are in the navigator package, which for us is nonexistent.
// XXX(darin): perhaps all.js should not be seamonkey specific
pref("general.useragent.locale", "en-US");
pref("xpinstall.dialog.confirm", "chrome://mozapps/content/xpinstall/xpinstallConfirm.xul");
pref("xpinstall.dialog.progress.chrome", "chrome://mozapps/content/extensions/extensions.xul");
pref("xpinstall.dialog.progress.skin", "chrome://mozapps/content/extensions/extensions.xul");
pref("xpinstall.dialog.progress.type.chrome", "Extension:Manager");
pref("xpinstall.dialog.progress.type.skin", "Extension:Manager");
pref("xpinstall.enabled", true);
//@line 18 "e:\hg38\comm-esr38\mozilla\xulrunner\app\xulrunner.js"
pref("browser.preferences.instantApply", false);
//@line 25 "e:\hg38\comm-esr38\mozilla\xulrunner\app\xulrunner.js"
pref("browser.preferences.animateFadeIn", false);
