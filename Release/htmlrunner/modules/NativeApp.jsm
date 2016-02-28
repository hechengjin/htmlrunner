/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

this.EXPORTED_SYMBOLS = ["NativeApp"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/WebappOSUtils.jsm");
Cu.import("resource://gre/modules/AppsUtils.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Promise.jsm");

const DEFAULT_ICON_URL = "chrome://global/skin/icons/webapps-64.png";

const ERR_NOT_INSTALLED = "The application isn't installed";
const ERR_UPDATES_UNSUPPORTED_OLD_NAMING_SCHEME =
  "Updates for apps installed with the old naming scheme unsupported";

// 0755
const PERMS_DIRECTORY = OS.Constants.libc.S_IRWXU |
                        OS.Constants.libc.S_IRGRP | OS.Constants.libc.S_IXGRP |
                        OS.Constants.libc.S_IROTH | OS.Constants.libc.S_IXOTH;

// 0644
const PERMS_FILE = OS.Constants.libc.S_IRUSR | OS.Constants.libc.S_IWUSR |
                   OS.Constants.libc.S_IRGRP |
                   OS.Constants.libc.S_IROTH;

const DESKTOP_DIR = OS.Constants.Path.desktopDir;
const HOME_DIR = OS.Constants.Path.homeDir;
const TMP_DIR = OS.Constants.Path.tmpDir;

/**
 * This function implements the common constructor for
 * the Windows, Mac and Linux native app shells. It sets
 * the app unique name. It's meant to be called as
 * CommonNativeApp.call(this, ...) from the platform-specific
 * constructor.
 *
 * @param aApp {Object} the app object provided to the install function
 * @param aManifest {Object} the manifest data provided by the web app
 * @param aCategories {Array} array of app categories
 * @param aRegistryDir {String} (optional) path to the registry
 *
 */
function CommonNativeApp(aApp, aManifest, aCategories, aRegistryDir) {
  // Set the name property of the app object, otherwise
  // WebappOSUtils::getUniqueName won't work.
  aApp.name = aManifest.name;
  this.uniqueName = WebappOSUtils.getUniqueName(aApp);

  let localeManifest =
    new ManifestHelper(aManifest, aApp.origin, aApp.manifestURL);

  this.appLocalizedName = localeManifest.name;
  this.appNameAsFilename = stripStringForFilename(aApp.name);

  if (aApp.updateManifest) {
    this.isPackaged = true;
  }

  this.categories = aCategories.slice(0);

  this.registryDir = aRegistryDir || OS.Constants.Path.profileDir;

  this._dryRun = false;
  try {
    if (Services.prefs.getBoolPref("browser.mozApps.installer.dry_run")) {
      this._dryRun = true;
    }
  } catch (ex) {}
}

CommonNativeApp.prototype = {
  uniqueName: null,
  appLocalizedName: null,
  appNameAsFilename: null,
  iconURI: null,
  developerName: null,
  shortDescription: null,
  categories: null,
  webappJson: null,
  runtimeFolder: null,
  manifest: null,
  registryDir: null,

  /**
   * This function reads and parses the data from the app
   * manifest and stores it in the NativeApp object.
   *
   * @param aManifest {Object} the manifest data provided by the web app
   *
   */
  _setData: function(aApp, aManifest) {
    let manifest = new ManifestHelper(aManifest, aApp.origin, aApp.manifestURL);
    let origin = Services.io.newURI(aApp.origin, null, null);

    this.iconURI = Services.io.newURI(manifest.biggestIconURL || DEFAULT_ICON_URL,
                                      null, null);

    if (manifest.developer) {
      if (manifest.developer.name) {
        let devName = manifest.developer.name.substr(0, 128);
        if (devName) {
          this.developerName = devName;
        }
      }

      if (manifest.developer.url) {
        this.developerUrl = manifest.developer.url;
      }
    }

    if (manifest.description) {
      let firstLine = manifest.description.split("\n")[0];
      let shortDesc = firstLine.length <= 256
                      ? firstLine
                      : firstLine.substr(0, 253) + "…";
      this.shortDescription = shortDesc;
    } else {
      this.shortDescription = this.appLocalizedName;
    }

    if (manifest.version) {
      this.version = manifest.version;
    }

    this.webappJson = {
      // The app registry is the Firefox profile from which the app
      // was installed.
      "registryDir": this.registryDir,
      "app": {
        "manifest": aManifest,
        "origin": aApp.origin,
        "manifestURL": aApp.manifestURL,
        "installOrigin": aApp.installOrigin,
        "categories": this.categories,
        "receipts": aApp.receipts,
        "installTime": aApp.installTime,
      }
    };

    if (aApp.etag) {
      this.webappJson.app.etag = aApp.etag;
    }

    if (aApp.packageEtag) {
      this.webappJson.app.packageEtag = aApp.packageEtag;
    }

    if (aApp.updateManifest) {
      this.webappJson.app.updateManifest = aApp.updateManifest;
    }

    this.runtimeFolder = OS.Constants.Path.libDir;
  },

  /**
   * This function retrieves the icon for an app.
   * If the retrieving fails, it uses the default chrome icon.
   */
  _getIcon: function(aTmpDir) {
    try {
      // If the icon is in the zip package, we should modify the url
      // to point to the zip file (we can't use the app protocol yet
      // because the app isn't installed yet).
      if (this.iconURI.scheme == "app") {
        let zipUrl = OS.Path.toFileURI(OS.Path.join(aTmpDir,
                                                    this.zipFile));

        let filePath = this.iconURI.QueryInterface(Ci.nsIURL).filePath;

        this.iconURI = Services.io.newURI("jar:" + zipUrl + "!" + filePath,
                                          null, null);
      }


      let [ mimeType, icon ] = yield downloadIcon(this.iconURI);
      yield this._processIcon(mimeType, icon, aTmpDir);
    }
    catch(e) {
      Cu.reportError("Failure retrieving icon: " + e);

      let iconURI = Services.io.newURI(DEFAULT_ICON_URL, null, null);

      let [ mimeType, icon ] = yield downloadIcon(iconURI);
      yield this._processIcon(mimeType, icon, aTmpDir);

      // Set the iconURI property so that the user notification will have the
      // correct icon.
      this.iconURI = iconURI;
    }
  },

  /**
   * Creates the profile to be used for this app.
   */
  createProfile: function() {
    if (this._dryRun) {
      return null;
    }

    let profSvc = Cc["@mozilla.org/toolkit/profile-service;1"].
                  getService(Ci.nsIToolkitProfileService);

    try {
      let appProfile = profSvc.createDefaultProfileForApp(this.uniqueName,
                                                          null, null);
      return appProfile.localDir;
    } catch (ex if ex.result == Cr.NS_ERROR_ALREADY_INITIALIZED) {
      return null;
    }
  },
};

//@line 225 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\NativeApp.jsm"

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const PROGS_DIR = OS.Constants.Path.winStartMenuProgsDir;
const APP_DATA_DIR = OS.Constants.Path.winAppDataDir;

/*************************************
 * Windows app installer
 *
 * The Windows installation process will generate the following files:
 *
 * ${FolderName} = sanitized app name + "-" + manifest url hash
 *
 * %APPDATA%/${FolderName}
 *   - webapp.ini
 *   - webapp.json
 *   - ${AppName}.exe
 *   - ${AppName}.lnk
 *   / uninstall
 *     - webapp-uninstaller.exe
 *     - shortcuts_log.ini
 *     - uninstall.log
 *   / chrome/icons/default/
 *     - default.ico
 *
 * After the app runs for the first time, a profiles/ folder will also be
 * created which will host the user profile for this app.
 */

/**
 * Constructor for the Windows native app shell
 *
 * @param aApp {Object} the app object provided to the install function
 * @param aManifest {Object} the manifest data provided by the web app
 * @param aCategories {Array} array of app categories
 * @param aRegistryDir {String} (optional) path to the registry
 */
function NativeApp(aApp, aManifest, aCategories, aRegistryDir) {
  CommonNativeApp.call(this, aApp, aManifest, aCategories, aRegistryDir);

  if (this.isPackaged) {
    this.size = aApp.updateManifest.size / 1024;
  }

  this.webapprt = this.appNameAsFilename + ".exe";
  this.configJson = "webapp.json";
  this.webappINI = "webapp.ini";
  this.iconPath = OS.Path.join("chrome", "icons", "default", "default.ico");
  this.uninstallDir = "uninstall";
  this.uninstallerFile = OS.Path.join(this.uninstallDir,
                                      "webapp-uninstaller.exe");
  this.shortcutLogsINI = OS.Path.join(this.uninstallDir, "shortcuts_log.ini");
  this.zipFile = "application.zip";

  this.backupFiles = [ "chrome", this.configJson, this.webappINI, "uninstall" ];
  if (this.isPackaged) {
    this.backupFiles.push(this.zipFile);
  }

  this.uninstallSubkeyStr = this.uniqueName;
}

NativeApp.prototype = {
  __proto__: CommonNativeApp.prototype,
  size: null,

  /**
   * Creates a native installation of the web app in the OS
   *
   * @param aManifest {Object} the manifest data provided by the web app
   * @param aZipPath {String} path to the zip file for packaged apps (undefined
   *                          for hosted apps)
   */
  install: Task.async(function*(aApp, aManifest, aZipPath) {
    if (this._dryRun) {
      return;
    }

    // If the application is already installed, this is a reinstallation.
    if (WebappOSUtils.getInstallPath(aApp)) {
      return yield this.prepareUpdate(aApp, aManifest, aZipPath);
    }

    this._setData(aApp, aManifest);

    let installDir = OS.Path.join(APP_DATA_DIR, this.uniqueName);

    // Create a temporary installation directory.
    let dir = getFile(TMP_DIR, this.uniqueName);
    dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, PERMS_DIRECTORY);
    let tmpDir = dir.path;

    // Perform the installation in the temp directory.
    try {
      yield this._createDirectoryStructure(tmpDir);
      yield this._getShortcutName(installDir);
      yield this._copyWebapprt(tmpDir);
      yield this._copyUninstaller(tmpDir);
      yield this._createConfigFiles(tmpDir);

      if (aZipPath) {
        yield OS.File.move(aZipPath, OS.Path.join(tmpDir, this.zipFile));
      }

      yield this._getIcon(tmpDir);
    } catch (ex) {
      yield OS.File.removeDir(tmpDir, { ignoreAbsent: true });
      throw ex;
    }

    // Apply the installation.
    this._removeInstallation(true, installDir);

    try {
      yield this._applyTempInstallation(tmpDir, installDir);
    } catch (ex) {
      this._removeInstallation(false, installDir);
      yield OS.File.removeDir(tmpDir, { ignoreAbsent: true });
      throw ex;
    }
  }),

  /**
   * Creates an update in a temporary directory to be applied later.
   *
   * @param aManifest {Object} the manifest data provided by the web app
   * @param aZipPath {String} path to the zip file for packaged apps (undefined
   *                          for hosted apps)
   */
  prepareUpdate: Task.async(function*(aApp, aManifest, aZipPath) {
    if (this._dryRun) {
      return;
    }

    this._setData(aApp, aManifest);

    let installDir = WebappOSUtils.getInstallPath(aApp);
    if (!installDir) {
      throw ERR_NOT_INSTALLED;
    }

    if (this.uniqueName != OS.Path.basename(installDir)) {
      // Bug 919799: If the app is still in the registry, migrate its data to
      // the new format.
      throw ERR_UPDATES_UNSUPPORTED_OLD_NAMING_SCHEME;
    }

    let updateDir = OS.Path.join(installDir, "update");
    yield OS.File.removeDir(updateDir, { ignoreAbsent: true });
    yield OS.File.makeDir(updateDir);

    // Perform the update in the "update" subdirectory.
    try {
      yield this._createDirectoryStructure(updateDir);
      yield this._getShortcutName(installDir);
      yield this._copyUninstaller(updateDir);
      yield this._createConfigFiles(updateDir);

      if (aZipPath) {
        yield OS.File.move(aZipPath, OS.Path.join(updateDir, this.zipFile));
      }

      yield this._getIcon(updateDir);
    } catch (ex) {
      yield OS.File.removeDir(updateDir, { ignoreAbsent: true });
      throw ex;
    }
  }),

  /**
   * Applies an update.
   */
  applyUpdate: Task.async(function*(aApp) {
    if (this._dryRun) {
      return;
    }

    let installDir = WebappOSUtils.getInstallPath(aApp);
    let updateDir = OS.Path.join(installDir, "update");

    yield this._getShortcutName(installDir);

    let backupDir = yield this._backupInstallation(installDir);

    try {
      yield this._applyTempInstallation(updateDir, installDir);
    } catch (ex) {
      yield this._restoreInstallation(backupDir, installDir);
      throw ex;
    } finally {
      yield OS.File.removeDir(backupDir, { ignoreAbsent: true });
      yield OS.File.removeDir(updateDir, { ignoreAbsent: true });
    }
  }),

  _applyTempInstallation: Task.async(function*(aTmpDir, aInstallDir) {
    yield moveDirectory(aTmpDir, aInstallDir);

    this._createShortcutFiles(aInstallDir);
    this._writeSystemKeys(aInstallDir);
  }),

  _getShortcutName: Task.async(function*(aInstallDir) {
    let shortcutLogsINIfile = getFile(aInstallDir, this.shortcutLogsINI);

    if (shortcutLogsINIfile.exists()) {
      // If it's a reinstallation (or an update) get the shortcut names
      // from the shortcut_log.ini file
      let parser = Cc["@mozilla.org/xpcom/ini-processor-factory;1"].
                   getService(Ci.nsIINIParserFactory).
                   createINIParser(shortcutLogsINIfile);
      this.shortcutName = parser.getString("STARTMENU", "Shortcut0");
    } else {
      // Check in both directories to see if a shortcut with the same name
      // already exists.
      this.shortcutName = yield getAvailableFileName([ PROGS_DIR, DESKTOP_DIR ],
                                                     this.appNameAsFilename,
                                                     ".lnk");
    }
  }),

  /**
   * Remove the current installation
   */
  _removeInstallation: function(keepProfile, aInstallDir) {
    let uninstallKey;
    try {
      uninstallKey = Cc["@mozilla.org/windows-registry-key;1"].
                     createInstance(Ci.nsIWindowsRegKey);
      uninstallKey.open(uninstallKey.ROOT_KEY_CURRENT_USER,
                        "SOFTWARE\\Microsoft\\Windows\\" +
                        "CurrentVersion\\Uninstall",
                        uninstallKey.ACCESS_WRITE);
      if (uninstallKey.hasChild(this.uninstallSubkeyStr)) {
        uninstallKey.removeChild(this.uninstallSubkeyStr);
      }
    } catch (e) {
    } finally {
      if (uninstallKey) {
        uninstallKey.close();
      }
    }

    let filesToRemove = [ OS.Path.join(DESKTOP_DIR, this.shortcutName),
                          OS.Path.join(PROGS_DIR, this.shortcutName) ];

    if (keepProfile) {
      for (let filePath of this.backupFiles) {
        filesToRemove.push(OS.Path.join(aInstallDir, filePath));
      }

      filesToRemove.push(OS.Path.join(aInstallDir, this.webapprt));
    } else {
      filesToRemove.push(aInstallDir);
    }

    removeFiles(filesToRemove);
  },

  _backupInstallation: Task.async(function*(aInstallDir) {
    let backupDir = OS.Path.join(aInstallDir, "backup");
    yield OS.File.removeDir(backupDir, { ignoreAbsent: true });
    yield OS.File.makeDir(backupDir);

    for (let filePath of this.backupFiles) {
      yield OS.File.move(OS.Path.join(aInstallDir, filePath),
                         OS.Path.join(backupDir, filePath));
    }

    return backupDir;
  }),

  _restoreInstallation: function(aBackupDir, aInstallDir) {
    return moveDirectory(aBackupDir, aInstallDir);
  },

  /**
   * Creates the main directory structure.
   */
  _createDirectoryStructure: Task.async(function*(aDir) {
    yield OS.File.makeDir(OS.Path.join(aDir, this.uninstallDir));

    yield OS.File.makeDir(OS.Path.join(aDir, OS.Path.dirname(this.iconPath)),
                          { from: aDir });
  }),

  /**
   * Copy the webrt executable into the installation directory.
   */
  _copyWebapprt: function(aDir) {
    return OS.File.copy(OS.Path.join(this.runtimeFolder, "webapprt-stub.exe"),
                        OS.Path.join(aDir, this.webapprt));
  },

  /**
   * Copy the uninstaller executable into the installation directory.
   */
  _copyUninstaller: function(aDir) {
    return OS.File.copy(OS.Path.join(this.runtimeFolder, "webapp-uninstaller.exe"),
                        OS.Path.join(aDir, this.uninstallerFile));
  },

  /**
   * Creates the configuration files into their destination folders.
   */
  _createConfigFiles: function(aDir) {
    // ${InstallDir}/webapp.json
    yield writeToFile(OS.Path.join(aDir, this.configJson),
                      JSON.stringify(this.webappJson));

    let factory = Cc["@mozilla.org/xpcom/ini-processor-factory;1"].
                  getService(Ci.nsIINIParserFactory);

    // ${InstallDir}/webapp.ini
    let webappINIfile = getFile(aDir, this.webappINI);

    let writer = factory.createINIParser(webappINIfile)
                        .QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("Webapp", "Name", this.appLocalizedName);
    writer.setString("Webapp", "Profile", this.uniqueName);
    writer.setString("Webapp", "Executable", this.appNameAsFilename);
    writer.setString("WebappRT", "InstallDir", this.runtimeFolder);
    writer.writeFile(null, Ci.nsIINIParserWriter.WRITE_UTF16);

    let shortcutLogsINIfile = getFile(aDir, this.shortcutLogsINI);

    writer = factory.createINIParser(shortcutLogsINIfile)
                    .QueryInterface(Ci.nsIINIParserWriter);
    writer.setString("STARTMENU", "Shortcut0", this.shortcutName);
    writer.setString("DESKTOP", "Shortcut0", this.shortcutName);
    writer.setString("TASKBAR", "Migrated", "true");
    writer.writeFile(null, Ci.nsIINIParserWriter.WRITE_UTF16);

    // ${UninstallDir}/uninstall.log
    let uninstallContent =
      "File: \\webapp.ini\r\n" +
      "File: \\webapp.json\r\n" +
      "File: \\webapprt.old\r\n" +
      "File: \\chrome\\icons\\default\\default.ico";
    if (this.isPackaged) {
      uninstallContent += "\r\nFile: \\application.zip";
    }

    yield writeToFile(OS.Path.join(aDir, this.uninstallDir, "uninstall.log"),
                      uninstallContent);
  },

  /**
   * Writes the keys to the system registry that are necessary for the app
   * operation and uninstall process.
   */
  _writeSystemKeys: function(aInstallDir) {
    let parentKey;
    let uninstallKey;
    let subKey;

    try {
      parentKey = Cc["@mozilla.org/windows-registry-key;1"].
                  createInstance(Ci.nsIWindowsRegKey);
      parentKey.open(parentKey.ROOT_KEY_CURRENT_USER,
                     "SOFTWARE\\Microsoft\\Windows\\CurrentVersion",
                     parentKey.ACCESS_WRITE);
      uninstallKey = parentKey.createChild("Uninstall", parentKey.ACCESS_WRITE)
      subKey = uninstallKey.createChild(this.uninstallSubkeyStr,
                                        uninstallKey.ACCESS_WRITE);

      subKey.writeStringValue("DisplayName", this.appLocalizedName);

      let uninstallerPath = OS.Path.join(aInstallDir, this.uninstallerFile);

      subKey.writeStringValue("UninstallString", '"' + uninstallerPath + '"');
      subKey.writeStringValue("InstallLocation", '"' + aInstallDir + '"');
      subKey.writeStringValue("AppFilename", this.appNameAsFilename);
      subKey.writeStringValue("DisplayIcon", OS.Path.join(aInstallDir,
                                                          this.iconPath));

      let date = new Date();
      let year = date.getYear().toString();
      let month = date.getMonth();
      if (month < 10) {
        month = "0" + month;
      }
      let day = date.getDate();
      if (day < 10) {
        day = "0" + day;
      }
      subKey.writeStringValue("InstallDate", year + month + day);
      if (this.version) {
        subKey.writeStringValue("DisplayVersion", this.version);
      }
      if (this.developerName) {
        subKey.writeStringValue("Publisher", this.developerName);
      }
      subKey.writeStringValue("URLInfoAbout", this.developerUrl);
      if (this.size) {
        subKey.writeIntValue("EstimatedSize", this.size);
      }

      subKey.writeIntValue("NoModify", 1);
      subKey.writeIntValue("NoRepair", 1);
    } catch(ex) {
      throw ex;
    } finally {
      if(subKey) subKey.close();
      if(uninstallKey) uninstallKey.close();
      if(parentKey) parentKey.close();
    }
  },

  /**
   * Creates a shortcut file inside the app installation folder and makes
   * two copies of it: one into the desktop and one into the start menu.
   */
  _createShortcutFiles: function(aInstallDir) {
    let shortcut = getFile(aInstallDir, this.shortcutName).
                      QueryInterface(Ci.nsILocalFileWin);

    /* function nsILocalFileWin.setShortcut(targetFile, workingDir, args,
                                            description, iconFile, iconIndex) */

    shortcut.setShortcut(getFile(aInstallDir, this.webapprt),
                         getFile(aInstallDir),
                         null,
                         this.shortDescription,
                         getFile(aInstallDir, this.iconPath),
                         0);

    shortcut.copyTo(getFile(DESKTOP_DIR), this.shortcutName);
    shortcut.copyTo(getFile(PROGS_DIR), this.shortcutName);

    shortcut.followLinks = false;
    shortcut.remove(false);
  },

  /**
   * Process the icon from the imageStream as retrieved from
   * the URL by getIconForApp(). This will save the icon to the
   * topwindow.ico file.
   *
   * @param aMimeType     the icon mimetype
   * @param aImageStream  the stream for the image data
   * @param aDir          the directory where the icon should be stored
   */
  _processIcon: function(aMimeType, aImageStream, aDir) {
    let deferred = Promise.defer();

    let imgTools = Cc["@mozilla.org/image/tools;1"].
                   createInstance(Ci.imgITools);

    let imgContainer = imgTools.decodeImage(aImageStream, aMimeType);
    let iconStream = imgTools.encodeImage(imgContainer,
                                          "image/vnd.microsoft.icon",
                                          "format=bmp;bpp=32");

    let tmpIconFile = getFile(aDir, this.iconPath);

    let outputStream = FileUtils.openSafeFileOutputStream(tmpIconFile);
    NetUtil.asyncCopy(iconStream, outputStream, function(aResult) {
      if (Components.isSuccessCode(aResult)) {
        deferred.resolve();
      } else {
        deferred.reject("Failure copying icon: " + aResult);
      }
    });

    return deferred.promise;
  }
}
//@line 227 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\NativeApp.jsm"

