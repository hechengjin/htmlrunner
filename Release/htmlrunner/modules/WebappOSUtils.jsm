/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { classes: Cc, interfaces: Ci, results: Cr, utils: Cu, Constructor: CC } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Promise.jsm");

//@line 16 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"

this.EXPORTED_SYMBOLS = ["WebappOSUtils"];

// Returns the MD5 hash of a string.
function computeHash(aString) {
  let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                  createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  let result = {};
  // Data is an array of bytes.
  let data = converter.convertToByteArray(aString, result);

  let hasher = Cc["@mozilla.org/security/hash;1"].
               createInstance(Ci.nsICryptoHash);
  hasher.init(hasher.MD5);
  hasher.update(data, data.length);
  // We're passing false to get the binary hash and not base64.
  let hash = hasher.finish(false);

  function toHexString(charCode) {
    return ("0" + charCode.toString(16)).slice(-2);
  }

  // Convert the binary hash data to a hex string.
  return [toHexString(hash.charCodeAt(i)) for (i in hash)].join("");
}

this.WebappOSUtils = {
  getUniqueName: function(aApp) {
    return this.sanitizeStringForFilename(aApp.name).toLowerCase() + "-" +
           computeHash(aApp.manifestURL);
  },

//@line 50 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
  /**
   * Returns the registry key associated to the given app and a boolean that
   * specifies whether we're using the old naming scheme or the new one.
   */
  getAppRegKey: function(aApp) {
    let regKey = Cc["@mozilla.org/windows-registry-key;1"].
                 createInstance(Ci.nsIWindowsRegKey);

    try {
      regKey.open(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" +
                  this.getUniqueName(aApp), Ci.nsIWindowsRegKey.ACCESS_READ);

      return { value: regKey,
               namingSchemeVersion: 2};
    } catch (ex) {}

    // Fall back to the old installation naming scheme
    try {
      regKey.open(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" +
                  aApp.origin, Ci.nsIWindowsRegKey.ACCESS_READ);

      return { value: regKey,
               namingSchemeVersion: 1 };
    } catch (ex) {}

    return null;
  },
//@line 80 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"

  /**
   * Returns the executable of the given app, identifying it by its unique name,
   * which is in either the new format or the old format.
   * On Mac OS X, it returns the identifier of the app.
   *
   * The new format ensures a readable and unique name for an app by combining
   * its name with a hash of its manifest URL.  The old format uses its origin,
   * which is only unique until we support multiple apps per origin.
   */
  getLaunchTarget: function(aApp) {
//@line 92 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
    let appRegKey = this.getAppRegKey(aApp);

    if (!appRegKey) {
      return null;
    }

    let appFilename, installLocation;
    try {
      appFilename = appRegKey.value.readStringValue("AppFilename");
      installLocation = appRegKey.value.readStringValue("InstallLocation");
    } catch (ex) {
      return null;
    } finally {
      appRegKey.value.close();
    }

    installLocation = installLocation.substring(1, installLocation.length - 1);

    if (appRegKey.namingSchemeVersion == 1 &&
        !this.isOldInstallPathValid(aApp, installLocation)) {
      return null;
    }

    let initWithPath = CC("@mozilla.org/file/local;1",
                          "nsILocalFile", "initWithPath");
    let launchTarget = initWithPath(installLocation);
    launchTarget.append(appFilename + ".exe");

    return launchTarget;
//@line 171 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
  },

  getInstallPath: function(aApp) {
//@line 227 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
    // Anything unsupported, like Metro
    throw new Error("Unsupported apps platform");
  },

  getPackagePath: function(aApp) {
    let packagePath = this.getInstallPath(aApp);

    // Only for Firefox on Mac OS X
//@line 240 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"

    return packagePath;
  },

  launch: function(aApp) {
    let uniqueName = this.getUniqueName(aApp);

//@line 248 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
    let launchTarget = this.getLaunchTarget(aApp);
    if (!launchTarget) {
      return false;
    }

    try {
      let process = Cc["@mozilla.org/process/util;1"].
                    createInstance(Ci.nsIProcess);

      process.init(launchTarget);
      process.runwAsync([], 0);
    } catch (e) {
      return false;
    }

    return true;
//@line 298 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
  },

  uninstall: function(aApp) {
//@line 302 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
    let appRegKey = this.getAppRegKey(aApp);

    if (!appRegKey) {
      return Promise.reject("App registry key not found");
    }

    let deferred = Promise.defer();

    try {
      let uninstallerPath = appRegKey.value.readStringValue("UninstallString");
      uninstallerPath = uninstallerPath.substring(1, uninstallerPath.length - 1);

      let uninstaller = Cc["@mozilla.org/file/local;1"].
                        createInstance(Ci.nsIFile);
      uninstaller.initWithPath(uninstallerPath);

      let process = Cc["@mozilla.org/process/util;1"].
                    createInstance(Ci.nsIProcess);
      process.init(uninstaller);
      process.runwAsync(["/S"], 1, (aSubject, aTopic) => {
        if (aTopic == "process-finished") {
          deferred.resolve(true);
        } else {
          deferred.reject("Uninstaller failed with exit code: " + aSubject.exitValue);
        }
      });
    } catch (e) {
      deferred.reject(e);
    } finally {
      appRegKey.value.close();
    }

    return deferred.promise;
//@line 381 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
  },

  /**
   * Returns true if the given install path (in the old naming scheme) actually
   * belongs to the given application.
   */
  isOldInstallPathValid: function(aApp, aInstallPath) {
    // Applications with an origin that starts with "app" are packaged apps and
    // packaged apps have never been installed using the old naming scheme.
    // After bug 910465, we'll have a better way to check if an app is
    // packaged.
    if (aApp.origin.startsWith("app")) {
      return false;
    }

    // Bug 915480: We could check the app name from the manifest to
    // better verify the installation path.
    return true;
  },

  /**
   * Checks if the given app is locally installed.
   */
  isLaunchable: function(aApp) {
    let uniqueName = this.getUniqueName(aApp);

//@line 408 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
    if (!this.getLaunchTarget(aApp)) {
      return false;
    }

    return true;
//@line 465 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\WebappOSUtils.jsm"
  },

  /**
   * Sanitize the filename (accepts only a-z, 0-9, - and _)
   */
  sanitizeStringForFilename: function(aPossiblyBadFilenameString) {
    return aPossiblyBadFilenameString.replace(/[^a-z0-9_\-]/gi, "");
  }
}
