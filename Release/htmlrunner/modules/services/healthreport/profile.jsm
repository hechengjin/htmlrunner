/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 6 "e:\hg38\comm-esr38\mozilla\services\healthreport\profile.jsm"

"use strict";

this.EXPORTED_SYMBOLS = [
  "ProfileTimesAccessor",
  "ProfileMetadataProvider",
];

const {utils: Cu, classes: Cc, interfaces: Ci} = Components;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

Cu.import("resource://gre/modules/Metrics.jsm");

//@line 21 "e:\hg38\comm-esr38\mozilla\services\healthreport\profile.jsm"

const DEFAULT_PROFILE_MEASUREMENT_NAME = "age";
const DEFAULT_PROFILE_MEASUREMENT_VERSION = 2;
const REQUIRED_UINT32_TYPE = {type: "TYPE_UINT32"};

Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/osfile.jsm")
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");

// Profile access to times.json (eg, creation/reset time).
// This is separate from the provider to simplify testing and enable extraction
// to a shared location in the future.
this.ProfileTimesAccessor = function(profile, log) {
  this.profilePath = profile || OS.Constants.Path.profileDir;
  if (!this.profilePath) {
    throw new Error("No profile directory.");
  }
  this._log = log || {"debug": function (s) { dump(s + "\n"); }};
}
this.ProfileTimesAccessor.prototype = {
  /**
   * There are three ways we can get our creation time:
   *
   * 1. From our own saved value (to avoid redundant work).
   * 2. From the on-disk JSON file.
   * 3. By calculating it from the filesystem.
   *
   * If we have to calculate, we write out the file; if we have
   * to touch the file, we persist in-memory.
   *
   * @return a promise that resolves to the profile's creation time.
   */
  get created() {
    function onSuccess(times) {
      if (times.created) {
        return times.created;
      }
      return onFailure.call(this, null, times);
    }

    function onFailure(err, times) {
      return this.computeAndPersistCreated(times)
                 .then(function onSuccess(created) {
                         return created;
                       }.bind(this));
    }

    return this.getTimes()
               .then(onSuccess.bind(this),
                     onFailure.bind(this));
  },

  /**
   * Explicitly make `file`, a filename, a full path
   * relative to our profile path.
   */
  getPath: function (file) {
    return OS.Path.join(this.profilePath, file);
  },

  /**
   * Return a promise which resolves to the JSON contents
   * of the time file, using the already read value if possible.
   */
  getTimes: function (file="times.json") {
    if (this._times) {
      return Promise.resolve(this._times);
    }
    return this.readTimes(file).then(
      times => {
        return this.times = times || {};
      }
    );
  },

  /**
   * Return a promise which resolves to the JSON contents
   * of the time file in this accessor's profile.
   */
  readTimes: function (file="times.json") {
    return CommonUtils.readJSON(this.getPath(file));
  },

  /**
   * Return a promise representing the writing of `contents`
   * to `file` in the specified profile.
   */
  writeTimes: function (contents, file="times.json") {
    return CommonUtils.writeJSON(contents, this.getPath(file));
  },

  /**
   * Merge existing contents with a 'created' field, writing them
   * to the specified file. Promise, naturally.
   */
  computeAndPersistCreated: function (existingContents, file="times.json") {
    let path = this.getPath(file);
    function onOldest(oldest) {
      let contents = existingContents || {};
      contents.created = oldest;
      this._times = contents;
      return this.writeTimes(contents, path)
                 .then(function onSuccess() {
                   return oldest;
                 });
    }

    return this.getOldestProfileTimestamp()
               .then(onOldest.bind(this));
  },

  /**
   * Traverse the contents of the profile directory, finding the oldest file
   * and returning its creation timestamp.
   */
  getOldestProfileTimestamp: function () {
    let self = this;
    let oldest = Date.now() + 1000;
    let iterator = new OS.File.DirectoryIterator(this.profilePath);
    self._log.debug("Iterating over profile " + this.profilePath);
    if (!iterator) {
      throw new Error("Unable to fetch oldest profile entry: no profile iterator.");
    }

    function onEntry(entry) {
      function onStatSuccess(info) {
        // OS.File doesn't seem to be behaving. See Bug 827148.
        // Let's do the best we can. This whole function is defensive.
        let date = info.winBirthDate || info.macBirthDate;
        if (!date || !date.getTime()) {
          // OS.File will only return file creation times of any kind on Mac
          // and Windows, where birthTime is defined.
          // That means we're unable to function on Linux, so we use mtime
          // instead.
          self._log.debug("No birth date. Using mtime.");
          date = info.lastModificationDate;
        }

        if (date) {
          let timestamp = date.getTime();
          self._log.debug("Using date: " + entry.path + " = " + date);
          if (timestamp < oldest) {
            oldest = timestamp;
          }
        }
      }

      function onStatFailure(e) {
        // Never mind.
        self._log.debug("Stat failure: " + CommonUtils.exceptionStr(e));
      }

      return OS.File.stat(entry.path)
                    .then(onStatSuccess, onStatFailure);
    }

    let promise = iterator.forEach(onEntry);

    function onSuccess() {
      iterator.close();
      return oldest;
    }

    function onFailure(reason) {
      iterator.close();
      throw new Error("Unable to fetch oldest profile entry: " + reason);
    }

    return promise.then(onSuccess, onFailure);
  },

  /**
   * Record (and persist) when a profile reset happened.  We just store a
   * single value - the timestamp of the most recent reset - but there is scope
   * to keep a list of reset times should our health-reporter successor
   * be able to make use of that.
   * Returns a promise that is resolved once the file has been written.
   */
  recordProfileReset: function (time=Date.now(), file="times.json") {
    return this.getTimes(file).then(
      times => {
        times.reset = time;
        return this.writeTimes(times, file);
      }
    );
  },

  /* Returns a promise that resolves to the time the profile was reset,
   * or undefined if not recorded.
   */
  get reset() {
    return this.getTimes().then(
      times => times.reset
    );
  },
}

