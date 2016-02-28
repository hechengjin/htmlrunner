/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/osfile.jsm");


const ROOT_BRANCH = "datareporting.";
const POLICY_BRANCH = ROOT_BRANCH + "policy.";
const SESSIONS_BRANCH = ROOT_BRANCH + "sessions.";
const HEALTHREPORT_BRANCH = ROOT_BRANCH + "healthreport.";
const HEALTHREPORT_LOGGING_BRANCH = HEALTHREPORT_BRANCH + "logging.";
const DEFAULT_LOAD_DELAY_MSEC = 10 * 1000;
const DEFAULT_LOAD_DELAY_FIRST_RUN_MSEC = 60 * 1000;

/**
 * The Firefox Health Report XPCOM service.
 *
 * External consumers will be interested in the "reporter" property of this
 * service. This property is a `HealthReporter` instance that powers the
 * service. The property may be null if the Health Report service is not
 * enabled.
 *
 * EXAMPLE USAGE
 * =============
 *
 * let reporter = Cc["@mozilla.org/datareporting/service;1"]
 *                  .getService(Ci.nsISupports)
 *                  .wrappedJSObject
 *                  .healthReporter;
 *
 * if (reporter.haveRemoteData) {
 *   // ...
 * }
 *
 * IMPLEMENTATION NOTES
 * ====================
 *
 * In order to not adversely impact application start time, the `HealthReporter`
 * instance is not initialized until a few seconds after "final-ui-startup."
 * The exact delay is configurable via preferences so it can be adjusted with
 * a hotfix extension if the default value is ever problematic. Because of the
 * overhead with the initial creation of the database, the first run is delayed
 * even more than subsequent runs. This does mean that the first moments of
 * browser activity may be lost by FHR.
 *
 * Shutdown of the `HealthReporter` instance is handled completely within the
 * instance (it registers observers on initialization). See the notes on that
 * type for more.
 */
this.DataReportingService = function () {
  this.wrappedJSObject = this;

  this._quitting = false;

  this._os = Cc["@mozilla.org/observer-service;1"]
               .getService(Ci.nsIObserverService);

  this._clientID = null;
  this._loadClientIdTask = null;
  this._saveClientIdTask = null;

  this._stateDir = null;
  this._stateFilePath = null;

  // Used for testing only, when true results in getSessionRecorder() returning
  // undefined. Controlled via simulate* methods.
  this._simulateNoSessionRecorder = false;
}