//@line 237 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\NativeApp.jsm"

/* Helper Functions */

/**
 * Async write a data string into a file
 *
 * @param aPath     the path to the file to write to
 * @param aData     a string with the data to be written
 */
function writeToFile(aPath, aData) {
  return Task.spawn(function() {
    let data = new TextEncoder().encode(aData);

    let file;
    try {
      file = yield OS.File.open(aPath, { truncate: true, write: true },
                                { unixMode: PERMS_FILE });
      yield file.write(data);
    } finally {
      yield file.close();
    }
  });
}

/**
 * Strips all non-word characters from the beginning and end of a string.
 * Strips invalid characters from the string.
 *
 */
function stripStringForFilename(aPossiblyBadFilenameString) {
  // Strip everything from the front up to the first [0-9a-zA-Z]
  let stripFrontRE = new RegExp("^\\W*", "gi");

  // Strip white space characters starting from the last [0-9a-zA-Z]
  let stripBackRE = new RegExp("\\s*$", "gi");

  // Strip invalid characters from the filename
  let filenameRE = new RegExp("[<>:\"/\\\\|\\?\\*]", "gi");

  let stripped = aPossiblyBadFilenameString.replace(stripFrontRE, "");
  stripped = stripped.replace(stripBackRE, "");
  stripped = stripped.replace(filenameRE, "");

  // If the filename ends up empty, let's call it "webapp".
  if (stripped == "") {
    stripped = "webapp";
  }

  return stripped;
}