/**
 * Measurements pertaining to the user's profile.
 */
// This is "version 1" of the metadata measurement - it must remain, but
// it's currently unused - see bug 1063714 comment 12 for why.
function ProfileMetadataMeasurement() {
  Metrics.Measurement.call(this);
}
ProfileMetadataMeasurement.prototype = {
  __proto__: Metrics.Measurement.prototype,

  name: DEFAULT_PROFILE_MEASUREMENT_NAME,
  version: 1,

  fields: {
    // Profile creation date. Number of days since Unix epoch.
    profileCreation: {type: Metrics.Storage.FIELD_LAST_NUMERIC},
  },
};

// This is the current measurement - it adds the profileReset value.
function ProfileMetadataMeasurement2() {
  Metrics.Measurement.call(this);
}
ProfileMetadataMeasurement2.prototype = {
  __proto__: Metrics.Measurement.prototype,

  name: DEFAULT_PROFILE_MEASUREMENT_NAME,
  version: DEFAULT_PROFILE_MEASUREMENT_VERSION,

  fields: {
    // Profile creation date. Number of days since Unix epoch.
    profileCreation: {type: Metrics.Storage.FIELD_LAST_NUMERIC},
    // Profile reset date. Number of days since Unix epoch.
    profileReset: {type: Metrics.Storage.FIELD_LAST_NUMERIC},
  },
};

/**
 * Turn a millisecond timestamp into a day timestamp.
 *
 * @param msec a number of milliseconds since epoch.
 * @return the number of whole days denoted by the input.
 */
function truncate(msec) {
  return Math.floor(msec / MILLISECONDS_PER_DAY);
}

/**
 * A Metrics.Provider for profile metadata, such as profile creation and
 * reset time.
 */
this.ProfileMetadataProvider = function() {
  Metrics.Provider.call(this);
}
this.ProfileMetadataProvider.prototype = {
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.profile",

  measurementTypes: [ProfileMetadataMeasurement2],

  pullOnly: true,

  getProfileDays: Task.async(function* () {
    let result = {};
    let accessor = new ProfileTimesAccessor(null, this._log);

    let created = yield accessor.created;
    result["profileCreation"] = truncate(created);
    let reset = yield accessor.reset;
    if (reset) {
      result["profileReset"] = truncate(reset);
    }
    return result;
  }),

  collectConstantData: function () {
    let m = this.getMeasurement(DEFAULT_PROFILE_MEASUREMENT_NAME,
                                DEFAULT_PROFILE_MEASUREMENT_VERSION);

    return Task.spawn(function* collectConstants() {
      let days = yield this.getProfileDays();

      yield this.enqueueStorageOperation(function storeDays() {
        return Task.spawn(function* () {
          yield m.setLastNumeric("profileCreation", days["profileCreation"]);
          if (days["profileReset"]) {
            yield m.setLastNumeric("profileReset", days["profileReset"]);
          }
        });
      });
    }.bind(this));
  },
};