DataReportingService.prototype = Object.freeze({
  classID: Components.ID("{41f6ae36-a79f-4613-9ac3-915e70f83789}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference]),

  //---------------------------------------------
  // Start of policy listeners.
  //---------------------------------------------

  /**
   * Called when policy requests data upload.
   */
  onRequestDataUpload: function (request) {
    if (!this.healthReporter) {
      return;
    }

    this.healthReporter.requestDataUpload(request);
  },

  onNotifyDataPolicy: function (request) {
    Observers.notify("datareporting:notify-data-policy:request", request);
  },

  onRequestRemoteDelete: function (request) {
    if (!this.healthReporter) {
      return;
    }

    this.healthReporter.deleteRemoteData(request);
  },

  //---------------------------------------------
  // End of policy listeners.
  //---------------------------------------------

  observe: function observe(subject, topic, data) {
    switch (topic) {
      case "app-startup":
        this._os.addObserver(this, "profile-after-change", true);
        break;

      case "profile-after-change":
        this._os.removeObserver(this, "profile-after-change");

        try {
          this._prefs = new Preferences(HEALTHREPORT_BRANCH);

          // We don't initialize the sessions recorder unless Health Report is
          // around to provide pruning of data.
          //
          // FUTURE consider having the SessionsRecorder always enabled and/or
          // living in its own XPCOM service.
          if (this._prefs.get("service.enabled", true)) {
            this.sessionRecorder = new SessionRecorder(SESSIONS_BRANCH);
            this.sessionRecorder.onStartup();
          }

          // We can't interact with prefs until after the profile is present.
          let policyPrefs = new Preferences(POLICY_BRANCH);
          this.policy = new DataReportingPolicy(policyPrefs, this._prefs, this);

          this._stateDir = OS.Path.join(OS.Constants.Path.profileDir, "datareporting");
          this._stateFilePath = OS.Path.join(this._stateDir, "state.json");

          this._os.addObserver(this, "sessionstore-windows-restored", true);
        } catch (ex) {
          Cu.reportError("Exception when initializing data reporting service: " +
                         CommonUtils.exceptionStr(ex));
        }
        break;

      case "sessionstore-windows-restored":
        this._os.removeObserver(this, "sessionstore-windows-restored");
        this._os.addObserver(this, "quit-application", false);

        let policy = this.policy;
        policy.startPolling();

        // Don't initialize Firefox Health Reporter collection and submission
        // service unless it is enabled.
        if (!this._prefs.get("service.enabled", true)) {
          return;
        }

        let haveFirstRun = this._prefs.get("service.firstRun", false);
        let delayInterval;

        if (haveFirstRun) {
          delayInterval = this._prefs.get("service.loadDelayMsec") ||
                          DEFAULT_LOAD_DELAY_MSEC;
        } else {
          delayInterval = this._prefs.get("service.loadDelayFirstRunMsec") ||
                          DEFAULT_LOAD_DELAY_FIRST_RUN_MSEC;
        }

        // Delay service loading a little more so things have an opportunity
        // to cool down first.
        this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this.timer.initWithCallback({
          notify: function notify() {
            delete this.timer;

            // There could be a race between "quit-application" firing and
            // this callback being invoked. We close that door.
            if (this._quitting) {
              return;
            }

            // Side effect: instantiates the reporter instance if not already
            // accessed.
            //
            // The instance installs its own shutdown observers. So, we just
            // fire and forget: it will clean itself up.
            let reporter = this.healthReporter;
            policy.ensureUserNotified();
          }.bind(this),
        }, delayInterval, this.timer.TYPE_ONE_SHOT);

        break;

      case "quit-application":
        this._os.removeObserver(this, "quit-application");
        this._quitting = true;

        // Shutdown doesn't clear pending timers. So, we need to explicitly
        // cancel our health reporter initialization timer or else it will
        // attempt initialization after shutdown has commenced. This would
        // likely lead to stalls or crashes.
        if (this.timer) {
          this.timer.cancel();
        }

        if (this.policy) {
          this.policy.stopPolling();
        }
        break;
    }
  },

  /**
   * The HealthReporter instance associated with this service.
   *
   * If the service is disabled, this will return null.
   *
   * The obtained instance may not be fully initialized.
   */
  get healthReporter() {
    if (!this._prefs.get("service.enabled", true)) {
      return null;
    }

    if ("_healthReporter" in this) {
      return this._healthReporter;
    }

    try {
      this._loadHealthReporter();
    } catch (ex) {
      this._healthReporter = null;
      Cu.reportError("Exception when obtaining health reporter: " +
                     CommonUtils.exceptionStr(ex));
    }

    return this._healthReporter;
  },

  _loadHealthReporter: function () {
    // This should never happen. It was added to help trace down bug 924307.
    if (!this.policy) {
      throw new Error("this.policy not set.");
    }

    let ns = {};
    // Lazy import so application startup isn't adversely affected.

    Cu.import("resource://gre/modules/Task.jsm", ns);
    Cu.import("resource://gre/modules/HealthReport.jsm", ns);
    Cu.import("resource://gre/modules/Log.jsm", ns);

    // How many times will we rewrite this code before rolling it up into a
    // generic module? See also bug 451283.
    const LOGGERS = [
      "Services.DataReporting",
      "Services.HealthReport",
      "Services.Metrics",
      "Services.BagheeraClient",
      "Sqlite.Connection.healthreport",
    ];

    let loggingPrefs = new Preferences(HEALTHREPORT_LOGGING_BRANCH);
    if (loggingPrefs.get("consoleEnabled", true)) {
      let level = loggingPrefs.get("consoleLevel", "Warn");
      let appender = new ns.Log.ConsoleAppender();
      appender.level = ns.Log.Level[level] || ns.Log.Level.Warn;

      for (let name of LOGGERS) {
        let logger = ns.Log.repository.getLogger(name);
        logger.addAppender(appender);
      }
    }

    if (loggingPrefs.get("dumpEnabled", false)) {
      let level = loggingPrefs.get("dumpLevel", "Debug");
      let appender = new ns.Log.DumpAppender();
      appender.level = ns.Log.Level[level] || ns.Log.Level.Debug;

      for (let name of LOGGERS) {
        let logger = ns.Log.repository.getLogger(name);
        logger.addAppender(appender);
      }
    }

    this._healthReporter = new ns.HealthReporter(HEALTHREPORT_BRANCH,
                                                 this.policy,
                                                 this.sessionRecorder);

    // Wait for initialization to finish so if a shutdown occurs before init
    // has finished we don't adversely affect app startup on next run.
    this._healthReporter.init().then(function onInit() {
      this._prefs.set("service.firstRun", true);
    }.bind(this));
  },

  _loadClientID: function () {
    if (this._loadClientIdTask) {
      return this._loadClientIdTask;
    }

    this._loadClientIdTask = Task.spawn(function* () {
      // Previously we had the stable client ID managed in FHR.
      // As we want to start correlating FHR and telemetry data (and moving towards
      // unifying the two), we moved the ID management to the datareporting
      // service. Consequently, we try to import the FHR ID first, so we can keep
      // using it.

      // Try to load the client id from the DRS state file first.
      try {
        let state = yield CommonUtils.readJSON(this._stateFilePath);
        if (state && 'clientID' in state && typeof(state.clientID) == 'string') {
          this._clientID = state.clientID;
          this._loadClientIdTask = null;
          return this._clientID;
        }
      } catch (e) {
        // fall through to next option
      }

      // If we dont have DRS state yet, try to import from the FHR state.
      try {
        let fhrStatePath = OS.Path.join(OS.Constants.Path.profileDir, "healthreport", "state.json");
        let state = yield CommonUtils.readJSON(fhrStatePath);
        if (state && 'clientID' in state && typeof(state.clientID) == 'string') {
          this._clientID = state.clientID;
          this._loadClientIdTask = null;
          this._saveClientID();
          return this._clientID;
        }
      } catch (e) {
        // fall through to next option
      }

      // We dont have an id from FHR yet, generate a new ID.
      this._clientID = CommonUtils.generateUUID();
      this._loadClientIdTask = null;
      this._saveClientIdTask = this._saveClientID();

      // Wait on persisting the id. Otherwise failure to save the ID would result in
      // the client creating and subsequently sending multiple IDs to the server.
      // This would appear as multiple clients submitting similar data, which would
      // result in orphaning.
      yield this._saveClientIdTask;

      return this._clientID;
    }.bind(this));

    return this._loadClientIdTask;
  },

  _saveClientID: Task.async(function* () {
    let obj = { clientID: this._clientID };
    yield OS.File.makeDir(this._stateDir);
    yield CommonUtils.writeJSON(obj, this._stateFilePath);
    this._saveClientIdTask = null;
  }),

  /**
   * This returns a promise resolving to the the stable client ID we use for
   * data reporting (FHR & Telemetry). Previously exising FHR client IDs are
   * migrated to this.
   *
   * @return Promise<string> The stable client ID.
   */
  getClientID: function() {
    if (!this._clientID) {
      return this._loadClientID();
    }

    return Promise.resolve(this._clientID);
  },

  /**
   * Reset the stable client id.
   *
   * @return Promise<string> The new client ID.
   */
  resetClientID: Task.async(function* () {
    yield this._loadClientIdTask;
    yield this._saveClientIdTask;

    this._clientID = CommonUtils.generateUUID();
    this._saveClientIdTask = this._saveClientID();
    yield this._saveClientIdTask;

    return this._clientID;
  }),

  /**
   * Returns the SessionRecorder instance associated with the data reporting service.
   * Returns an actual object only if FHR is enabled and after initialization,
   * else returns undefined.
   */
  getSessionRecorder: function() {
    return this._simulateNoSessionRecorder ? undefined : this.sessionRecorder;
  },

  // These two simulate* methods below are only used for testings and control
  // whether getSessionRecorder() behaves normally or forced to return undefined
  simulateNoSessionRecorder() {
    this._simulateNoSessionRecorder = true;
  },

  simulateRestoreSessionRecorder() {
    this._simulateNoSessionRecorder = false;
  },

  /*
   * Simulate a restart of the service. This is for testing only.
   */
  _reset: Task.async(function* () {
    yield this._loadClientIdTask;
    yield this._saveClientIdTask;
    this._clientID = null;
  }),
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([DataReportingService]);

//@line 430 "e:\hg38\comm-esr38\mozilla\services\datareporting\DataReportingService.js"

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 15 "e:\hg38\comm-esr38\mozilla\services\common\observers.js"

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

/**
 * A service for adding, removing and notifying observers of notifications.
 * Wraps the nsIObserverService interface.
 *
 * @version 0.2
 */
this.Observers = {
  /**
   * Register the given callback as an observer of the given topic.
   *
   * @param   topic       {String}
   *          the topic to observe
   *
   * @param   callback    {Object}
   *          the callback; an Object that implements nsIObserver or a Function
   *          that gets called when the notification occurs
   *
   * @param   thisObject  {Object}  [optional]
   *          the object to use as |this| when calling a Function callback
   *
   * @returns the observer
   */
  add: function(topic, callback, thisObject) {
    let observer = new Observer(topic, callback, thisObject);
    this._cache.push(observer);
    this._service.addObserver(observer, topic, true);

    return observer;
  },

  /**
   * Unregister the given callback as an observer of the given topic.
   *
   * @param topic       {String}
   *        the topic being observed
   *
   * @param callback    {Object}
   *        the callback doing the observing
   *
   * @param thisObject  {Object}  [optional]
   *        the object being used as |this| when calling a Function callback
   */
  remove: function(topic, callback, thisObject) {
    // This seems fairly inefficient, but I'm not sure how much better
    // we can make it.  We could index by topic, but we can't index by callback
    // or thisObject, as far as I know, since the keys to JavaScript hashes
    // (a.k.a. objects) can apparently only be primitive values.
    let [observer] = this._cache.filter(function(v) v.topic      == topic    &&
                                                    v.callback   == callback &&
                                                    v.thisObject == thisObject);
    if (observer) {
      this._service.removeObserver(observer, topic);
      this._cache.splice(this._cache.indexOf(observer), 1);
    }
  },

  /**
   * Notify observers about something.
   *
   * @param topic   {String}
   *        the topic to notify observers about
   *
   * @param subject {Object}  [optional]
   *        some information about the topic; can be any JS object or primitive
   *
   * @param data    {String}  [optional] [deprecated]
   *        some more information about the topic; deprecated as the subject
   *        is sufficient to pass all needed information to the JS observers
   *        that this module targets; if you have multiple values to pass to
   *        the observer, wrap them in an object and pass them via the subject
   *        parameter (i.e.: { foo: 1, bar: "some string", baz: myObject })
   */
  notify: function(topic, subject, data) {
    subject = (typeof subject == "undefined") ? null : new Subject(subject);
       data = (typeof    data == "undefined") ? null : data;
    this._service.notifyObservers(subject, topic, data);
  },

  _service: Cc["@mozilla.org/observer-service;1"].
            getService(Ci.nsIObserverService),

  /**
   * A cache of observers that have been added.
   *
   * We use this to remove observers when a caller calls |remove|.
   *
   * XXX This might result in reference cycles, causing memory leaks,
   * if we hold a reference to an observer that holds a reference to us.
   * Could we fix that by making this an independent top-level object
   * rather than a property of this object?
   */
  _cache: []
};


function Observer(topic, callback, thisObject) {
  this.topic = topic;
  this.callback = callback;
  this.thisObject = thisObject;
}

Observer.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference]),
  observe: function(subject, topic, data) {
    // Extract the wrapped object for subjects that are one of our wrappers
    // around a JS object.  This way we support both wrapped subjects created
    // using this module and those that are real XPCOM components.
    if (subject && typeof subject == "object" &&
        ("wrappedJSObject" in subject) &&
        ("observersModuleSubjectWrapper" in subject.wrappedJSObject))
      subject = subject.wrappedJSObject.object;

    if (typeof this.callback == "function") {
      if (this.thisObject)
        this.callback.call(this.thisObject, subject, data);
      else
        this.callback(subject, data);
    }
    else // typeof this.callback == "object" (nsIObserver)
      this.callback.observe(subject, topic, data);
  }
}