/**
 * Finds a unique name available in a folder (i.e., non-existent file)
 *
 * @param aPathSet a set of paths that represents the set of
 * directories where we want to write
 * @param aName   string with the filename (minus the extension) desired
 * @param aExtension string with the file extension, including the dot

 * @return file name or null if folder is unwritable or unique name
 *         was not available
 */
function getAvailableFileName(aPathSet, aName, aExtension) {
  return Task.spawn(function*() {
    let name = aName + aExtension;

    function checkUnique(aName) {
      return Task.spawn(function*() {
        for (let path of aPathSet) {
          if (yield OS.File.exists(OS.Path.join(path, aName))) {
            return false;
          }
        }

        return true;
      });
    }

    if (yield checkUnique(name)) {
      return name;
    }

    // If we're here, the plain name wasn't enough. Let's try modifying the name
    // by adding "(" + num + ")".
    for (let i = 2; i < 100; i++) {
      name = aName + " (" + i + ")" + aExtension;

      if (yield checkUnique(name)) {
        return name;
      }
    }

    throw "No available filename";
  });
}

/**
 * Attempts to remove files or directories.
 *
 * @param aPaths An array with paths to files to remove
 */
function removeFiles(aPaths) {
  for (let path of aPaths) {
    let file = getFile(path);

    try {
      if (file.exists()) {
        file.followLinks = false;
        file.remove(true);
      }
    } catch(ex) {}
  }
}