function Subject(object) {
  // Double-wrap the object and set a property identifying the wrappedJSObject
  // as one of our wrappers to distinguish between subjects that are one of our
  // wrappers (which we should unwrap when notifying our observers) and those
  // that are real JS XPCOM components (which we should pass through unaltered).
  this.wrappedJSObject = { observersModuleSubjectWrapper: true, object: object };
}

Subject.prototype = {
  QueryInterface: XPCOMUtils.generateQI([]),
  getHelperForLanguage: function() {},
  getInterfaces: function() {}
};
//@line 432 "e:\hg38\comm-esr38\mozilla\services\datareporting\DataReportingService.js"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file is in transition. Most of its content needs to be moved under
 * /services/healthreport.
 */

//@line 23 "e:\hg38\comm-esr38\mozilla\services\datareporting\policy.jsm"

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://gre/modules/UpdateChannel.jsm");

// The current policy version number. If the version number stored in the prefs
// is smaller than this, data upload will be disabled until the user is re-notified
// about the policy changes.
const DATAREPORTING_POLICY_VERSION = 1;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Used as a sanity lower bound for dates stored in prefs. This module was
// implemented in 2012, so any earlier dates indicate an incorrect clock.
const OLDEST_ALLOWED_YEAR = 2012;

/**
 * Represents a request to display data policy.
 *
 * Receivers of these instances are expected to call one or more of the on*
 * functions when events occur.
 *
 * When one of these requests is received, the first thing a callee should do
 * is present notification to the user of the data policy. When the notice
 * is displayed to the user, the callee should call `onUserNotifyComplete`.
 *
 * If for whatever reason the callee could not display a notice,
 * it should call `onUserNotifyFailed`.
 *
 * @param policy
 *        (DataReportingPolicy) The policy instance this request came from.
 * @param deferred
 *        (deferred) The promise that will be fulfilled when display occurs.
 */
function NotifyPolicyRequest(policy, deferred) {
  this.policy = policy;
  this.deferred = deferred;
}
NotifyPolicyRequest.prototype = Object.freeze({
  /**
   * Called when the user is notified of the policy.
   */
  onUserNotifyComplete: function () {
    return this.deferred.resolve();
   },

  /**
   * Called when there was an error notifying the user about the policy.
   *
   * @param error
   *        (Error) Explains what went wrong.
   */
  onUserNotifyFailed: function (error) {
    return this.deferred.reject(error);
  },
});

/**
 * Represents a request to submit data.
 *
 * Instances of this are created when the policy requests data upload or
 * deletion.
 *
 * Receivers are expected to call one of the provided on* functions to signal
 * completion of the request.
 *
 * Instances of this type should not be instantiated outside of this file.
 * Receivers of instances of this type should not attempt to do anything with
 * the instance except call one of the on* methods.
 */
this.DataSubmissionRequest = function (promise, expiresDate, isDelete) {
  this.promise = promise;
  this.expiresDate = expiresDate;
  this.isDelete = isDelete;

  this.state = null;
  this.reason = null;
}

this.DataSubmissionRequest.prototype = Object.freeze({
  NO_DATA_AVAILABLE: "no-data-available",
  SUBMISSION_SUCCESS: "success",
  SUBMISSION_FAILURE_SOFT: "failure-soft",
  SUBMISSION_FAILURE_HARD: "failure-hard",
  UPLOAD_IN_PROGRESS: "upload-in-progress",

  /**
   * No submission was attempted because no data was available.
   *
   * In the case of upload, this means there is no data to upload (perhaps
   * it isn't available yet). In case of remote deletion, it means that there
   * is no remote data to delete.
   */
  onNoDataAvailable: function onNoDataAvailable() {
    this.state = this.NO_DATA_AVAILABLE;
    this.promise.resolve(this);
    return this.promise.promise;
  },

  /**
   * Data submission has completed successfully.
   *
   * In case of upload, this means the upload completed successfully. In case
   * of deletion, the data was deleted successfully.
   *
   * @param date
   *        (Date) When data submission occurred.
   */
  onSubmissionSuccess: function onSubmissionSuccess(date) {
    this.state = this.SUBMISSION_SUCCESS;
    this.submissionDate = date;
    this.promise.resolve(this);
    return this.promise.promise;
  },

  /**
   * There was a recoverable failure when submitting data.
   *
   * Perhaps the server was down. Perhaps the network wasn't available. The
   * policy may request submission again after a short delay.
   *
   * @param reason
   *        (string) Why the failure occurred. For logging purposes only.
   */
  onSubmissionFailureSoft: function onSubmissionFailureSoft(reason=null) {
    this.state = this.SUBMISSION_FAILURE_SOFT;
    this.reason = reason;
    this.promise.resolve(this);
    return this.promise.promise;
  },

  /**
   * There was an unrecoverable failure when submitting data.
   *
   * Perhaps the client is misconfigured. Perhaps the server rejected the data.
   * Attempts at performing submission again will yield the same result. So,
   * the policy should not try again (until the next day).
   *
   * @param reason
   *        (string) Why the failure occurred. For logging purposes only.
   */
  onSubmissionFailureHard: function onSubmissionFailureHard(reason=null) {
    this.state = this.SUBMISSION_FAILURE_HARD;
    this.reason = reason;
    this.promise.resolve(this);
    return this.promise.promise;
  },

  /**
   * The request was aborted because an upload was already in progress.
   */
  onUploadInProgress: function (reason=null) {
    this.state = this.UPLOAD_IN_PROGRESS;
    this.reason = reason;
    this.promise.resolve(this);
    return this.promise.promise;
  },
});

/**
 * Manages scheduling of Firefox Health Report data submission.
 *
 * The rules of data submission are as follows:
 *
 *  1. Do not submit data more than once every 24 hours.
 *  2. Try to submit as close to 24 hours apart as possible.
 *  3. Do not submit too soon after application startup so as to not negatively
 *     impact performance at startup.
 *  4. Before first ever data submission, the user should be notified about
 *     data collection practices.
 *  5. User should have opportunity to react to this notification before
 *     data submission.
 *  6. If data submission fails, try at most 2 additional times before giving
 *     up on that day's submission.
 *
 * The listener passed into the instance must have the following properties
 * (which are callbacks that will be invoked at certain key events):
 *
 *   * onRequestDataUpload(request) - Called when the policy is requesting
 *     data to be submitted. The function is passed a `DataSubmissionRequest`.
 *     The listener should call one of the special resolving functions on that
 *     instance (see the documentation for that type).
 *
 *   * onRequestRemoteDelete(request) - Called when the policy is requesting
 *     deletion of remotely stored data. The function is passed a
 *     `DataSubmissionRequest`. The listener should call one of the special
 *     resolving functions on that instance (just like `onRequestDataUpload`).
 *
 *   * onNotifyDataPolicy(request) - Called when the policy is requesting the
 *     user to be notified that data submission will occur. The function
 *     receives a `NotifyPolicyRequest` instance. The callee should call one or
 *     more of the functions on that instance when specific events occur. See
 *     the documentation for that type for more.
 *
 * Note that the notification method is abstracted. Different applications
 * can have different mechanisms by which they notify the user of data
 * submission practices.
 *
 * @param policyPrefs
 *        (Preferences) Handle on preferences branch on which state will be
 *        queried and stored.
 * @param healthReportPrefs
 *        (Preferences) Handle on preferences branch holding Health Report state.
 * @param listener
 *        (object) Object with callbacks that will be invoked at certain key
 *        events.
 */
this.DataReportingPolicy = function (prefs, healthReportPrefs, listener) {
  this._log = Log.repository.getLogger("Services.DataReporting.Policy");
  this._log.level = Log.Level["Debug"];

  for (let handler of this.REQUIRED_LISTENERS) {
    if (!listener[handler]) {
      throw new Error("Passed listener does not contain required handler: " +
                      handler);
    }
  }

  this._prefs = prefs;
  this._healthReportPrefs = healthReportPrefs;
  this._listener = listener;
  this._userNotifyPromise = null;

  this._migratePrefs();

  if (!this.firstRunDate.getTime()) {
    // If we've never run before, record the current time.
    this.firstRunDate = this.now();
  }

  // Install an observer so that we can act on changes from external
  // code (such as Android UI).
  // Use a function because this is the only place where the Preferences
  // abstraction is way less usable than nsIPrefBranch.
  //
  // Hang on to the observer here so that tests can reach it.
  this.uploadEnabledObserver = function onUploadEnabledChanged() {
    if (this.pendingDeleteRemoteData || this.healthReportUploadEnabled) {
      // Nothing to do: either we're already deleting because the caller
      // came through the front door (rHRUE), or they set the flag to true.
      return;
    }
    this._log.info("uploadEnabled pref changed. Scheduling deletion.");
    this.deleteRemoteData();
  }.bind(this);

  healthReportPrefs.observe("uploadEnabled", this.uploadEnabledObserver);

  // Ensure we are scheduled to submit.
  if (!this.nextDataSubmissionDate.getTime()) {
    this.nextDataSubmissionDate = this._futureDate(MILLISECONDS_PER_DAY);
  }

  // Record when we last requested for submitted data to be sent. This is
  // to avoid having multiple outstanding requests.
  this._inProgressSubmissionRequest = null;
};