/**
 * Move (overwriting) the contents of one directory into another.
 *
 * @param srcPath A path to the source directory
 * @param destPath A path to the destination directory
 */
function moveDirectory(srcPath, destPath) {
  let srcDir = getFile(srcPath);
  let destDir = getFile(destPath);

  let entries = srcDir.directoryEntries;
  let array = [];
  while (entries.hasMoreElements()) {
    let entry = entries.getNext().QueryInterface(Ci.nsIFile);
    if (entry.isDirectory()) {
      yield moveDirectory(entry.path, OS.Path.join(destPath, entry.leafName));
    } else {
      entry.moveTo(destDir, entry.leafName);
    }
  }

  // The source directory is now empty, remove it.
  yield OS.File.removeEmptyDir(srcPath);
}

function escapeXML(aStr) {
  return aStr.toString()
             .replace(/&/g, "&amp;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&apos;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;");
}

// Helper to create a nsIFile from a set of path components
function getFile() {
  let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(OS.Path.join.apply(OS.Path, arguments));
  return file;
}

// Download an icon using either a temp file or a pipe.
function downloadIcon(aIconURI) {
  let deferred = Promise.defer();

  let mimeService = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
  let mimeType;
  try {
    let tIndex = aIconURI.path.indexOf(";");
    if("data" == aIconURI.scheme && tIndex != -1) {
      mimeType = aIconURI.path.substring(0, tIndex);
    } else {
      mimeType = mimeService.getTypeFromURI(aIconURI);
     }
  } catch(e) {
    deferred.reject("Failed to determine icon MIME type: " + e);
    return deferred.promise;
  }

  function onIconDownloaded(aStatusCode, aIcon) {
    if (Components.isSuccessCode(aStatusCode)) {
      deferred.resolve([ mimeType, aIcon ]);
    } else {
      deferred.reject("Failure downloading icon: " + aStatusCode);
    }
  }

  try {
//@line 434 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\NativeApp.jsm"
    let pipe = Cc["@mozilla.org/pipe;1"]
                 .createInstance(Ci.nsIPipe);
    pipe.init(true, true, 0, 0xffffffff, null);

    let listener = Cc["@mozilla.org/network/simple-stream-listener;1"]
                     .createInstance(Ci.nsISimpleStreamListener);
    listener.init(pipe.outputStream, {
        onStartRequest: function() {},
        onStopRequest: function(aRequest, aContext, aStatusCode) {
          pipe.outputStream.close();
          onIconDownloaded(aStatusCode, pipe.inputStream);
       }
    });
//@line 448 "e:\hg38\comm-esr38\mozilla\toolkit\webapps\NativeApp.jsm"

    // If not fetching an icon from chrome:// then we should create a
    // NoAppCodeBasePrincipal. Note, that we are still in the process of
    // installing the app, hence app.origin is not available yet and
    // therefore we can not call getAppCodebasePrincipal.
    let principal =
      aIconURI.schemeIs("chrome") ? Services.scriptSecurityManager
                                            .getSystemPrincipal()
                                  : Services.scriptSecurityManager
                                            .getNoAppCodebasePrincipal(aIconURI);

    let channel = NetUtil.newChannel2(aIconURI,
                                      null,
                                      null,
                                      null,      // aLoadingNode
                                      principal,
                                      null,      // aTriggeringPrincipal
                                      Ci.nsILoadInfo.SEC_NORMAL,
                                      Ci.nsIContentPolicy.TYPE_IMAGE);
    let { BadCertHandler } = Cu.import("resource://gre/modules/CertUtils.jsm", {});
    // Pass true to avoid optional redirect-cert-checking behavior.
    channel.notificationCallbacks = new BadCertHandler(true);

    channel.asyncOpen(listener, null);
  } catch(e) {
    deferred.reject("Failure initiating download of icon: " + e);
  }

  return deferred.promise;
}