this.DataReportingPolicy.prototype = Object.freeze({
  /**
   *  How often to poll to see if we need to do something.
   *
   * The interval needs to be short enough such that short-lived applications
   * have an opportunity to submit data. But, it also needs to be long enough
   * to not negatively impact performance.
   *
   * The random bit is to ensure that other systems scheduling around the same
   * interval don't all get scheduled together.
   */
  POLL_INTERVAL_MSEC: (60 * 1000) + Math.floor(2.5 * 1000 * Math.random()),

  /**
   * How long individual data submission requests live before expiring.
   *
   * Data submission requests have this long to complete before we give up on
   * them and try again.
   *
   * We want this to be short enough that we retry frequently enough but long
   * enough to give slow networks and systems time to handle it.
   */
  SUBMISSION_REQUEST_EXPIRE_INTERVAL_MSEC: 10 * 60 * 1000,

  /**
   * Our backoff schedule in case of submission failure.
   *
   * This dictates both the number of times we retry a daily submission and
   * when to retry after each failure.
   *
   * Each element represents how long to wait after each recoverable failure.
   * After the first failure, we wait the time in element 0 before trying
   * again. After the second failure, we wait the time in element 1. Once
   * we run out of values in this array, we give up on that day's submission
   * and schedule for a day out.
   */
  FAILURE_BACKOFF_INTERVALS: [
    15 * 60 * 1000,
    60 * 60 * 1000,
  ],

  REQUIRED_LISTENERS: [
    "onRequestDataUpload",
    "onRequestRemoteDelete",
    "onNotifyDataPolicy",
  ],

  /**
   * The first time the health report policy came into existence.
   *
   * This is used for scheduling of the initial submission.
   */
  get firstRunDate() {
    return CommonUtils.getDatePref(this._prefs, "firstRunTime", 0, this._log,
                                   OLDEST_ALLOWED_YEAR);
  },

  set firstRunDate(value) {
    this._log.debug("Setting first-run date: " + value);
    CommonUtils.setDatePref(this._prefs, "firstRunTime", value,
                            OLDEST_ALLOWED_YEAR);
  },

  get dataSubmissionPolicyNotifiedDate() {
    return CommonUtils.getDatePref(this._prefs,
                                   "dataSubmissionPolicyNotifiedTime", 0,
                                   this._log, OLDEST_ALLOWED_YEAR);
  },

  set dataSubmissionPolicyNotifiedDate(value) {
    this._log.debug("Setting user notified date: " + value);
    CommonUtils.setDatePref(this._prefs, "dataSubmissionPolicyNotifiedTime",
                            value, OLDEST_ALLOWED_YEAR);
  },

  get dataSubmissionPolicyBypassNotification() {
    return this._prefs.get("dataSubmissionPolicyBypassNotification", false);
  },

  set dataSubmissionPolicyBypassNotification(value) {
    return this._prefs.set("dataSubmissionPolicyBypassNotification", !!value);
  },

  /**
   * Whether submission of data is allowed.
   *
   * This is the master switch for remote server communication. If it is
   * false, we never request upload or deletion.
   */
  get dataSubmissionEnabled() {
    // Default is true because we are opt-out.
    return this._prefs.get("dataSubmissionEnabled", true);
  },

  set dataSubmissionEnabled(value) {
    this._prefs.set("dataSubmissionEnabled", !!value);
  },

  get currentPolicyVersion() {
    return this._prefs.get("currentPolicyVersion", DATAREPORTING_POLICY_VERSION);
  },

  /**
   * The minimum policy version which for dataSubmissionPolicyAccepted to
   * to be valid.
   */
  get minimumPolicyVersion() {
    // First check if the current channel has an ove
    let channel = UpdateChannel.get(false);
    let channelPref = this._prefs.get("minimumPolicyVersion.channel-" + channel);
    return channelPref !== undefined ?
           channelPref : this._prefs.get("minimumPolicyVersion", 1);
  },

  get dataSubmissionPolicyAcceptedVersion() {
    return this._prefs.get("dataSubmissionPolicyAcceptedVersion", 0);
  },

  set dataSubmissionPolicyAcceptedVersion(value) {
    this._prefs.set("dataSubmissionPolicyAcceptedVersion", value);
  },

  /**
   * Checks to see if the user has been notified about data submission
   * @return {bool}
   */
  get userNotifiedOfCurrentPolicy() {
    return  this.dataSubmissionPolicyNotifiedDate.getTime() > 0 &&
            this.dataSubmissionPolicyAcceptedVersion >= this.currentPolicyVersion;
  },

  /**
   * When this policy last requested data submission.
   *
   * This is used mainly for forensics purposes and should have no bearing
   * on scheduling or run-time behavior.
   */
  get lastDataSubmissionRequestedDate() {
    return CommonUtils.getDatePref(this._healthReportPrefs,
                                   "lastDataSubmissionRequestedTime", 0,
                                   this._log, OLDEST_ALLOWED_YEAR);
  },

  set lastDataSubmissionRequestedDate(value) {
    CommonUtils.setDatePref(this._healthReportPrefs,
                            "lastDataSubmissionRequestedTime",
                            value, OLDEST_ALLOWED_YEAR);
  },

  /**
   * When the last data submission actually occurred.
   *
   * This is used mainly for forensics purposes and should have no bearing on
   * actual scheduling.
   */
  get lastDataSubmissionSuccessfulDate() {
    return CommonUtils.getDatePref(this._healthReportPrefs,
                                   "lastDataSubmissionSuccessfulTime", 0,
                                   this._log, OLDEST_ALLOWED_YEAR);
  },

  set lastDataSubmissionSuccessfulDate(value) {
    CommonUtils.setDatePref(this._healthReportPrefs,
                            "lastDataSubmissionSuccessfulTime",
                            value, OLDEST_ALLOWED_YEAR);
  },

  /**
   * When we last encountered a submission failure.
   *
   * This is used for forensics purposes and should have no bearing on
   * scheduling.
   */
  get lastDataSubmissionFailureDate() {
    return CommonUtils.getDatePref(this._healthReportPrefs,
                                   "lastDataSubmissionFailureTime",
                                   0, this._log, OLDEST_ALLOWED_YEAR);
  },

  set lastDataSubmissionFailureDate(value) {
    CommonUtils.setDatePref(this._healthReportPrefs,
                            "lastDataSubmissionFailureTime",
                            value, OLDEST_ALLOWED_YEAR);
  },

  /**
   * When the next data submission is scheduled to occur.
   *
   * This is maintained internally by this type. External users should not
   * mutate this value.
   */
  get nextDataSubmissionDate() {
    return CommonUtils.getDatePref(this._healthReportPrefs,
                                   "nextDataSubmissionTime", 0,
                                   this._log, OLDEST_ALLOWED_YEAR);
  },

  set nextDataSubmissionDate(value) {
    CommonUtils.setDatePref(this._healthReportPrefs,
                            "nextDataSubmissionTime", value,
                            OLDEST_ALLOWED_YEAR);
  },

  /**
   * The number of submission failures for this day's upload.
   *
   * This is used to drive backoff and scheduling.
   */
  get currentDaySubmissionFailureCount() {
    let v = this._healthReportPrefs.get("currentDaySubmissionFailureCount", 0);

    if (!Number.isInteger(v)) {
      v = 0;
    }

    return v;
  },

  set currentDaySubmissionFailureCount(value) {
    if (!Number.isInteger(value)) {
      throw new Error("Value must be integer: " + value);
    }

    this._healthReportPrefs.set("currentDaySubmissionFailureCount", value);
  },

  /**
   * Whether a request to delete remote data is awaiting completion.
   *
   * If this is true, the policy will request that remote data be deleted.
   * Furthermore, no new data will be uploaded (if it's even allowed) until
   * the remote deletion is fulfilled.
   */
  get pendingDeleteRemoteData() {
    return !!this._healthReportPrefs.get("pendingDeleteRemoteData", false);
  },

  set pendingDeleteRemoteData(value) {
    this._healthReportPrefs.set("pendingDeleteRemoteData", !!value);
  },

  /**
   * Whether upload of Firefox Health Report data is enabled.
   */
  get healthReportUploadEnabled() {
    return !!this._healthReportPrefs.get("uploadEnabled", true);
  },

  // External callers should update this via `recordHealthReportUploadEnabled`
  // to ensure appropriate side-effects are performed.
  set healthReportUploadEnabled(value) {
    this._healthReportPrefs.set("uploadEnabled", !!value);
  },

  /**
   * Whether the FHR upload enabled setting is locked and can't be changed.
   */
  get healthReportUploadLocked() {
    return this._healthReportPrefs.locked("uploadEnabled");
  },

  /**
   * Record the user's intent for whether FHR should upload data.
   *
   * This is the preferred way for XUL applications to record a user's
   * preference on whether Firefox Health Report should upload data to
   * a server.
   *
   * If upload is disabled through this API, a request for remote data
   * deletion is initiated automatically.
   *
   * If upload is being disabled and this operation is scheduled to
   * occur immediately, a promise will be returned. This promise will be
   * fulfilled when the deletion attempt finishes. If upload is being
   * disabled and a promise is not returned, callers must poll
   * `haveRemoteData` on the HealthReporter instance to see if remote
   * data has been deleted.
   *
   * @param flag
   *        (bool) Whether data submission is enabled or disabled.
   * @param reason
   *        (string) Why this value is being adjusted. For logging
   *        purposes only.
   */
  recordHealthReportUploadEnabled: function (flag, reason="no-reason") {
    let result = null;
    if (!flag) {
      result = this.deleteRemoteData(reason);
    }

    this.healthReportUploadEnabled = flag;
    return result;
  },

  /**
   * Request that remote data be deleted.
   *
   * This will record an intent that previously uploaded data is to be deleted.
   * The policy will eventually issue a request to the listener for data
   * deletion. It will keep asking for deletion until the listener acknowledges
   * that data has been deleted.
   */
  deleteRemoteData: function deleteRemoteData(reason="no-reason") {
    this._log.info("Remote data deletion requested: " + reason);

    this.pendingDeleteRemoteData = true;

    // We want delete deletion to occur as soon as possible. Move up any
    // pending scheduled data submission and try to trigger.
    this.nextDataSubmissionDate = this.now();
    return this.checkStateAndTrigger();
  },

  /**
   * Start background polling for activity.
   *
   * This will set up a recurring timer that will periodically check if
   * activity is warranted.
   *
   * You typically call this function for each constructed instance.
   */
  startPolling: function startPolling() {
    this.stopPolling();

    this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._timer.initWithCallback({
      notify: function notify() {
        this.checkStateAndTrigger();
      }.bind(this)
    }, this.POLL_INTERVAL_MSEC, this._timer.TYPE_REPEATING_SLACK);
  },

  /**
   * Stop background polling for activity.
   *
   * This should be called when the instance is no longer needed.
   */
  stopPolling: function stopPolling() {
    if (this._timer) {
      this._timer.cancel();
      this._timer = null;
    }
  },

  /**
   * Abstraction for obtaining current time.
   *
   * The purpose of this is to facilitate testing. Testing code can monkeypatch
   * this on instances instead of modifying the singleton Date object.
   */
  now: function now() {
    return new Date();
  },

  /**
   * Check state and trigger actions, if necessary.
   *
   * This is what enforces the submission and notification policy detailed
   * above. You can think of this as the driver for health report data
   * submission.
   *
   * Typically this function is called automatically by the background polling.
   * But, it can safely be called manually as needed.
   */
  checkStateAndTrigger: function checkStateAndTrigger() {
    // If the master data submission kill switch is toggled, we have nothing
    // to do. We don't notify about data policies because this would have
    // no effect.
    if (!this.dataSubmissionEnabled) {
      this._log.debug("Data submission is disabled. Doing nothing.");
      return;
    }

    let now = this.now();
    let nowT = now.getTime();
    let nextSubmissionDate = this.nextDataSubmissionDate;

    // If the system clock were ever set to a time in the distant future,
    // it's possible our next schedule date is far out as well. We know
    // we shouldn't schedule for more than a day out, so we reset the next
    // scheduled date appropriately. 3 days was chosen arbitrarily.
    if (nextSubmissionDate.getTime() >= nowT + 3 * MILLISECONDS_PER_DAY) {
      this._log.warn("Next data submission time is far away. Was the system " +
                     "clock recently readjusted? " + nextSubmissionDate);

      // It shouldn't really matter what we set this to. 1 day in the future
      // should be pretty safe.
      this._moveScheduleForward24h();

      // Fall through since we may have other actions.
    }

    // Tend to any in progress work.
    if (this._processInProgressSubmission()) {
      return;
    }

    // Requests to delete remote data take priority above everything else.
    if (this.pendingDeleteRemoteData) {
      if (nowT < nextSubmissionDate.getTime()) {
        this._log.debug("Deletion request is scheduled for the future: " +
                        nextSubmissionDate);
        return;
      }

      return this._dispatchSubmissionRequest("onRequestRemoteDelete", true);
    }

    if (!this.healthReportUploadEnabled) {
      this._log.debug("Data upload is disabled. Doing nothing.");
      return;
    }

    if (!this.ensureUserNotified()) {
      this._log.warn("The user has not been notified about the data submission " +
                     "policy. Not attempting upload.");
      return;
    }

    // Data submission is allowed to occur. Now comes the scheduling part.

    if (nowT < nextSubmissionDate.getTime()) {
      this._log.debug("Next data submission is scheduled in the future: " +
                     nextSubmissionDate);
      return;
    }

    return this._dispatchSubmissionRequest("onRequestDataUpload", false);
  },

  /**
   * Ensure that the data policy notification has been displayed.
   *
   * This must be called before data submission. If the policy has not been
   * displayed, data submission must not occur.
   *
   * @return bool Whether the notification has been displayed.
   */
  ensureUserNotified: function () {
    if (this.userNotifiedOfCurrentPolicy || this.dataSubmissionPolicyBypassNotification) {
      return true;
    }

    // The user has not been notified yet, but is in the process of being notified.
    if (this._userNotifyPromise) {
      return false;
    }

    let deferred = Promise.defer();
    deferred.promise.then((function onSuccess() {
      this._recordDataPolicyNotification(this.now(), this.currentPolicyVersion);
      this._userNotifyPromise = null;
    }).bind(this), ((error) => {
      this._log.warn("Data policy notification presentation failed: " +
                     CommonUtils.exceptionStr(error));
      this._userNotifyPromise = null;
    }).bind(this));

    this._log.info("Requesting display of data policy.");
    let request = new NotifyPolicyRequest(this, deferred);
    try {
      this._listener.onNotifyDataPolicy(request);
    } catch (ex) {
      this._log.warn("Exception when calling onNotifyDataPolicy: " +
                     CommonUtils.exceptionStr(ex));
    }

    this._userNotifyPromise = deferred.promise;

    return false;
  },

  _recordDataPolicyNotification: function (date, version) {
    this._log.debug("Recording data policy notification to version " + version +
                  " on date " + date);
    this.dataSubmissionPolicyNotifiedDate = date;
    this.dataSubmissionPolicyAcceptedVersion = version;
  },

  _migratePrefs: function () {
    // Current prefs are mostly the same than the old ones, except for some deprecated ones.
    this._prefs.reset([
      "dataSubmissionPolicyAccepted",
      "dataSubmissionPolicyBypassAcceptance",
      "dataSubmissionPolicyResponseType",
      "dataSubmissionPolicyResponseTime"
    ]);
  },

  _processInProgressSubmission: function _processInProgressSubmission() {
    if (!this._inProgressSubmissionRequest) {
      return false;
    }

    let now = this.now().getTime();
    if (this._inProgressSubmissionRequest.expiresDate.getTime() > now) {
      this._log.info("Waiting on in-progress submission request to finish.");
      return true;
    }

    this._log.warn("Old submission request has expired from no activity.");
    this._inProgressSubmissionRequest.promise.reject(new Error("Request has expired."));
    this._inProgressSubmissionRequest = null;
    this._handleSubmissionFailure();

    return false;
  },

  _dispatchSubmissionRequest: function _dispatchSubmissionRequest(handler, isDelete) {
    let now = this.now();

    // We're past our scheduled next data submission date, so let's do it!
    this.lastDataSubmissionRequestedDate = now;
    let deferred = Promise.defer();
    let requestExpiresDate =
      this._futureDate(this.SUBMISSION_REQUEST_EXPIRE_INTERVAL_MSEC);
    this._inProgressSubmissionRequest = new DataSubmissionRequest(deferred,
                                                                  requestExpiresDate,
                                                                  isDelete);

    let onSuccess = function onSuccess(result) {
      this._inProgressSubmissionRequest = null;
      this._handleSubmissionResult(result);
    }.bind(this);

    let onError = function onError(error) {
      this._log.error("Error when handling data submission result: " +
                      CommonUtils.exceptionStr(error));
      this._inProgressSubmissionRequest = null;
      this._handleSubmissionFailure();
    }.bind(this);

    let chained = deferred.promise.then(onSuccess, onError);

    this._log.info("Requesting data submission. Will expire at " +
                   requestExpiresDate);
    try {
      let promise = this._listener[handler](this._inProgressSubmissionRequest);
      chained = chained.then(() => promise, null);
    } catch (ex) {
      this._log.warn("Exception when calling " + handler + ": " +
                     CommonUtils.exceptionStr(ex));
      this._inProgressSubmissionRequest = null;
      this._handleSubmissionFailure();
      return;
    }

    return chained;
  },

  _handleSubmissionResult: function _handleSubmissionResult(request) {
    let state = request.state;
    let reason = request.reason || "no reason";
    this._log.info("Got submission request result: " + state);

    if (state == request.SUBMISSION_SUCCESS) {
      if (request.isDelete) {
        this.pendingDeleteRemoteData = false;
        this._log.info("Successful data delete reported.");
      } else {
        this._log.info("Successful data upload reported.");
      }

      this.lastDataSubmissionSuccessfulDate = request.submissionDate;

      let nextSubmissionDate =
        new Date(request.submissionDate.getTime() + MILLISECONDS_PER_DAY);

      // Schedule pending deletes immediately. This has potential to overload
      // the server. However, the frequency of delete requests across all
      // clients should be low, so this shouldn't pose a problem.
      if (this.pendingDeleteRemoteData) {
        nextSubmissionDate = this.now();
      }

      this.nextDataSubmissionDate = nextSubmissionDate;
      this.currentDaySubmissionFailureCount = 0;
      return;
    }

    if (state == request.NO_DATA_AVAILABLE) {
      if (request.isDelete) {
        this._log.info("Remote data delete requested but no remote data was stored.");
        this.pendingDeleteRemoteData = false;
        return;
      }

      this._log.info("No data was available to submit. May try later.");
      this._handleSubmissionFailure();
      return;
    }

    // We don't special case request.isDelete for these failures because it
    // likely means there was a server error.

    if (state == request.SUBMISSION_FAILURE_SOFT) {
      this._log.warn("Soft error submitting data: " + reason);
      this.lastDataSubmissionFailureDate = this.now();
      this._handleSubmissionFailure();
      return;
    }

    if (state == request.SUBMISSION_FAILURE_HARD) {
      this._log.warn("Hard error submitting data: " + reason);
      this.lastDataSubmissionFailureDate = this.now();
      this._moveScheduleForward24h();
      return;
    }

    throw new Error("Unknown state on DataSubmissionRequest: " + request.state);
  },

  _handleSubmissionFailure: function _handleSubmissionFailure() {
    if (this.currentDaySubmissionFailureCount >= this.FAILURE_BACKOFF_INTERVALS.length) {
      this._log.warn("Reached the limit of daily submission attempts. " +
                     "Rescheduling for tomorrow.");
      this._moveScheduleForward24h();
      return false;
    }

    let offset = this.FAILURE_BACKOFF_INTERVALS[this.currentDaySubmissionFailureCount];
    this.nextDataSubmissionDate = this._futureDate(offset);
    this.currentDaySubmissionFailureCount++;
    return true;
  },

  _moveScheduleForward24h: function _moveScheduleForward24h() {
    let d = this._futureDate(MILLISECONDS_PER_DAY);
    this._log.info("Setting next scheduled data submission for " + d);

    this.nextDataSubmissionDate = d;
    this.currentDaySubmissionFailureCount = 0;
  },

  _futureDate: function _futureDate(offset) {
    return new Date(this.now().getTime() + offset);
  },
});

//@line 434 "e:\hg38\comm-esr38\mozilla\services\datareporting\DataReportingService.js"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 16 "e:\hg38\comm-esr38\mozilla\services\datareporting\sessions.jsm"

Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");


// We automatically prune sessions older than this.
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days.
const STARTUP_RETRY_INTERVAL_MS = 5000;

// Wait up to 5 minutes for startup measurements before giving up.
const MAX_STARTUP_TRIES = 300000 / STARTUP_RETRY_INTERVAL_MS;

/**
 * Records information about browser sessions.
 *
 * This serves as an interface to both current session information as
 * well as a history of previous sessions.
 *
 * Typically only one instance of this will be installed in an
 * application. It is typically managed by an XPCOM service. The
 * instance is instantiated at application start; onStartup is called
 * once the profile is installed; onShutdown is called during shutdown.
 *
 * We currently record state in preferences. However, this should be
 * invisible to external consumers. We could easily swap in a different
 * storage mechanism if desired.
 *
 * Please note the different semantics for storing times and dates in
 * preferences. Full dates (notably the session start time) are stored
 * as strings because preferences have a 32-bit limit on integer values
 * and milliseconds since UNIX epoch would overflow. Many times are
 * stored as integer offsets from the session start time because they
 * should not overflow 32 bits.
 *
 * Since this records history of all sessions, there is a possibility
 * for unbounded data aggregation. This is curtailed through:
 *
 *   1) An "idle-daily" observer which delete sessions older than
 *      MAX_SESSION_AGE_MS.
 *   2) The creator of this instance explicitly calling
 *      `pruneOldSessions`.
 *
 * @param branch
 *        (string) Preferences branch on which to record state.
 */
this.SessionRecorder = function (branch) {
  if (!branch) {
    throw new Error("branch argument must be defined.");
  }

  if (!branch.endsWith(".")) {
    throw new Error("branch argument must end with '.': " + branch);
  }

  this._log = Log.repository.getLogger("Services.DataReporting.SessionRecorder");

  this._prefs = new Preferences(branch);
  this._lastActivityWasInactive = false;
  this._activeTicks = 0;
  this.fineTotalTime = 0;
  this._started = false;
  this._timer = null;
  this._startupFieldTries = 0;

  this._os = Cc["@mozilla.org/observer-service;1"]
               .getService(Ci.nsIObserverService);

};

SessionRecorder.prototype = Object.freeze({
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),

  STARTUP_RETRY_INTERVAL_MS: STARTUP_RETRY_INTERVAL_MS,

  get _currentIndex() {
    return this._prefs.get("currentIndex", 0);
  },

  set _currentIndex(value) {
    this._prefs.set("currentIndex", value);
  },

  get _prunedIndex() {
    return this._prefs.get("prunedIndex", 0);
  },

  set _prunedIndex(value) {
    this._prefs.set("prunedIndex", value);
  },

  get startDate() {
    return CommonUtils.getDatePref(this._prefs, "current.startTime");
  },

  set _startDate(value) {
    CommonUtils.setDatePref(this._prefs, "current.startTime", value);
  },

  get activeTicks() {
    return this._prefs.get("current.activeTicks", 0);
  },

  incrementActiveTicks: function () {
    this._prefs.set("current.activeTicks", ++this._activeTicks);
  },

  /**
   * Total time of this session in integer seconds.
   *
   * See also fineTotalTime for the time in milliseconds.
   */
  get totalTime() {
    return this._prefs.get("current.totalTime", 0);
  },

  updateTotalTime: function () {
    // We store millisecond precision internally to prevent drift from
    // repeated rounding.
    this.fineTotalTime = Date.now() - this.startDate;
    this._prefs.set("current.totalTime", Math.floor(this.fineTotalTime / 1000));
  },

  get main() {
    return this._prefs.get("current.main", -1);
  },

  set _main(value) {
    if (!Number.isInteger(value)) {
      throw new Error("main time must be an integer.");
    }

    this._prefs.set("current.main", value);
  },

  get firstPaint() {
    return this._prefs.get("current.firstPaint", -1);
  },

  set _firstPaint(value) {
    if (!Number.isInteger(value)) {
      throw new Error("firstPaint must be an integer.");
    }

    this._prefs.set("current.firstPaint", value);
  },

  get sessionRestored() {
    return this._prefs.get("current.sessionRestored", -1);
  },

  set _sessionRestored(value) {
    if (!Number.isInteger(value)) {
      throw new Error("sessionRestored must be an integer.");
    }

    this._prefs.set("current.sessionRestored", value);
  },

  getPreviousSessions: function () {
    let result = {};

    for (let i = this._prunedIndex; i < this._currentIndex; i++) {
      let s = this.getPreviousSession(i);
      if (!s) {
        continue;
      }

      result[i] = s;
    }

    return result;
  },

  getPreviousSession: function (index) {
    return this._deserialize(this._prefs.get("previous." + index));
  },

  /**
   * Prunes old, completed sessions that started earlier than the
   * specified date.
   */
  pruneOldSessions: function (date) {
    for (let i = this._prunedIndex; i < this._currentIndex; i++) {
      let s = this.getPreviousSession(i);
      if (!s) {
        continue;
      }

      if (s.startDate >= date) {
        continue;
      }

      this._log.debug("Pruning session #" + i + ".");
      this._prefs.reset("previous." + i);
      this._prunedIndex = i;
    }
  },

  recordStartupFields: function () {
    let si = this._getStartupInfo();

    if (!si.process) {
      throw new Error("Startup info not available.");
    }

    let missing = false;

    for (let field of ["main", "firstPaint", "sessionRestored"]) {
      if (!(field in si)) {
        this._log.debug("Missing startup field: " + field);
        missing = true;
        continue;
      }

      this["_" + field] = si[field].getTime() - si.process.getTime();
    }

    if (!missing || this._startupFieldTries > MAX_STARTUP_TRIES) {
      this._clearStartupTimer();
      return;
    }

    // If we have missing fields, install a timer and keep waiting for
    // data.
    this._startupFieldTries++;

    if (!this._timer) {
      this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      this._timer.initWithCallback({
        notify: this.recordStartupFields.bind(this),
      }, this.STARTUP_RETRY_INTERVAL_MS, this._timer.TYPE_REPEATING_SLACK);
    }
  },

  _clearStartupTimer: function () {
    if (this._timer) {
      this._timer.cancel();
      delete this._timer;
    }
  },

  /**
   * Perform functionality on application startup.
   *
   * This is typically called in a "profile-do-change" handler.
   */
  onStartup: function () {
    if (this._started) {
      throw new Error("onStartup has already been called.");
    }

    let si = this._getStartupInfo();
    if (!si.process) {
      throw new Error("Process information not available. Misconfigured app?");
    }

    this._started = true;

    this._os.addObserver(this, "profile-before-change", false);
    this._os.addObserver(this, "user-interaction-active", false);
    this._os.addObserver(this, "user-interaction-inactive", false);
    this._os.addObserver(this, "idle-daily", false);

    // This has the side-effect of clearing current session state.
    this._moveCurrentToPrevious();

    this._startDate = si.process;
    this._prefs.set("current.activeTicks", 0);
    this.updateTotalTime();

    this.recordStartupFields();
  },

  /**
   * Record application activity.
   */
  onActivity: function (active) {
    let updateActive = active && !this._lastActivityWasInactive;
    this._lastActivityWasInactive = !active;

    this.updateTotalTime();

    if (updateActive) {
      this.incrementActiveTicks();
    }
  },

  onShutdown: function () {
    this._log.info("Recording clean session shutdown.");
    this._prefs.set("current.clean", true);
    this.updateTotalTime();
    this._clearStartupTimer();

    this._os.removeObserver(this, "profile-before-change");
    this._os.removeObserver(this, "user-interaction-active");
    this._os.removeObserver(this, "user-interaction-inactive");
    this._os.removeObserver(this, "idle-daily");
  },

  _CURRENT_PREFS: [
    "current.startTime",
    "current.activeTicks",
    "current.totalTime",
    "current.main",
    "current.firstPaint",
    "current.sessionRestored",
    "current.clean",
  ],

  // This is meant to be called only during onStartup().
  _moveCurrentToPrevious: function () {
    try {
      if (!this.startDate.getTime()) {
        this._log.info("No previous session. Is this first app run?");
        return;
      }

      let clean = this._prefs.get("current.clean", false);

      let count = this._currentIndex++;
      let obj = {
        s: this.startDate.getTime(),
        a: this.activeTicks,
        t: this.totalTime,
        c: clean,
        m: this.main,
        fp: this.firstPaint,
        sr: this.sessionRestored,
      };

      this._log.debug("Recording last sessions as #" + count + ".");
      this._prefs.set("previous." + count, JSON.stringify(obj));
    } catch (ex) {
      this._log.warn("Exception when migrating last session: " +
                     CommonUtils.exceptionStr(ex));
    } finally {
      this._log.debug("Resetting prefs from last session.");
      for (let pref of this._CURRENT_PREFS) {
        this._prefs.reset(pref);
      }
    }
  },

  _deserialize: function (s) {
    let o;
    try {
      o = JSON.parse(s);
    } catch (ex) {
      return null;
    }

    return {
      startDate: new Date(o.s),
      activeTicks: o.a,
      totalTime: o.t,
      clean: !!o.c,
      main: o.m,
      firstPaint: o.fp,
      sessionRestored: o.sr,
    };
  },

  // Implemented as a function to allow for monkeypatching in tests.
  _getStartupInfo: function () {
    return Cc["@mozilla.org/toolkit/app-startup;1"]
             .getService(Ci.nsIAppStartup)
             .getStartupInfo();
  },

  observe: function (subject, topic, data) {
    switch (topic) {
      case "profile-before-change":
        this.onShutdown();
        break;

      case "user-interaction-active":
        this.onActivity(true);
        break;

      case "user-interaction-inactive":
        this.onActivity(false);
        break;

      case "idle-daily":
        this.pruneOldSessions(new Date(Date.now() - MAX_SESSION_AGE_MS));
        break;
    }
  },
});
//@line 436 "e:\hg38\comm-esr38\mozilla\services\datareporting\DataReportingService.js"
;

