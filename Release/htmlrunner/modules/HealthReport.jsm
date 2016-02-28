/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = [
  "HealthReporter",
  "AddonsProvider",
  "AppInfoProvider",
  "CrashesProvider",
  "HealthReportProvider",
  "HotfixProvider",
  "Metrics",
  "PlacesProvider",
  "ProfileMetadataProvider",
  "SearchesProvider",
  "SessionsProvider",
  "SysInfoProvider",
];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// We concatenate the JSMs together to eliminate compartment overhead.
// This is a giant hack until compartment overhead is no longer an
// issue.
//@line 30 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 12 "e:\hg38\comm-esr38\mozilla\services\common\async.js"

// Constants for makeSyncCallback, waitForSyncCallback.
const CB_READY = {};
const CB_COMPLETE = {};
const CB_FAIL = {};

const REASON_ERROR = Ci.mozIStorageStatementCallback.REASON_ERROR;

Cu.import("resource://gre/modules/Services.jsm");

/*
 * Helpers for various async operations.
 */
this.Async = {

  /**
   * Execute an arbitrary number of asynchronous functions one after the
   * other, passing the callback arguments on to the next one.  All functions
   * must take a callback function as their last argument.  The 'this' object
   * will be whatever chain()'s is.
   *
   * @usage this._chain = Async.chain;
   *        this._chain(this.foo, this.bar, this.baz)(args, for, foo)
   *
   * This is equivalent to:
   *
   *   let self = this;
   *   self.foo(args, for, foo, function (bars, args) {
   *     self.bar(bars, args, function (baz, params) {
   *       self.baz(baz, params);
   *     });
   *   });
   */
  chain: function chain() {
    let funcs = Array.slice(arguments);
    let thisObj = this;
    return function callback() {
      if (funcs.length) {
        let args = Array.slice(arguments).concat(callback);
        let f = funcs.shift();
        f.apply(thisObj, args);
      }
    };
  },

  /**
   * Helpers for making asynchronous calls within a synchronous API possible.
   *
   * If you value your sanity, do not look closely at the following functions.
   */

  /**
   * Create a sync callback that remembers state, in particular whether it has
   * been called.
   * The returned callback can be called directly passing an optional arg which
   * will be returned by waitForSyncCallback().  The callback also has a
   * .throw() method, which takes an error object and will cause
   * waitForSyncCallback to fail with the error object thrown as an exception
   * (but note that the .throw method *does not* itself throw - it just causes
   * the wait function to throw).
   */
  makeSyncCallback: function makeSyncCallback() {
    // The main callback remembers the value it was passed, and that it got data.
    let onComplete = function onComplete(data) {
      onComplete.state = CB_COMPLETE;
      onComplete.value = data;
    };

    // Initialize private callback data in preparation for being called.
    onComplete.state = CB_READY;
    onComplete.value = null;

    // Allow an alternate callback to trigger an exception to be thrown.
    onComplete.throw = function onComplete_throw(data) {
      onComplete.state = CB_FAIL;
      onComplete.value = data;
    };

    return onComplete;
  },

  /**
   * Wait for a sync callback to finish.
   */
  waitForSyncCallback: function waitForSyncCallback(callback) {
    // Grab the current thread so we can make it give up priority.
    let thread = Cc["@mozilla.org/thread-manager;1"].getService().currentThread;

    // Keep waiting until our callback is triggered (unless the app is quitting).
    while (Async.checkAppReady() && callback.state == CB_READY) {
      thread.processNextEvent(true);
    }

    // Reset the state of the callback to prepare for another call.
    let state = callback.state;
    callback.state = CB_READY;

    // Throw the value the callback decided to fail with.
    if (state == CB_FAIL) {
      throw callback.value;
    }

    // Return the value passed to the callback.
    return callback.value;
  },

  /**
   * Check if the app is still ready (not quitting).
   */
  checkAppReady: function checkAppReady() {
    // Watch for app-quit notification to stop any sync calls
    Services.obs.addObserver(function onQuitApplication() {
      Services.obs.removeObserver(onQuitApplication, "quit-application");
      Async.checkAppReady = function() {
        throw Components.Exception("App. Quitting", Cr.NS_ERROR_ABORT);
      };
    }, "quit-application", false);
    // In the common case, checkAppReady just returns true
    return (Async.checkAppReady = function() { return true; })();
  },

  /**
   * Return the two things you need to make an asynchronous call synchronous
   * by spinning the event loop.
   */
  makeSpinningCallback: function makeSpinningCallback() {
    let cb = Async.makeSyncCallback();
    function callback(error, ret) {
      if (error)
        cb.throw(error);
      else
        cb(ret);
    }
    callback.wait = () => Async.waitForSyncCallback(cb);
    return callback;
  },

  // Prototype for mozIStorageCallback, used in querySpinningly.
  // This allows us to define the handle* functions just once rather
  // than on every querySpinningly invocation.
  _storageCallbackPrototype: {
    results: null,

    // These are set by queryAsync.
    names: null,
    syncCb: null,

    handleResult: function handleResult(results) {
      if (!this.names) {
        return;
      }
      if (!this.results) {
        this.results = [];
      }
      let row;
      while ((row = results.getNextRow()) != null) {
        let item = {};
        for each (let name in this.names) {
          item[name] = row.getResultByName(name);
        }
        this.results.push(item);
      }
    },
    handleError: function handleError(error) {
      this.syncCb.throw(error);
    },
    handleCompletion: function handleCompletion(reason) {

      // If we got an error, handleError will also have been called, so don't
      // call the callback! We never cancel statements, so we don't need to
      // address that quandary.
      if (reason == REASON_ERROR)
        return;

      // If we were called with column names but didn't find any results,
      // the calling code probably still expects an array as a return value.
      if (this.names && !this.results) {
        this.results = [];
      }
      this.syncCb(this.results);
    }
  },

  querySpinningly: function querySpinningly(query, names) {
    // 'Synchronously' asyncExecute, fetching all results by name.
    let storageCallback = {names: names,
                           syncCb: Async.makeSyncCallback()};
    storageCallback.__proto__ = Async._storageCallbackPrototype;
    query.executeAsync(storageCallback);
    return Async.waitForSyncCallback(storageCallback.syncCb);
  },
};
//@line 32 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file contains a client API for the Bagheera data storage service.
 *
 * Information about Bagheera is available at
 * https://github.com/mozilla-metrics/bagheera
 */

//@line 24 "e:\hg38\comm-esr38\mozilla\services\common\bagheeraclient.js"

Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/utils.js");


/**
 * Represents the result of a Bagheera request.
 */
this.BagheeraClientRequestResult = function BagheeraClientRequestResult() {
  this.transportSuccess = false;
  this.serverSuccess = false;
  this.request = null;
};

Object.freeze(BagheeraClientRequestResult.prototype);


/**
 * Wrapper around RESTRequest so logging is sane.
 */
function BagheeraRequest(uri) {
  RESTRequest.call(this, uri);

  this._log = Log.repository.getLogger("Services.BagheeraClient");
  this._log.level = Log.Level.Debug;
}

BagheeraRequest.prototype = Object.freeze({
  __proto__: RESTRequest.prototype,
});


/**
 * Create a new Bagheera client instance.
 *
 * Each client is associated with a specific Bagheera HTTP URI endpoint.
 *
 * @param baseURI
 *        (string) The base URI of the Bagheera HTTP endpoint.
 */
this.BagheeraClient = function BagheeraClient(baseURI) {
  if (!baseURI) {
    throw new Error("baseURI argument must be defined.");
  }

  this._log = Log.repository.getLogger("Services.BagheeraClient");
  this._log.level = Log.Level.Debug;

  this.baseURI = baseURI;

  if (!baseURI.endsWith("/")) {
    this.baseURI += "/";
  }
};

BagheeraClient.prototype = Object.freeze({
  /**
   * Channel load flags for all requests.
   *
   * Caching is not applicable, so we bypass and disable it. We also
   * ignore any cookies that may be present for the domain because
   * Bagheera does not utilize cookies and the release of cookies may
   * inadvertantly constitute unncessary information disclosure.
   */
  _loadFlags: Ci.nsIRequest.LOAD_BYPASS_CACHE |
              Ci.nsIRequest.INHIBIT_CACHING |
              Ci.nsIRequest.LOAD_ANONYMOUS,

  DEFAULT_TIMEOUT_MSEC: 5 * 60 * 1000, // 5 minutes.

  _RE_URI_IDENTIFIER: /^[a-zA-Z0-9_-]+$/,

  /**
   * Upload a JSON payload to the server.
   *
   * The return value is a Promise which will be resolved with a
   * BagheeraClientRequestResult when the request has finished.
   *
   * @param namespace
   *        (string) The namespace to post this data to.
   * @param id
   *        (string) The ID of the document being uploaded. This is typically
   *        a UUID in hex form.
   * @param payload
   *        (string|object) Data to upload. Can be specified as a string (which
   *        is assumed to be JSON) or an object. If an object, it will be fed into
   *        JSON.stringify() for serialization.
   * @param options
   *        (object) Extra options to control behavior. Recognized properties:
   *
   *          deleteIDs -- (array) Old document IDs to delete as part of
   *            upload. If not specified, no old documents will be deleted as
   *            part of upload. The array values are typically UUIDs in hex
   *            form.
   *
   *          telemetryCompressed -- (string) Telemetry histogram to record
   *            compressed size of payload under. If not defined, no telemetry
   *            data for the compressed size will be recorded.
   *
   * @return Promise<BagheeraClientRequestResult>
   */
  uploadJSON: function uploadJSON(namespace, id, payload, options={}) {
    if (!namespace) {
      throw new Error("namespace argument must be defined.");
    }

    if (!id) {
      throw new Error("id argument must be defined.");
    }

    if (!payload) {
      throw new Error("payload argument must be defined.");
    }

    if (options && typeof(options) != "object") {
      throw new Error("Unexpected type for options argument. Expected object. " +
                      "Got: " + typeof(options));
    }

    let uri = this._submitURI(namespace, id);

    let data = payload;

    if (typeof(payload) == "object") {
      data = JSON.stringify(payload);
    }

    if (typeof(data) != "string") {
      throw new Error("Unknown type for payload: " + typeof(data));
    }

    this._log.info("Uploading data to " + uri);

    let request = new BagheeraRequest(uri);
    request.loadFlags = this._loadFlags;
    request.timeout = this.DEFAULT_TIMEOUT_MSEC;

    // Since API changed, throw on old API usage.
    if ("deleteID" in options) {
      throw new Error("API has changed, use (array) deleteIDs instead");
    }

    let deleteIDs;
    if (options.deleteIDs && options.deleteIDs.length > 0) {
      deleteIDs = options.deleteIDs;
      this._log.debug("Will delete " + deleteIDs.join(", "));
      request.setHeader("X-Obsolete-Document", deleteIDs.join(","));
    }

    let deferred = Promise.defer();

    // The string converter service used by CommonUtils.convertString()
    // silently throws away high bytes. We need to convert the string to
    // consist of only low bytes first.
    data = CommonUtils.encodeUTF8(data);
    data = CommonUtils.convertString(data, "uncompressed", "deflate");
    if (options.telemetryCompressed) {
      try {
        let h = Services.telemetry.getHistogramById(options.telemetryCompressed);
        h.add(data.length);
      } catch (ex) {
        this._log.warn("Unable to record telemetry for compressed payload size: " +
                       CommonUtils.exceptionStr(ex));
      }
    }

    // TODO proper header per bug 807134.
    request.setHeader("Content-Type", "application/json+zlib; charset=utf-8");

    this._log.info("Request body length: " + data.length);

    let result = new BagheeraClientRequestResult();
    result.namespace = namespace;
    result.id = id;
    result.deleteIDs = deleteIDs ? deleteIDs.slice(0) : null;

    request.onComplete = this._onComplete.bind(this, request, deferred, result);
    request.post(data);

    return deferred.promise;
  },

  /**
   * Delete the specified document.
   *
   * @param namespace
   *        (string) Namespace from which to delete the document.
   * @param id
   *        (string) ID of document to delete.
   *
   * @return Promise<BagheeraClientRequestResult>
   */
  deleteDocument: function deleteDocument(namespace, id) {
    let uri = this._submitURI(namespace, id);

    let request = new BagheeraRequest(uri);
    request.loadFlags = this._loadFlags;
    request.timeout = this.DEFAULT_TIMEOUT_MSEC;

    let result = new BagheeraClientRequestResult();
    result.namespace = namespace;
    result.id = id;
    let deferred = Promise.defer();

    request.onComplete = this._onComplete.bind(this, request, deferred, result);
    request.delete();

    return deferred.promise;
  },

  _submitURI: function _submitURI(namespace, id) {
    if (!this._RE_URI_IDENTIFIER.test(namespace)) {
      throw new Error("Illegal namespace name. Must be alphanumeric + [_-]: " +
                      namespace);
    }

    if (!this._RE_URI_IDENTIFIER.test(id)) {
      throw new Error("Illegal id value. Must be alphanumeric + [_-]: " + id);
    }

    return this.baseURI + "1.0/submit/" + namespace + "/" + id;
  },

  _onComplete: function _onComplete(request, deferred, result, error) {
    result.request = request;

    if (error) {
      this._log.info("Transport failure on request: " +
                     CommonUtils.exceptionStr(error));
      result.transportSuccess = false;
      deferred.resolve(result);
      return;
    }

    result.transportSuccess = true;

    let response = request.response;

    switch (response.status) {
      case 200:
      case 201:
        result.serverSuccess = true;
        break;

      default:
        result.serverSuccess = false;

        this._log.info("Received unexpected status code: " + response.status);
        this._log.debug("Response body: " + response.body);
    }

    deferred.resolve(result);
  },
});

//@line 34 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 16 "e:\hg38\comm-esr38\mozilla\services\metrics\Metrics.jsm"

// We concatenate the JSMs together to eliminate compartment overhead.
// This is a giant hack until compartment overhead is no longer an
// issue.
//@line 21 "e:\hg38\comm-esr38\mozilla\services\metrics\Metrics.jsm"

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 14 "e:\hg38\comm-esr38\mozilla\services\metrics\providermanager.jsm"

Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");


/**
 * Handles and coordinates the collection of metrics data from providers.
 *
 * This provides an interface for managing `Metrics.Provider` instances. It
 * provides APIs for bulk collection of data.
 */
this.ProviderManager = function (storage) {
  this._log = Log.repository.getLogger("Services.Metrics.ProviderManager");

  this._providers = new Map();
  this._storage = storage;

  this._providerInitQueue = [];
  this._providerInitializing = false;

  this._pullOnlyProviders = {};
  this._pullOnlyProvidersRegisterCount = 0;
  this._pullOnlyProvidersState = this.PULL_ONLY_NOT_REGISTERED;
  this._pullOnlyProvidersCurrentPromise = null;

  // Callback to allow customization of providers after they are constructed
  // but before they call out into their initialization code.
  this.onProviderInit = null;
}

this.ProviderManager.prototype = Object.freeze({
  PULL_ONLY_NOT_REGISTERED: "none",
  PULL_ONLY_REGISTERING: "registering",
  PULL_ONLY_UNREGISTERING: "unregistering",
  PULL_ONLY_REGISTERED: "registered",

  get providers() {
    let providers = [];
    for (let [name, entry] of this._providers) {
      providers.push(entry.provider);
    }

    return providers;
  },

  /**
   * Obtain a provider from its name.
   */
  getProvider: function (name) {
    let provider = this._providers.get(name);

    if (!provider) {
      return null;
    }

    return provider.provider;
  },

  /**
   * Registers providers from a category manager category.
   *
   * This examines the specified category entries and registers found
   * providers.
   *
   * Category entries are essentially JS modules and the name of the symbol
   * within that module that is a `Metrics.Provider` instance.
   *
   * The category entry name is the name of the JS type for the provider. The
   * value is the resource:// URI to import which makes this type available.
   *
   * Example entry:
   *
   *   FooProvider resource://gre/modules/foo.jsm
   *
   * One can register entries in the application's .manifest file. e.g.
   *
   *   category healthreport-js-provider-default FooProvider resource://gre/modules/foo.jsm
   *   category healthreport-js-provider-nightly EyeballProvider resource://gre/modules/eyeball.jsm
   *
   * Then to load them:
   *
   *   let reporter = getHealthReporter("healthreport.");
   *   reporter.registerProvidersFromCategoryManager("healthreport-js-provider-default");
   *
   * If the category has no defined members, this call has no effect, and no error is raised.
   *
   * @param category
   *        (string) Name of category from which to query and load.
   * @param providerDiagnostic
   *        (function) Optional, called with the name of the provider currently being initialized.
   * @return a newly spawned Task.
   */
  registerProvidersFromCategoryManager: function (category, providerDiagnostic) {
    this._log.info("Registering providers from category: " + category);
    let cm = Cc["@mozilla.org/categorymanager;1"]
               .getService(Ci.nsICategoryManager);

    let promiseList = [];
    let enumerator = cm.enumerateCategory(category);
    while (enumerator.hasMoreElements()) {
      let entry = enumerator.getNext()
                            .QueryInterface(Ci.nsISupportsCString)
                            .toString();

      let uri = cm.getCategoryEntry(category, entry);
      this._log.info("Attempting to load provider from category manager: " +
                     entry + " from " + uri);

      try {
        let ns = {};
        Cu.import(uri, ns);

        let promise = this.registerProviderFromType(ns[entry]);
        if (promise) {
          promiseList.push({name: entry, promise: promise});
        }
      } catch (ex) {
        this._recordProviderError(entry,
                                  "Error registering provider from category manager",
                                  ex);
        continue;
      }
    }

    return Task.spawn(function* wait() {
      for (let entry of promiseList) {
        if (providerDiagnostic) {
          providerDiagnostic(entry.name);
        }
        yield entry.promise;
      }
    });
  },

  /**
   * Registers a `MetricsProvider` with this manager.
   *
   * Once a `MetricsProvider` is registered, data will be collected from it
   * whenever we collect data.
   *
   * The returned value is a promise that will be resolved once registration
   * is complete.
   *
   * Providers are initialized as part of registration by calling
   * provider.init().
   *
   * @param provider
   *        (Metrics.Provider) The provider instance to register.
   *
   * @return Promise<null>
   */
  registerProvider: function (provider) {
    // We should perform an instanceof check here. However, due to merged
    // compartments, the Provider type may belong to one of two JSMs
    // isinstance gets confused depending on which module Provider comes
    // from. Some code references Provider from dataprovider.jsm; others from
    // Metrics.jsm.
    if (!provider.name) {
      throw new Error("Provider is not valid: does not have a name.");
    }
    if (this._providers.has(provider.name)) {
      return CommonUtils.laterTickResolvingPromise();
    }

    let deferred = Promise.defer();
    this._providerInitQueue.push([provider, deferred]);

    if (this._providerInitQueue.length == 1) {
      this._popAndInitProvider();
    }

    return deferred.promise;
  },

  /**
   * Registers a provider from its constructor function.
   *
   * If the provider is pull-only, it will be stashed away and
   * initialized later. Null will be returned.
   *
   * If it is not pull-only, it will be initialized immediately and a
   * promise will be returned. The promise will be resolved when the
   * provider has finished initializing.
   */
  registerProviderFromType: function (type) {
    let proto = type.prototype;
    if (proto.pullOnly) {
      this._log.info("Provider is pull-only. Deferring initialization: " +
                     proto.name);
      this._pullOnlyProviders[proto.name] = type;

      return null;
    }

    let provider = this._initProviderFromType(type);
    return this.registerProvider(provider);
  },

  /**
   * Initializes a provider from its type.
   *
   * This is how a constructor function should be turned into a provider
   * instance.
   *
   * A side-effect is the provider is registered with the manager.
   */
  _initProviderFromType: function (type) {
    let provider = new type();
    if (this.onProviderInit) {
      this.onProviderInit(provider);
    }

    return provider;
  },

  /**
   * Remove a named provider from the manager.
   *
   * It is the caller's responsibility to shut down the provider
   * instance.
   */
  unregisterProvider: function (name) {
    this._providers.delete(name);
  },

  /**
   * Ensure that pull-only providers are registered.
   */
  ensurePullOnlyProvidersRegistered: function () {
    let state = this._pullOnlyProvidersState;

    this._pullOnlyProvidersRegisterCount++;

    if (state == this.PULL_ONLY_REGISTERED) {
      this._log.debug("Requested pull-only provider registration and " +
                      "providers are already registered.");
      return CommonUtils.laterTickResolvingPromise();
    }

    // If we're in the process of registering, chain off that request.
    if (state == this.PULL_ONLY_REGISTERING) {
      this._log.debug("Requested pull-only provider registration and " +
                      "registration is already in progress.");
      return this._pullOnlyProvidersCurrentPromise;
    }

    this._log.debug("Pull-only provider registration requested.");

    // A side-effect of setting this is that an active unregistration will
    // effectively short circuit and finish as soon as the in-flight
    // unregistration (if any) finishes.
    this._pullOnlyProvidersState = this.PULL_ONLY_REGISTERING;

    let inFlightPromise = this._pullOnlyProvidersCurrentPromise;

    this._pullOnlyProvidersCurrentPromise =
      Task.spawn(function registerPullProviders() {

      if (inFlightPromise) {
        this._log.debug("Waiting for in-flight pull-only provider activity " +
                        "to finish before registering.");
        try {
          yield inFlightPromise;
        } catch (ex) {
          this._log.warn("Error when waiting for existing pull-only promise: " +
                         CommonUtils.exceptionStr(ex));
        }
      }

      for each (let providerType in this._pullOnlyProviders) {
        // Short-circuit if we're no longer registering.
        if (this._pullOnlyProvidersState != this.PULL_ONLY_REGISTERING) {
          this._log.debug("Aborting pull-only provider registration.");
          break;
        }

        try {
          let provider = this._initProviderFromType(providerType);

          // This is a no-op if the provider is already registered. So, the
          // only overhead is constructing an instance. This should be cheap
          // and isn't worth optimizing.
          yield this.registerProvider(provider);
        } catch (ex) {
          this._recordProviderError(providerType.prototype.name,
                                    "Error registering pull-only provider",
                                    ex);
        }
      }

      // It's possible we changed state while registering. Only mark as
      // registered if we didn't change state.
      if (this._pullOnlyProvidersState == this.PULL_ONLY_REGISTERING) {
        this._pullOnlyProvidersState = this.PULL_ONLY_REGISTERED;
        this._pullOnlyProvidersCurrentPromise = null;
      }
    }.bind(this));
    return this._pullOnlyProvidersCurrentPromise;
  },

  ensurePullOnlyProvidersUnregistered: function () {
    let state = this._pullOnlyProvidersState;

    // If we're not registered, this is a no-op.
    if (state == this.PULL_ONLY_NOT_REGISTERED) {
      this._log.debug("Requested pull-only provider unregistration but none " +
                      "are registered.");
      return CommonUtils.laterTickResolvingPromise();
    }

    // If we're currently unregistering, recycle the promise from last time.
    if (state == this.PULL_ONLY_UNREGISTERING) {
      this._log.debug("Requested pull-only provider unregistration and " +
                 "unregistration is in progress.");
      this._pullOnlyProvidersRegisterCount =
        Math.max(0, this._pullOnlyProvidersRegisterCount - 1);

      return this._pullOnlyProvidersCurrentPromise;
    }

    // We ignore this request while multiple entities have requested
    // registration because we don't want a request from an "inner,"
    // short-lived request to overwrite the desire of the "parent,"
    // longer-lived request.
    if (this._pullOnlyProvidersRegisterCount > 1) {
      this._log.debug("Requested pull-only provider unregistration while " +
                      "other callers still want them registered. Ignoring.");
      this._pullOnlyProvidersRegisterCount--;
      return CommonUtils.laterTickResolvingPromise();
    }

    // We are either fully registered or registering with a single consumer.
    // In both cases we are authoritative and can commence unregistration.

    this._log.debug("Pull-only providers being unregistered.");
    this._pullOnlyProvidersRegisterCount =
      Math.max(0, this._pullOnlyProvidersRegisterCount - 1);
    this._pullOnlyProvidersState = this.PULL_ONLY_UNREGISTERING;
    let inFlightPromise = this._pullOnlyProvidersCurrentPromise;

    this._pullOnlyProvidersCurrentPromise =
      Task.spawn(function unregisterPullProviders() {

      if (inFlightPromise) {
        this._log.debug("Waiting for in-flight pull-only provider activity " +
                        "to complete before unregistering.");
        try {
          yield inFlightPromise;
        } catch (ex) {
          this._log.warn("Error when waiting for existing pull-only promise: " +
                         CommonUtils.exceptionStr(ex));
        }
      }

      for (let provider of this.providers) {
        if (this._pullOnlyProvidersState != this.PULL_ONLY_UNREGISTERING) {
          return;
        }

        if (!provider.pullOnly) {
          continue;
        }

        this._log.info("Shutting down pull-only provider: " +
                       provider.name);

        try {
          yield provider.shutdown();
        } catch (ex) {
          this._recordProviderError(provider.name,
                                    "Error when shutting down provider",
                                    ex);
        } finally {
          this.unregisterProvider(provider.name);
        }
      }

      if (this._pullOnlyProvidersState == this.PULL_ONLY_UNREGISTERING) {
        this._pullOnlyProvidersState = this.PULL_ONLY_NOT_REGISTERED;
        this._pullOnlyProvidersCurrentPromise = null;
      }
    }.bind(this));
    return this._pullOnlyProvidersCurrentPromise;
  },

  _popAndInitProvider: function () {
    if (!this._providerInitQueue.length || this._providerInitializing) {
      return;
    }

    let [provider, deferred] = this._providerInitQueue.shift();
    this._providerInitializing = true;

    this._log.info("Initializing provider with storage: " + provider.name);

    Task.spawn(function initProvider() {
      try {
        let result = yield provider.init(this._storage);
        this._log.info("Provider successfully initialized: " + provider.name);

        this._providers.set(provider.name, {
          provider: provider,
          constantsCollected: false,
        });

        deferred.resolve(result);
      } catch (ex) {
        this._recordProviderError(provider.name, "Failed to initialize", ex);
        deferred.reject(ex);
      } finally {
        this._providerInitializing = false;
        this._popAndInitProvider();
      }
    }.bind(this));
  },

  /**
   * Collects all constant measurements from all providers.
   *
   * Returns a Promise that will be fulfilled once all data providers have
   * provided their constant data. A side-effect of this promise fulfillment
   * is that the manager is populated with the obtained collection results.
   * The resolved value to the promise is this `ProviderManager` instance.
   *
   * @param providerDiagnostic
   *        (function) Optional, called with the name of the provider currently being initialized.
   */
  collectConstantData: function (providerDiagnostic=null) {
    let entries = [];

    for (let [name, entry] of this._providers) {
      if (entry.constantsCollected) {
        this._log.trace("Provider has already provided constant data: " +
                        name);
        continue;
      }

      entries.push(entry);
    }

    let onCollect = function (entry, result) {
      entry.constantsCollected = true;
    };

    return this._callCollectOnProviders(entries, "collectConstantData",
                                        onCollect, providerDiagnostic);
  },

  /**
   * Calls collectDailyData on all providers.
   */
  collectDailyData: function (providerDiagnostic=null) {
    return this._callCollectOnProviders(this._providers.values(),
                                        "collectDailyData",
                                        null,
                                        providerDiagnostic);
  },

  _callCollectOnProviders: function (entries, fnProperty, onCollect=null, providerDiagnostic=null) {
    let promises = [];

    for (let entry of entries) {
      let provider = entry.provider;
      let collectPromise;
      try {
        collectPromise = provider[fnProperty].call(provider);
      } catch (ex) {
        this._recordProviderError(provider.name, "Exception when calling " +
                                  "collect function: " + fnProperty, ex);
        continue;
      }

      if (!collectPromise) {
        this._recordProviderError(provider.name, "Does not return a promise " +
                                  "from " + fnProperty + "()");
        continue;
      }

      let promise = collectPromise.then(function onCollected(result) {
        if (onCollect) {
          try {
            onCollect(entry, result);
          } catch (ex) {
            this._log.warn("onCollect callback threw: " +
                           CommonUtils.exceptionStr(ex));
          }
        }

        return CommonUtils.laterTickResolvingPromise(result);
      });

      promises.push([provider.name, promise]);
    }

    return this._handleCollectionPromises(promises, providerDiagnostic);
  },

  /**
   * Handles promises returned by the collect* functions.
   *
   * This consumes the data resolved by the promises and returns a new promise
   * that will be resolved once all promises have been resolved.
   *
   * The promise is resolved even if one of the underlying collection
   * promises is rejected.
   */
  _handleCollectionPromises: function (promises, providerDiagnostic=null) {
    return Task.spawn(function waitForPromises() {
      for (let [name, promise] of promises) {
        if (providerDiagnostic) {
          providerDiagnostic(name);
        }

        try {
          yield promise;
          this._log.debug("Provider collected successfully: " + name);
        } catch (ex) {
          this._recordProviderError(name, "Failed to collect", ex);
        }
      }

      throw new Task.Result(this);
    }.bind(this));
  },

  /**
   * Record an error that occurred operating on a provider.
   */
  _recordProviderError: function (name, msg, ex) {
    msg = "Provider error: " + name + ": " + msg;
    if (ex) {
      msg += ": " + CommonUtils.exceptionStr(ex);
    }
    this._log.warn(msg);

    if (this.onProviderError) {
      try {
        this.onProviderError(msg);
      } catch (callError) {
        this._log.warn("Exception when calling onProviderError callback: " +
                       CommonUtils.exceptionStr(callError));
      }
    }
  },
});

//@line 23 "e:\hg38\comm-esr38\mozilla\services\metrics\Metrics.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 19 "e:\hg38\comm-esr38\mozilla\services\metrics\dataprovider.jsm"

Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");



/**
 * Represents a collection of related pieces/fields of data.
 *
 * This is an abstract base type.
 *
 * This type provides the primary interface for storing, retrieving, and
 * serializing data.
 *
 * Each measurement consists of a set of named fields. Each field is primarily
 * identified by a string name, which must be unique within the measurement.
 *
 * Each derived type must define the following properties:
 *
 *   name -- String name of this measurement. This is the primary way
 *     measurements are distinguished within a provider.
 *
 *   version -- Integer version of this measurement. This is a secondary
 *     identifier for a measurement within a provider. The version denotes
 *     the behavior of this measurement and the composition of its fields over
 *     time. When a new field is added or the behavior of an existing field
 *     changes, the version should be incremented. The initial version of a
 *     measurement is typically 1.
 *
 *   fields -- Object defining the fields this measurement holds. Keys in the
 *     object are string field names. Values are objects describing how the
 *     field works. The following properties are recognized:
 *
 *       type -- The string type of this field. This is typically one of the
 *         FIELD_* constants from the Metrics.Storage type.
 *
 *
 * FUTURE: provide hook points for measurements to supplement with custom
 * storage needs.
 */
this.Measurement = function () {
  if (!this.name) {
    throw new Error("Measurement must have a name.");
  }

  if (!this.version) {
    throw new Error("Measurement must have a version.");
  }

  if (!Number.isInteger(this.version)) {
    throw new Error("Measurement's version must be an integer: " + this.version);
  }

  if (!this.fields) {
    throw new Error("Measurement must define fields.");
  }

  for (let [name, info] in Iterator(this.fields)) {
    if (!info) {
      throw new Error("Field does not contain metadata: " + name);
    }

    if (!info.type) {
      throw new Error("Field is missing required type property: " + name);
    }
  }

  this._log = Log.repository.getLogger("Services.Metrics.Measurement." + this.name);

  this.id = null;
  this.storage = null;
  this._fields = {};

  this._serializers = {};
  this._serializers[this.SERIALIZE_JSON] = {
    singular: this._serializeJSONSingular.bind(this),
    daily: this._serializeJSONDay.bind(this),
  };
}

Measurement.prototype = Object.freeze({
  SERIALIZE_JSON: "json",

  /**
   * Obtain a serializer for this measurement.
   *
   * Implementations should return an object with the following keys:
   *
   *   singular -- Serializer for singular data.
   *   daily -- Serializer for daily data.
   *
   * Each item is a function that takes a single argument: the data to
   * serialize. The passed data is a subset of that returned from
   * this.getValues(). For "singular," data.singular is passed. For "daily",
   * data.days.get(<day>) is passed.
   *
   * This function receives a single argument: the serialization format we
   * are requesting. This is one of the SERIALIZE_* constants on this base type.
   *
   * For SERIALIZE_JSON, the function should return an object that
   * JSON.stringify() knows how to handle. This could be an anonymous object or
   * array or any object with a property named `toJSON` whose value is a
   * function. The returned object will be added to a larger document
   * containing the results of all `serialize` calls.
   *
   * The default implementation knows how to serialize built-in types using
   * very simple logic. If small encoding size is a goal, the default
   * implementation may not be suitable. If an unknown field type is
   * encountered, the default implementation will error.
   *
   * @param format
   *        (string) A SERIALIZE_* constant defining what serialization format
   *        to use.
   */
  serializer: function (format) {
    if (!(format in this._serializers)) {
      throw new Error("Don't know how to serialize format: " + format);
    }

    return this._serializers[format];
  },

  /**
   * Whether this measurement contains the named field.
   *
   * @param name
   *        (string) Name of field.
   *
   * @return bool
   */
  hasField: function (name) {
    return name in this.fields;
  },

  /**
   * The unique identifier for a named field.
   *
   * This will throw if the field is not known.
   *
   * @param name
   *        (string) Name of field.
   */
  fieldID: function (name) {
    let entry = this._fields[name];

    if (!entry) {
      throw new Error("Unknown field: " + name);
    }

    return entry[0];
  },

  fieldType: function (name) {
    let entry = this._fields[name];

    if (!entry) {
      throw new Error("Unknown field: " + name);
    }

    return entry[1];
  },

  _configureStorage: function () {
    let missing = [];
    for (let [name, info] in Iterator(this.fields)) {
      if (this.storage.hasFieldFromMeasurement(this.id, name)) {
        this._fields[name] =
          [this.storage.fieldIDFromMeasurement(this.id, name), info.type];
        continue;
      }

      missing.push([name, info.type]);
    }

    if (!missing.length) {
      return CommonUtils.laterTickResolvingPromise();
    }

    // We only perform a transaction if we have work to do (to avoid
    // extra SQLite overhead).
    return this.storage.enqueueTransaction(function registerFields() {
      for (let [name, type] of missing) {
        this._log.debug("Registering field: " + name + " " + type);
        let id = yield this.storage.registerField(this.id, name, type);
        this._fields[name] = [id, type];
      }
    }.bind(this));
  },

  //---------------------------------------------------------------------------
  // Data Recording Functions
  //
  // Functions in this section are used to record new values against this
  // measurement instance.
  //
  // Generally speaking, these functions will throw if the specified field does
  // not exist or if the storage function requested is not appropriate for the
  // type of that field. These functions will also return a promise that will
  // be resolved when the underlying storage operation has completed.
  //---------------------------------------------------------------------------

  /**
   * Increment a daily counter field in this measurement by 1.
   *
   * By default, the counter for the current day will be incremented.
   *
   * If the field is not known or is not a daily counter, this will throw.
   *
   *
   *
   * @param field
   *        (string) The name of the field whose value to increment.
   * @param date
   *        (Date) Day on which to increment the counter.
   * @param by
   *        (integer) How much to increment by.
   * @return Promise<>
   */
  incrementDailyCounter: function (field, date=new Date(), by=1) {
    return this.storage.incrementDailyCounterFromFieldID(this.fieldID(field),
                                                         date, by);
  },

  /**
   * Record a new numeric value for a daily discrete numeric field.
   *
   * @param field
   *        (string) The name of the field to append a value to.
   * @param value
   *        (Number) Number to append.
   * @param date
   *        (Date) Day on which to append the value.
   *
   * @return Promise<>
   */
  addDailyDiscreteNumeric: function (field, value, date=new Date()) {
    return this.storage.addDailyDiscreteNumericFromFieldID(
                          this.fieldID(field), value, date);
  },

  /**
   * Record a new text value for a daily discrete text field.
   *
   * This is like `addDailyDiscreteNumeric` but for daily discrete text fields.
   */
  addDailyDiscreteText: function (field, value, date=new Date()) {
    return this.storage.addDailyDiscreteTextFromFieldID(
                          this.fieldID(field), value, date);
  },

  /**
   * Record the last seen value for a last numeric field.
   *
   * @param field
   *        (string) The name of the field to set the value of.
   * @param value
   *        (Number) The value to set.
   * @param date
   *        (Date) When this value was recorded.
   *
   * @return Promise<>
   */
  setLastNumeric: function (field, value, date=new Date()) {
    return this.storage.setLastNumericFromFieldID(this.fieldID(field), value,
                                                  date);
  },

  /**
   * Record the last seen value for a last text field.
   *
   * This is like `setLastNumeric` except for last text fields.
   */
  setLastText: function (field, value, date=new Date()) {
    return this.storage.setLastTextFromFieldID(this.fieldID(field), value,
                                               date);
  },

  /**
   * Record the most recent value for a daily last numeric field.
   *
   * @param field
   *        (string) The name of a daily last numeric field.
   * @param value
   *        (Number) The value to set.
   * @param date
   *        (Date) Day on which to record the last value.
   *
   * @return Promise<>
   */
  setDailyLastNumeric: function (field, value, date=new Date()) {
    return this.storage.setDailyLastNumericFromFieldID(this.fieldID(field),
                                                       value, date);
  },

  /**
   * Record the most recent value for a daily last text field.
   *
   * This is like `setDailyLastNumeric` except for a daily last text field.
   */
  setDailyLastText: function (field, value, date=new Date()) {
    return this.storage.setDailyLastTextFromFieldID(this.fieldID(field),
                                                    value, date);
  },

  //---------------------------------------------------------------------------
  // End of data recording APIs.
  //---------------------------------------------------------------------------

  /**
   * Obtain all values stored for this measurement.
   *
   * The default implementation obtains all known types from storage. If the
   * measurement provides custom types or stores values somewhere other than
   * storage, it should define its own implementation.
   *
   * This returns a promise that resolves to a data structure which is
   * understood by the measurement's serialize() function.
   */
  getValues: function () {
    return this.storage.getMeasurementValues(this.id);
  },

  deleteLastNumeric: function (field) {
    return this.storage.deleteLastNumericFromFieldID(this.fieldID(field));
  },

  deleteLastText: function (field) {
    return this.storage.deleteLastTextFromFieldID(this.fieldID(field));
  },

  /**
   * This method is used by the default serializers to control whether a field
   * is included in the output.
   *
   * There could be legacy fields in storage we no longer care about.
   *
   * This method is a hook to allow measurements to change this behavior, e.g.,
   * to implement a dynamic fieldset.
   *
   * You will also need to override `fieldType`.
   *
   * @return (boolean) true if the specified field should be included in
   *                   payload output.
   */
  shouldIncludeField: function (field) {
    return field in this._fields;
  },

  _serializeJSONSingular: function (data) {
    let result = {"_v": this.version};

    for (let [field, data] of data) {
      // There could be legacy fields in storage we no longer care about.
      if (!this.shouldIncludeField(field)) {
        continue;
      }

      let type = this.fieldType(field);

      switch (type) {
        case this.storage.FIELD_LAST_NUMERIC:
        case this.storage.FIELD_LAST_TEXT:
          result[field] = data[1];
          break;

        case this.storage.FIELD_DAILY_COUNTER:
        case this.storage.FIELD_DAILY_DISCRETE_NUMERIC:
        case this.storage.FIELD_DAILY_DISCRETE_TEXT:
        case this.storage.FIELD_DAILY_LAST_NUMERIC:
        case this.storage.FIELD_DAILY_LAST_TEXT:
          continue;

        default:
          throw new Error("Unknown field type: " + type);
      }
    }

    return result;
  },

  _serializeJSONDay: function (data) {
    let result = {"_v": this.version};

    for (let [field, data] of data) {
      if (!this.shouldIncludeField(field)) {
        continue;
      }

      let type = this.fieldType(field);

      switch (type) {
        case this.storage.FIELD_DAILY_COUNTER:
        case this.storage.FIELD_DAILY_DISCRETE_NUMERIC:
        case this.storage.FIELD_DAILY_DISCRETE_TEXT:
        case this.storage.FIELD_DAILY_LAST_NUMERIC:
        case this.storage.FIELD_DAILY_LAST_TEXT:
          result[field] = data;
          break;

        case this.storage.FIELD_LAST_NUMERIC:
        case this.storage.FIELD_LAST_TEXT:
          continue;

        default:
          throw new Error("Unknown field type: " + type);
      }
    }

    return result;
  },
});


/**
 * An entity that emits data.
 *
 * A `Provider` consists of a string name (must be globally unique among all
 * known providers) and a set of `Measurement` instances.
 *
 * The main role of a `Provider` is to produce metrics data and to store said
 * data in the storage backend.
 *
 * Metrics data collection is initiated either by a manager calling a
 * `collect*` function on `Provider` instances or by the `Provider` registering
 * to some external event and then reacting whenever they occur.
 *
 * `Provider` implementations interface directly with a storage backend. For
 * common stored values (daily counters, daily discrete values, etc),
 * implementations should interface with storage via the various helper
 * functions on the `Measurement` instances. For custom stored value types,
 * implementations will interact directly with the low-level storage APIs.
 *
 * Because multiple providers exist and could be responding to separate
 * external events simultaneously and because not all operations performed by
 * storage can safely be performed in parallel, writing directly to storage at
 * event time is dangerous. Therefore, interactions with storage must be
 * deferred until it is safe to perform them.
 *
 * This typically looks something like:
 *
 *   // This gets called when an external event worthy of recording metrics
 *   // occurs. The function receives a numeric value associated with the event.
 *   function onExternalEvent (value) {
 *     let now = new Date();
 *     let m = this.getMeasurement("foo", 1);
 *
 *     this.enqueueStorageOperation(function storeExternalEvent() {
 *
 *       // We interface with storage via the `Measurement` helper functions.
 *       // These each return a promise that will be resolved when the
 *       // operation finishes. We rely on behavior of storage where operations
 *       // are executed single threaded and sequentially. Therefore, we only
 *       // need to return the final promise.
 *       m.incrementDailyCounter("foo", now);
 *       return m.addDailyDiscreteNumericValue("my_value", value, now);
 *     }.bind(this));
 *
 *   }
 *
 *
 * `Provider` is an abstract base class. Implementations must define a few
 * properties:
 *
 *   name
 *     The `name` property should be a string defining the provider's name. The
 *     name must be globally unique for the application. The name is used as an
 *     identifier to distinguish providers from each other.
 *
 *   measurementTypes
 *     This must be an array of `Measurement`-derived types. Note that elements
 *     in the array are the type functions, not instances. Instances of the
 *     `Measurement` are created at run-time by the `Provider` and are bound
 *     to the provider and to a specific storage backend.
 */
this.Provider = function () {
  if (!this.name) {
    throw new Error("Provider must define a name.");
  }

  if (!Array.isArray(this.measurementTypes)) {
    throw new Error("Provider must define measurement types.");
  }

  this._log = Log.repository.getLogger("Services.Metrics.Provider." + this.name);

  this.measurements = null;
  this.storage = null;
}

Provider.prototype = Object.freeze({
  /**
   * Whether the provider only pulls data from other sources.
   *
   * If this is true, the provider pulls data from other sources. By contrast,
   * "push-based" providers subscribe to foreign sources and record/react to
   * external events as they happen.
   *
   * Pull-only providers likely aren't instantiated until a data collection
   * is performed. Thus, implementations cannot rely on a provider instance
   * always being alive. This is an optimization so provider instances aren't
   * dead weight while the application is running.
   *
   * This must be set on the prototype to have an effect.
   */
  pullOnly: false,

  /**
   * Obtain a `Measurement` from its name and version.
   *
   * If the measurement is not found, an Error is thrown.
   */
  getMeasurement: function (name, version) {
    if (!Number.isInteger(version)) {
      throw new Error("getMeasurement expects an integer version. Got: " + version);
    }

    let m = this.measurements.get([name, version].join(":"));

    if (!m) {
      throw new Error("Unknown measurement: " + name + " v" + version);
    }

    return m;
  },

  init: function (storage) {
    if (this.storage !== null) {
      throw new Error("Provider() not called. Did the sub-type forget to call it?");
    }

    if (this.storage) {
      throw new Error("Provider has already been initialized.");
    }

    this.measurements = new Map();
    this.storage = storage;

    let self = this;
    return Task.spawn(function init() {
      let pre = self.preInit();
      if (!pre || typeof(pre.then) != "function") {
        throw new Error("preInit() does not return a promise.");
      }
      yield pre;

      for (let measurementType of self.measurementTypes) {
        let measurement = new measurementType();

        measurement.provider = self;
        measurement.storage = self.storage;

        let id = yield storage.registerMeasurement(self.name, measurement.name,
                                                   measurement.version);

        measurement.id = id;

        yield measurement._configureStorage();

        self.measurements.set([measurement.name, measurement.version].join(":"),
                              measurement);
      }

      let post = self.postInit();
      if (!post || typeof(post.then) != "function") {
        throw new Error("postInit() does not return a promise.");
      }
      yield post;
    });
  },

  shutdown: function () {
    let promise = this.onShutdown();

    if (!promise || typeof(promise.then) != "function") {
      throw new Error("onShutdown implementation does not return a promise.");
    }

    return promise;
  },

  /**
   * Hook point for implementations to perform pre-initialization activity.
   *
   * This method will be called before measurement registration.
   *
   * Implementations should return a promise which is resolved when
   * initialization activities have completed.
   */
  preInit: function () {
    return CommonUtils.laterTickResolvingPromise();
  },

  /**
   * Hook point for implementations to perform post-initialization activity.
   *
   * This method will be called after `preInit` and measurement registration,
   * but before initialization is finished.
   *
   * If a `Provider` instance needs to register observers, etc, it should
   * implement this function.
   *
   * Implementations should return a promise which is resolved when
   * initialization activities have completed.
   */
  postInit: function () {
    return CommonUtils.laterTickResolvingPromise();
  },

  /**
   * Hook point for shutdown of instances.
   *
   * This is the opposite of `onInit`. If a `Provider` needs to unregister
   * observers, etc, this is where it should do it.
   *
   * Implementations should return a promise which is resolved when
   * shutdown activities have completed.
   */
  onShutdown: function () {
    return CommonUtils.laterTickResolvingPromise();
  },

  /**
   * Collects data that doesn't change during the application's lifetime.
   *
   * Implementations should return a promise that resolves when all data has
   * been collected and storage operations have been finished.
   *
   * @return Promise<>
   */
  collectConstantData: function () {
    return CommonUtils.laterTickResolvingPromise();
  },

  /**
   * Collects data approximately every day.
   *
   * For long-running applications, this is called approximately every day.
   * It may or may not be called every time the application is run. It also may
   * be called more than once per day.
   *
   * Implementations should return a promise that resolves when all data has
   * been collected and storage operations have completed.
   *
   * @return Promise<>
   */
  collectDailyData: function () {
    return CommonUtils.laterTickResolvingPromise();
  },

  /**
   * Queue a deferred storage operation.
   *
   * Deferred storage operations are the preferred method for providers to
   * interact with storage. When collected data is to be added to storage,
   * the provider creates a function that performs the necessary storage
   * interactions and then passes that function to this function. Pending
   * storage operations will be executed sequentially by a coordinator.
   *
   * The passed function should return a promise which will be resolved upon
   * completion of storage interaction.
   */
  enqueueStorageOperation: function (func) {
    return this.storage.enqueueOperation(func);
  },

  /**
   * Obtain persisted provider state.
   *
   * Provider state consists of key-value pairs of string names and values.
   * Providers can stuff whatever they want into state. They are encouraged to
   * store as little as possible for performance reasons.
   *
   * State is backed by storage and is robust.
   *
   * These functions do not enqueue on storage automatically, so they should
   * be guarded by `enqueueStorageOperation` or some other mutex.
   *
   * @param key
   *        (string) The property to retrieve.
   *
   * @return Promise<string|null> String value on success. null if no state
   *         is available under this key.
   */
  getState: function (key) {
    return this.storage.getProviderState(this.name, key);
  },

  /**
   * Set state for this provider.
   *
   * This is the complementary API for `getState` and obeys the same
   * storage restrictions.
   */
  setState: function (key, value) {
    return this.storage.setProviderState(this.name, key, value);
  },

  _dateToDays: function (date) {
    return Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
  },

  _daysToDate: function (days) {
    return new Date(days * MILLISECONDS_PER_DAY);
  },
});

//@line 25 "e:\hg38\comm-esr38\mozilla\services\metrics\Metrics.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 21 "e:\hg38\comm-esr38\mozilla\services\metrics\storage.jsm"

Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Sqlite.jsm");
Cu.import("resource://gre/modules/AsyncShutdown.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");


// These do not account for leap seconds. Meh.
function dateToDays(date) {
  return Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
}

function daysToDate(days) {
  return new Date(days * MILLISECONDS_PER_DAY);
}

/**
 * Represents a collection of per-day values.
 *
 * This is a proxy around a Map which can transparently round Date instances to
 * their appropriate key.
 *
 * This emulates Map by providing .size and iterator support. Note that keys
 * from the iterator are Date instances corresponding to midnight of the start
 * of the day. get(), has(), and set() are modeled as getDay(), hasDay(), and
 * setDay(), respectively.
 *
 * All days are defined in terms of UTC (as opposed to local time).
 */
this.DailyValues = function () {
  this._days = new Map();
};

DailyValues.prototype = Object.freeze({
  __iterator__: function () {
    for (let [k, v] of this._days) {
      yield [daysToDate(k), v];
    }
  },

  get size() {
    return this._days.size;
  },

  hasDay: function (date) {
    return this._days.has(dateToDays(date));
  },

  getDay: function (date) {
    return this._days.get(dateToDays(date));
  },

  setDay: function (date, value) {
    this._days.set(dateToDays(date), value);
  },

  appendValue: function (date, value) {
    let key = dateToDays(date);

    if (this._days.has(key)) {
      return this._days.get(key).push(value);
    }

    this._days.set(key, [value]);
  },
});


/**
 * DATABASE INFO
 * =============
 *
 * We use a SQLite database as the backend for persistent storage of metrics
 * data.
 *
 * Every piece of recorded data is associated with a measurement. A measurement
 * is an entity with a name and version. Each measurement is associated with a
 * named provider.
 *
 * When the metrics system is initialized, we ask providers (the entities that
 * emit data) to configure the database for storage of their data. They tell
 * storage what their requirements are. For example, they'll register
 * named daily counters associated with specific measurements.
 *
 * Recorded data is stored differently depending on the requirements for
 * storing it. We have facilities for storing the following classes of data:
 *
 *  1) Counts of event/field occurrences aggregated by day.
 *  2) Discrete values of fields aggregated by day.
 *  3) Discrete values of fields aggregated by day max 1 per day (last write
 *     wins).
 *  4) Discrete values of fields max 1 (last write wins).
 *
 * Most data is aggregated per day mainly for privacy reasons. This does throw
 * away potentially useful data. But, it's not currently used, so there is no
 * need to keep the granular information.
 *
 * Database Schema
 * ---------------
 *
 * This database contains the following tables:
 *
 *   providers -- Maps provider string name to an internal ID.
 *   provider_state -- Holds opaque persisted state for providers.
 *   measurements -- Holds the set of known measurements (name, version,
 *     provider tuples).
 *   types -- The data types that can be stored in measurements/fields.
 *   fields -- Describes entities that occur within measurements.
 *   daily_counters -- Holds daily-aggregated counts of events. Each row is
 *     associated with a field and a day.
 *   daily_discrete_numeric -- Holds numeric values for fields grouped by day.
 *     Each row contains a discrete value associated with a field that occurred
 *     on a specific day. There can be multiple rows per field per day.
 *   daily_discrete_text -- Holds text values for fields grouped by day. Each
 *     row contains a discrete value associated with a field that occurred on a
 *     specific day.
 *   daily_last_numeric -- Holds numeric values where the last encountered
 *     value for a given day is retained.
 *   daily_last_text -- Like daily_last_numeric except for text values.
 *   last_numeric -- Holds the most recent value for a numeric field.
 *   last_text -- Like last_numeric except for text fields.
 *
 * Notes
 * -----
 *
 * It is tempting to use SQLite's julianday() function to store days that
 * things happened. However, a Julian Day begins at *noon* in 4714 B.C. This
 * results in weird half day offsets from UNIX time. So, we instead store
 * number of days since UNIX epoch, not Julian.
 */

/**
 * All of our SQL statements are stored in a central mapping so they can easily
 * be audited for security, perf, etc.
 */
const SQL = {
  // Create the providers table.
  createProvidersTable: "\
CREATE TABLE providers (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  name TEXT, \
  UNIQUE (name) \
)",

  createProviderStateTable: "\
CREATE TABLE provider_state (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  provider_id INTEGER, \
  name TEXT, \
  VALUE TEXT, \
  UNIQUE (provider_id, name), \
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE\
)",

  createProviderStateProviderIndex: "\
CREATE INDEX i_provider_state_provider_id ON provider_state (provider_id)",

  createMeasurementsTable: "\
CREATE TABLE measurements (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  provider_id INTEGER, \
  name TEXT, \
  version INTEGER, \
  UNIQUE (provider_id, name, version), \
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE\
)",

  createMeasurementsProviderIndex: "\
CREATE INDEX i_measurements_provider_id ON measurements (provider_id)",

  createMeasurementsView: "\
CREATE VIEW v_measurements AS \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version \
  FROM providers, measurements \
  WHERE \
    measurements.provider_id = providers.id",

  createTypesTable: "\
CREATE TABLE types (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  name TEXT, \
  UNIQUE (name)\
)",

  createFieldsTable: "\
CREATE TABLE fields (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  measurement_id INTEGER, \
  name TEXT, \
  value_type INTEGER , \
  UNIQUE (measurement_id, name), \
  FOREIGN KEY (measurement_id) REFERENCES measurements(id) ON DELETE CASCADE \
  FOREIGN KEY (value_type) REFERENCES types(id) ON DELETE CASCADE \
)",

  createFieldsMeasurementIndex: "\
CREATE INDEX i_fields_measurement_id ON fields (measurement_id)",

  createFieldsView: "\
CREATE VIEW v_fields AS \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    types.id AS type_id, \
    types.name AS type_name \
  FROM providers, measurements, fields, types \
  WHERE \
    fields.measurement_id = measurements.id \
    AND measurements.provider_id = providers.id \
    AND fields.value_type = types.id",

  createDailyCountersTable: "\
CREATE TABLE daily_counters (\
  field_id INTEGER, \
  day INTEGER, \
  value INTEGER, \
  UNIQUE(field_id, day), \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createDailyCountersFieldIndex: "\
CREATE INDEX i_daily_counters_field_id ON daily_counters (field_id)",

  createDailyCountersDayIndex: "\
CREATE INDEX i_daily_counters_day ON daily_counters (day)",

  createDailyCountersView: "\
CREATE VIEW v_daily_counters AS SELECT \
  providers.id AS provider_id, \
  providers.name AS provider_name, \
  measurements.id AS measurement_id, \
  measurements.name AS measurement_name, \
  measurements.version AS measurement_version, \
  fields.id AS field_id, \
  fields.name AS field_name, \
  daily_counters.day AS day, \
  daily_counters.value AS value \
FROM providers, measurements, fields, daily_counters \
WHERE \
  daily_counters.field_id = fields.id \
  AND fields.measurement_id = measurements.id \
  AND measurements.provider_id = providers.id",

  createDailyDiscreteNumericsTable: "\
CREATE TABLE daily_discrete_numeric (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  field_id INTEGER, \
  day INTEGER, \
  value INTEGER, \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createDailyDiscreteNumericsFieldIndex: "\
CREATE INDEX i_daily_discrete_numeric_field_id \
ON daily_discrete_numeric (field_id)",

  createDailyDiscreteNumericsDayIndex: "\
CREATE INDEX i_daily_discrete_numeric_day \
ON daily_discrete_numeric (day)",

  createDailyDiscreteTextTable: "\
CREATE TABLE daily_discrete_text (\
  id INTEGER PRIMARY KEY AUTOINCREMENT, \
  field_id INTEGER, \
  day INTEGER, \
  value TEXT, \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createDailyDiscreteTextFieldIndex: "\
CREATE INDEX i_daily_discrete_text_field_id \
ON daily_discrete_text (field_id)",

  createDailyDiscreteTextDayIndex: "\
CREATE INDEX i_daily_discrete_text_day \
ON daily_discrete_text (day)",

  createDailyDiscreteView: "\
CREATE VIEW v_daily_discrete AS \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    daily_discrete_numeric.id AS value_id, \
    daily_discrete_numeric.day AS day, \
    daily_discrete_numeric.value AS value, \
    \"numeric\" AS value_type \
    FROM providers, measurements, fields, daily_discrete_numeric \
    WHERE \
      daily_discrete_numeric.field_id = fields.id \
      AND fields.measurement_id = measurements.id \
      AND measurements.provider_id = providers.id \
  UNION ALL \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    daily_discrete_text.id AS value_id, \
    daily_discrete_text.day AS day, \
    daily_discrete_text.value AS value, \
    \"text\" AS value_type \
    FROM providers, measurements, fields, daily_discrete_text \
    WHERE \
      daily_discrete_text.field_id = fields.id \
      AND fields.measurement_id = measurements.id \
      AND measurements.provider_id = providers.id \
  ORDER BY day ASC, value_id ASC",

  createLastNumericTable: "\
CREATE TABLE last_numeric (\
  field_id INTEGER PRIMARY KEY, \
  day INTEGER, \
  value NUMERIC, \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createLastTextTable: "\
CREATE TABLE last_text (\
  field_id INTEGER PRIMARY KEY, \
  day INTEGER, \
  value TEXT, \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createLastView: "\
CREATE VIEW v_last AS \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    last_numeric.day AS day, \
    last_numeric.value AS value, \
    \"numeric\" AS value_type \
    FROM providers, measurements, fields, last_numeric \
    WHERE \
      last_numeric.field_id = fields.id \
      AND fields.measurement_id = measurements.id \
      AND measurements.provider_id = providers.id \
  UNION ALL \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    last_text.day AS day, \
    last_text.value AS value, \
    \"text\" AS value_type \
    FROM providers, measurements, fields, last_text \
    WHERE \
      last_text.field_id = fields.id \
      AND fields.measurement_id = measurements.id \
      AND measurements.provider_id = providers.id",

  createDailyLastNumericTable: "\
CREATE TABLE daily_last_numeric (\
  field_id INTEGER, \
  day INTEGER, \
  value NUMERIC, \
  UNIQUE (field_id, day) \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createDailyLastNumericFieldIndex: "\
CREATE INDEX i_daily_last_numeric_field_id ON daily_last_numeric (field_id)",

  createDailyLastNumericDayIndex: "\
CREATE INDEX i_daily_last_numeric_day ON daily_last_numeric (day)",

  createDailyLastTextTable: "\
CREATE TABLE daily_last_text (\
  field_id INTEGER, \
  day INTEGER, \
  value TEXT, \
  UNIQUE (field_id, day) \
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE\
)",

  createDailyLastTextFieldIndex: "\
CREATE INDEX i_daily_last_text_field_id ON daily_last_text (field_id)",

  createDailyLastTextDayIndex: "\
CREATE INDEX i_daily_last_text_day ON daily_last_text (day)",

  createDailyLastView: "\
CREATE VIEW v_daily_last AS \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    daily_last_numeric.day AS day, \
    daily_last_numeric.value AS value, \
    \"numeric\" as value_type \
    FROM providers, measurements, fields, daily_last_numeric \
    WHERE \
      daily_last_numeric.field_id = fields.id \
      AND fields.measurement_id = measurements.id \
      AND measurements.provider_id = providers.id \
  UNION ALL \
  SELECT \
    providers.id AS provider_id, \
    providers.name AS provider_name, \
    measurements.id AS measurement_id, \
    measurements.name AS measurement_name, \
    measurements.version AS measurement_version, \
    fields.id AS field_id, \
    fields.name AS field_name, \
    daily_last_text.day AS day, \
    daily_last_text.value AS value, \
    \"text\" as value_type \
    FROM providers, measurements, fields, daily_last_text \
    WHERE \
      daily_last_text.field_id = fields.id \
      AND fields.measurement_id = measurements.id \
      AND measurements.provider_id = providers.id",

  // Mutation.

  addProvider: "INSERT INTO providers (name) VALUES (:provider)",

  setProviderState: "\
INSERT OR REPLACE INTO provider_state \
  (provider_id, name, value) \
  VALUES (:provider_id, :name, :value)",

  addMeasurement: "\
INSERT INTO measurements (provider_id, name, version) \
  VALUES (:provider_id, :measurement, :version)",

  addType: "INSERT INTO types (name) VALUES (:name)",

  addField: "\
INSERT INTO fields (measurement_id, name, value_type) \
  VALUES (:measurement_id, :field, :value_type)",

  incrementDailyCounterFromFieldID: "\
INSERT OR REPLACE INTO daily_counters VALUES (\
  :field_id, \
  :days, \
  COALESCE(\
    (SELECT value FROM daily_counters WHERE \
      field_id = :field_id AND day = :days \
    ), \
    0\
  ) + :by)",

  deleteLastNumericFromFieldID: "\
DELETE FROM last_numeric WHERE field_id = :field_id",

  deleteLastTextFromFieldID: "\
DELETE FROM last_text WHERE field_id = :field_id",

  setLastNumeric: "\
INSERT OR REPLACE INTO last_numeric VALUES (:field_id, :days, :value)",

  setLastText: "\
INSERT OR REPLACE INTO last_text VALUES (:field_id, :days, :value)",

  setDailyLastNumeric: "\
INSERT OR REPLACE INTO daily_last_numeric VALUES (:field_id, :days, :value)",

  setDailyLastText: "\
INSERT OR REPLACE INTO daily_last_text VALUES (:field_id, :days, :value)",

  addDailyDiscreteNumeric: "\
INSERT INTO daily_discrete_numeric \
(field_id, day, value) VALUES (:field_id, :days, :value)",

  addDailyDiscreteText: "\
INSERT INTO daily_discrete_text \
(field_id, day, value) VALUES (:field_id, :days, :value)",

  pruneOldDailyCounters: "DELETE FROM daily_counters WHERE day < :days",
  pruneOldDailyDiscreteNumeric: "DELETE FROM daily_discrete_numeric WHERE day < :days",
  pruneOldDailyDiscreteText: "DELETE FROM daily_discrete_text WHERE day < :days",
  pruneOldDailyLastNumeric: "DELETE FROM daily_last_numeric WHERE day < :days",
  pruneOldDailyLastText: "DELETE FROM daily_last_text WHERE day < :days",
  pruneOldLastNumeric: "DELETE FROM last_numeric WHERE day < :days",
  pruneOldLastText: "DELETE FROM last_text WHERE day < :days",

  // Retrieval.

  getProviderID: "SELECT id FROM providers WHERE name = :provider",

  getProviders: "SELECT id, name FROM providers",

  getProviderStateWithName: "\
SELECT value FROM provider_state \
  WHERE provider_id = :provider_id \
  AND name = :name",

  getMeasurements: "SELECT * FROM v_measurements",

  getMeasurementID: "\
SELECT id FROM measurements \
  WHERE provider_id = :provider_id \
    AND name = :measurement \
    AND version = :version",

  getFieldID: "\
SELECT id FROM fields \
  WHERE measurement_id = :measurement_id \
    AND name = :field \
    AND value_type = :value_type \
",

  getTypes: "SELECT * FROM types",

  getTypeID: "SELECT id FROM types WHERE name = :name",

  getDailyCounterCountsFromFieldID: "\
SELECT day, value FROM daily_counters \
  WHERE field_id = :field_id \
  ORDER BY day ASC",

  getDailyCounterCountFromFieldID: "\
SELECT value FROM daily_counters \
  WHERE field_id = :field_id \
    AND day = :days",

  getMeasurementDailyCounters: "\
SELECT field_name, day, value FROM v_daily_counters \
WHERE measurement_id = :measurement_id",

  getFieldInfo: "SELECT * FROM v_fields",

  getLastNumericFromFieldID: "\
SELECT day, value FROM last_numeric WHERE field_id = :field_id",

  getLastTextFromFieldID: "\
SELECT day, value FROM last_text WHERE field_id = :field_id",

  getMeasurementLastValues: "\
SELECT field_name, day, value FROM v_last \
WHERE measurement_id = :measurement_id",

  getDailyDiscreteNumericFromFieldID: "\
SELECT day, value FROM daily_discrete_numeric \
  WHERE field_id = :field_id \
  ORDER BY day ASC, id ASC",

  getDailyDiscreteNumericFromFieldIDAndDay: "\
SELECT day, value FROM daily_discrete_numeric \
  WHERE field_id = :field_id AND day = :days \
  ORDER BY id ASC",

  getDailyDiscreteTextFromFieldID: "\
SELECT day, value FROM daily_discrete_text \
  WHERE field_id = :field_id \
  ORDER BY day ASC, id ASC",

  getDailyDiscreteTextFromFieldIDAndDay: "\
SELECT day, value FROM daily_discrete_text \
  WHERE field_id = :field_id AND day = :days \
  ORDER BY id ASC",

  getMeasurementDailyDiscreteValues: "\
SELECT field_name, day, value_id, value FROM v_daily_discrete \
WHERE measurement_id = :measurement_id \
ORDER BY day ASC, value_id ASC",

  getDailyLastNumericFromFieldID: "\
SELECT day, value FROM daily_last_numeric \
  WHERE field_id = :field_id \
  ORDER BY day ASC",

  getDailyLastNumericFromFieldIDAndDay: "\
SELECT day, value FROM daily_last_numeric \
  WHERE field_id = :field_id AND day = :days",

  getDailyLastTextFromFieldID: "\
SELECT day, value FROM daily_last_text \
  WHERE field_id = :field_id \
  ORDER BY day ASC",

  getDailyLastTextFromFieldIDAndDay: "\
SELECT day, value FROM daily_last_text \
  WHERE field_id = :field_id AND day = :days",

  getMeasurementDailyLastValues: "\
SELECT field_name, day, value FROM v_daily_last \
WHERE measurement_id = :measurement_id",
};


function dailyKeyFromDate(date) {
  let year = String(date.getUTCFullYear());
  let month = String(date.getUTCMonth() + 1);
  let day = String(date.getUTCDate());

  if (month.length < 2) {
    month = "0" + month;
  }

  if (day.length < 2) {
    day = "0" + day;
  }

  return year + "-" + month + "-" + day;
}


/**
 * Create a new backend instance bound to a SQLite database at the given path.
 *
 * This returns a promise that will resolve to a `MetricsStorageSqliteBackend`
 * instance. The resolved instance will be initialized and ready for use.
 *
 * Very few consumers have a need to call this. Instead, a higher-level entity
 * likely calls this and sets up the database connection for a service or
 * singleton.
 */
this.MetricsStorageBackend = function (path) {
  return Task.spawn(function initTask() {
    let connection = yield Sqlite.openConnection({
      path: path,

      // There should only be one connection per database, so we disable this
      // for perf reasons.
      sharedMemoryCache: false,
    });

    // If we fail initializing the storage object, we need to close the
    // database connection or else Storage will assert on shutdown.
    let storage;
    try {
      storage = new MetricsStorageSqliteBackend(connection);
      yield storage._init();
    } catch (ex) {
      yield connection.close();
      throw ex;
    }

    throw new Task.Result(storage);
  });
};

// Expose an asynchronous barrier `shutdown` that clients may use to
// perform last minute cleanup and shutdown requests before this module
// is shut down.
// See the documentation of AsyncShutdown.Barrier for more details.
let shutdown = new AsyncShutdown.Barrier("Metrics Storage Backend");
this.MetricsStorageBackend.shutdown = shutdown.client;
Sqlite.shutdown.addBlocker("Metrics Storage: Shutting down",
  () => shutdown.wait());

/**
 * Manages storage of metrics data in a SQLite database.
 *
 * This is the main type used for interfacing with the database.
 *
 * Instances of this should be obtained by calling MetricsStorageConnection().
 *
 * The current implementation will not work if the database is mutated by
 * multiple connections because of the way we cache primary keys.
 *
 * FUTURE enforce 1 read/write connection per database limit.
 */
function MetricsStorageSqliteBackend(connection) {
  this._log = Log.repository.getLogger("Services.Metrics.MetricsStorage");

  this._connection = connection;
  this._enabledWALCheckpointPages = null;

  // Integer IDs to string name.
  this._typesByID = new Map();

  // String name to integer IDs.
  this._typesByName = new Map();

  // Maps provider names to integer IDs.
  this._providerIDs = new Map();

  // Maps :-delimited strings of [provider name, name, version] to integer IDs.
  this._measurementsByInfo = new Map();

  // Integer IDs to Arrays of [provider name, name, version].
  this._measurementsByID = new Map();

  // Integer IDs to Arrays of [measurement id, field name, value name]
  this._fieldsByID = new Map();

  // Maps :-delimited strings of [measurement id, field name] to integer ID.
  this._fieldsByInfo = new Map();

  // Maps measurement ID to sets of field IDs.
  this._fieldsByMeasurement = new Map();

  this._queuedOperations = [];
  this._queuedInProgress = false;
}

MetricsStorageSqliteBackend.prototype = Object.freeze({
  // Max size (in kibibytes) the WAL log is allowed to grow to before it is
  // checkpointed.
  //
  // This was first deployed in bug 848136. We want a value large enough
  // that we aren't checkpointing all the time. However, we want it
  // small enough so we don't have to read so much when we open the
  // database.
  MAX_WAL_SIZE_KB: 512,

  FIELD_DAILY_COUNTER: "daily-counter",
  FIELD_DAILY_DISCRETE_NUMERIC: "daily-discrete-numeric",
  FIELD_DAILY_DISCRETE_TEXT: "daily-discrete-text",
  FIELD_DAILY_LAST_NUMERIC: "daily-last-numeric",
  FIELD_DAILY_LAST_TEXT: "daily-last-text",
  FIELD_LAST_NUMERIC: "last-numeric",
  FIELD_LAST_TEXT: "last-text",

  _BUILTIN_TYPES: [
    "FIELD_DAILY_COUNTER",
    "FIELD_DAILY_DISCRETE_NUMERIC",
    "FIELD_DAILY_DISCRETE_TEXT",
    "FIELD_DAILY_LAST_NUMERIC",
    "FIELD_DAILY_LAST_TEXT",
    "FIELD_LAST_NUMERIC",
    "FIELD_LAST_TEXT",
  ],

  // Statements that are used to create the initial DB schema.
  _SCHEMA_STATEMENTS: [
    "createProvidersTable",
    "createProviderStateTable",
    "createProviderStateProviderIndex",
    "createMeasurementsTable",
    "createMeasurementsProviderIndex",
    "createMeasurementsView",
    "createTypesTable",
    "createFieldsTable",
    "createFieldsMeasurementIndex",
    "createFieldsView",
    "createDailyCountersTable",
    "createDailyCountersFieldIndex",
    "createDailyCountersDayIndex",
    "createDailyCountersView",
    "createDailyDiscreteNumericsTable",
    "createDailyDiscreteNumericsFieldIndex",
    "createDailyDiscreteNumericsDayIndex",
    "createDailyDiscreteTextTable",
    "createDailyDiscreteTextFieldIndex",
    "createDailyDiscreteTextDayIndex",
    "createDailyDiscreteView",
    "createDailyLastNumericTable",
    "createDailyLastNumericFieldIndex",
    "createDailyLastNumericDayIndex",
    "createDailyLastTextTable",
    "createDailyLastTextFieldIndex",
    "createDailyLastTextDayIndex",
    "createDailyLastView",
    "createLastNumericTable",
    "createLastTextTable",
    "createLastView",
  ],

  // Statements that are used to prune old data.
  _PRUNE_STATEMENTS: [
    "pruneOldDailyCounters",
    "pruneOldDailyDiscreteNumeric",
    "pruneOldDailyDiscreteText",
    "pruneOldDailyLastNumeric",
    "pruneOldDailyLastText",
    "pruneOldLastNumeric",
    "pruneOldLastText",
  ],

  /**
   * Close the database connection.
   *
   * This should be called on all instances or the SQLite layer may complain
   * loudly. After this has been called, the connection cannot be used.
   *
   * @return Promise<> A promise fulfilled once the connection is closed.
   * This promise never rejects.
   */
  close: function () {
    return Task.spawn(function doClose() {
      // There is some light magic involved here. First, we enqueue an
      // operation to ensure that all pending operations have the opportunity
      // to execute. We additionally execute a SQL operation. Due to the FIFO
      // execution order of issued statements, this will cause us to wait on
      // any outstanding statements before closing.
      try {
        yield this.enqueueOperation(function dummyOperation() {
          return this._connection.execute("SELECT 1");
        }.bind(this));
      } catch (ex) {}

      try {
        yield this._connection.close();
      } finally {
        this._connection = null;
      }
    }.bind(this));
  },

  /**
   * Whether a provider is known to exist.
   *
   * @param provider
   *        (string) Name of the provider.
   */
  hasProvider: function (provider) {
    return this._providerIDs.has(provider);
  },

  /**
   * Whether a measurement is known to exist.
   *
   * @param provider
   *        (string) Name of the provider.
   * @param name
   *        (string) Name of the measurement.
   * @param version
   *        (Number) Integer measurement version.
   */
  hasMeasurement: function (provider, name, version) {
    return this._measurementsByInfo.has([provider, name, version].join(":"));
  },

  /**
   * Whether a named field exists in a measurement.
   *
   * @param measurementID
   *        (Number) The integer primary key of the measurement.
   * @param field
   *        (string) The name of the field to look for.
   */
  hasFieldFromMeasurement: function (measurementID, field) {
    return this._fieldsByInfo.has([measurementID, field].join(":"));
  },

  /**
   * Whether a field is known.
   *
   * @param provider
   *        (string) Name of the provider having the field.
   * @param measurement
   *        (string) Name of the measurement in the provider having the field.
   * @param field
   *        (string) Name of the field in the measurement.
   */
  hasField: function (provider, measurement, version, field) {
    let key = [provider, measurement, version].join(":");
    let measurementID = this._measurementsByInfo.get(key);
    if (!measurementID) {
      return false;
    }

    return this.hasFieldFromMeasurement(measurementID, field);
  },

  /**
   * Look up the integer primary key of a provider.
   *
   * @param provider
   *        (string) Name of the provider.
   */
  providerID: function (provider) {
    return this._providerIDs.get(provider);
  },

  /**
   * Look up the integer primary key of a measurement.
   *
   * @param provider
   *        (string) Name of the provider.
   * @param measurement
   *        (string) Name of the measurement.
   * @param version
   *        (Number) Integer version of the measurement.
   */
  measurementID: function (provider, measurement, version) {
    return this._measurementsByInfo.get([provider, measurement, version].join(":"));
  },

  fieldIDFromMeasurement: function (measurementID, field) {
    return this._fieldsByInfo.get([measurementID, field].join(":"));
  },

  fieldID: function (provider, measurement, version, field) {
    let measurementID = this.measurementID(provider, measurement, version);
    if (!measurementID) {
      return null;
    }

    return this.fieldIDFromMeasurement(measurementID, field);
  },

  measurementHasAnyDailyCounterFields: function (measurementID) {
    return this.measurementHasAnyFieldsOfTypes(measurementID,
                                               [this.FIELD_DAILY_COUNTER]);
  },

  measurementHasAnyLastFields: function (measurementID) {
    return this.measurementHasAnyFieldsOfTypes(measurementID,
                                               [this.FIELD_LAST_NUMERIC,
                                                this.FIELD_LAST_TEXT]);
  },

  measurementHasAnyDailyLastFields: function (measurementID) {
    return this.measurementHasAnyFieldsOfTypes(measurementID,
                                               [this.FIELD_DAILY_LAST_NUMERIC,
                                                this.FIELD_DAILY_LAST_TEXT]);
  },

  measurementHasAnyDailyDiscreteFields: function (measurementID) {
    return this.measurementHasAnyFieldsOfTypes(measurementID,
                                               [this.FIELD_DAILY_DISCRETE_NUMERIC,
                                                this.FIELD_DAILY_DISCRETE_TEXT]);
  },

  measurementHasAnyFieldsOfTypes: function (measurementID, types) {
    if (!this._fieldsByMeasurement.has(measurementID)) {
      return false;
    }

    let fieldIDs = this._fieldsByMeasurement.get(measurementID);
    for (let fieldID of fieldIDs) {
      let fieldType = this._fieldsByID.get(fieldID)[2];
      if (types.indexOf(fieldType) != -1) {
        return true;
      }
    }

    return false;
  },

  /**
   * Register a measurement with the backend.
   *
   * Measurements must be registered before storage can be allocated to them.
   *
   * A measurement consists of a string name and integer version attached
   * to a named provider.
   *
   * This returns a promise that resolves to the storage ID for this
   * measurement.
   *
   * If the measurement is not known to exist, it is registered with storage.
   * If the measurement has already been registered, this is effectively a
   * no-op (that still returns a promise resolving to the storage ID).
   *
   * @param provider
   *        (string) Name of the provider this measurement belongs to.
   * @param name
   *        (string) Name of this measurement.
   * @param version
   *        (Number) Integer version of this measurement.
   */
  registerMeasurement: function (provider, name, version) {
    if (this.hasMeasurement(provider, name, version)) {
      return CommonUtils.laterTickResolvingPromise(
        this.measurementID(provider, name, version));
    }

    // Registrations might not be safe to perform in parallel with provider
    // operations. So, we queue them.
    let self = this;
    return this.enqueueOperation(function createMeasurementOperation() {
      return Task.spawn(function createMeasurement() {
        let providerID = self._providerIDs.get(provider);

        if (!providerID) {
          yield self._connection.executeCached(SQL.addProvider, {provider: provider});
          let rows = yield self._connection.executeCached(SQL.getProviderID,
                                                          {provider: provider});

          providerID = rows[0].getResultByIndex(0);

          self._providerIDs.set(provider, providerID);
        }

        let params = {
          provider_id: providerID,
          measurement: name,
          version: version,
        };

        yield self._connection.executeCached(SQL.addMeasurement, params);
        let rows = yield self._connection.executeCached(SQL.getMeasurementID, params);

        let measurementID = rows[0].getResultByIndex(0);

        self._measurementsByInfo.set([provider, name, version].join(":"), measurementID);
        self._measurementsByID.set(measurementID, [provider, name, version]);
        self._fieldsByMeasurement.set(measurementID, new Set());

        throw new Task.Result(measurementID);
      });
    });
  },

  /**
   * Register a field with the backend.
   *
   * Fields are what recorded pieces of data are primarily associated with.
   *
   * Fields are associated with measurements. Measurements must be registered
   * via `registerMeasurement` before fields can be registered. This is
   * enforced by this function requiring the database primary key of the
   * measurement as an argument.
   *
   * @param measurementID
   *        (Number) Integer primary key of measurement this field belongs to.
   * @param field
   *        (string) Name of this field.
   * @param valueType
   *        (string) Type name of this field. Must be a registered type. Is
   *        likely one of the FIELD_ constants on this type.
   *
   * @return Promise<integer>
   */
  registerField: function (measurementID, field, valueType) {
    if (!valueType) {
      throw new Error("Value type must be defined.");
    }

    if (!this._measurementsByID.has(measurementID)) {
      throw new Error("Measurement not known: " + measurementID);
    }

    if (!this._typesByName.has(valueType)) {
      throw new Error("Unknown value type: " + valueType);
    }

    let typeID = this._typesByName.get(valueType);

    if (!typeID) {
      throw new Error("Undefined type: " + valueType);
    }

    if (this.hasFieldFromMeasurement(measurementID, field)) {
      let id = this.fieldIDFromMeasurement(measurementID, field);
      let existingType = this._fieldsByID.get(id)[2];

      if (valueType != existingType) {
        throw new Error("Field already defined with different type: " + existingType);
      }

      return CommonUtils.laterTickResolvingPromise(
        this.fieldIDFromMeasurement(measurementID, field));
    }

    let self = this;
    return Task.spawn(function createField() {
      let params = {
        measurement_id: measurementID,
        field: field,
        value_type: typeID,
      };

      yield self._connection.executeCached(SQL.addField, params);

      let rows = yield self._connection.executeCached(SQL.getFieldID, params);

      let fieldID = rows[0].getResultByIndex(0);

      self._fieldsByID.set(fieldID, [measurementID, field, valueType]);
      self._fieldsByInfo.set([measurementID, field].join(":"), fieldID);
      self._fieldsByMeasurement.get(measurementID).add(fieldID);

      throw new Task.Result(fieldID);
    });
  },

  /**
   * Initializes this instance with the database.
   *
   * This performs 2 major roles:
   *
   *   1) Set up database schema (creates tables).
   *   2) Synchronize database with local instance.
   */
  _init: function() {
    let self = this;
    return Task.spawn(function initTask() {
      // 0. Database file and connection configuration.

      // This should never fail. But, we assume the default of 1024 in case it
      // does.
      let rows = yield self._connection.execute("PRAGMA page_size");
      let pageSize = 1024;
      if (rows.length) {
        pageSize = rows[0].getResultByIndex(0);
      }

      self._log.debug("Page size is " + pageSize);

      // Ensure temp tables are stored in memory, not on disk.
      yield self._connection.execute("PRAGMA temp_store=MEMORY");

      let journalMode;
      rows = yield self._connection.execute("PRAGMA journal_mode=WAL");
      if (rows.length) {
        journalMode = rows[0].getResultByIndex(0);
      }

      self._log.info("Journal mode is " + journalMode);

      if (journalMode == "wal") {
        self._enabledWALCheckpointPages =
          Math.ceil(self.MAX_WAL_SIZE_KB * 1024 / pageSize);

        self._log.info("WAL auto checkpoint pages: " +
                       self._enabledWALCheckpointPages);

        // We disable auto checkpoint during initialization to make it
        // quicker.
        yield self.setAutoCheckpoint(0);
      } else {
        if (journalMode != "truncate") {
         // Fall back to truncate (which is faster than delete).
          yield self._connection.execute("PRAGMA journal_mode=TRUNCATE");
        }

        // And always use full synchronous mode to reduce possibility for data
        // loss.
        yield self._connection.execute("PRAGMA synchronous=FULL");
      }

      let doCheckpoint = false;

      // 1. Create the schema.
      yield self._connection.executeTransaction(function ensureSchema(conn) {
        let schema = yield conn.getSchemaVersion();

        if (schema == 0) {
          self._log.info("Creating database schema.");

          for (let k of self._SCHEMA_STATEMENTS) {
            yield self._connection.execute(SQL[k]);
          }

          yield self._connection.setSchemaVersion(1);
          doCheckpoint = true;
        } else if (schema != 1) {
          throw new Error("Unknown database schema: " + schema);
        } else {
          self._log.debug("Database schema up to date.");
        }
      });

      // 2. Retrieve existing types.
      yield self._connection.execute(SQL.getTypes, null, function onRow(row) {
        let id = row.getResultByName("id");
        let name = row.getResultByName("name");

        self._typesByID.set(id, name);
        self._typesByName.set(name, id);
      });

      // 3. Populate built-in types with database.
      let missingTypes = [];
      for (let type of self._BUILTIN_TYPES) {
        type = self[type];
        if (self._typesByName.has(type)) {
          continue;
        }

        missingTypes.push(type);
      }

      // Don't perform DB transaction unless there is work to do.
      if (missingTypes.length) {
        yield self._connection.executeTransaction(function populateBuiltinTypes() {
          for (let type of missingTypes) {
            let params = {name: type};
            yield self._connection.executeCached(SQL.addType, params);
            let rows = yield self._connection.executeCached(SQL.getTypeID, params);
            let id = rows[0].getResultByIndex(0);

            self._typesByID.set(id, type);
            self._typesByName.set(type, id);
          }
        });

        doCheckpoint = true;
      }

      // 4. Obtain measurement info.
      yield self._connection.execute(SQL.getMeasurements, null, function onRow(row) {
        let providerID = row.getResultByName("provider_id");
        let providerName = row.getResultByName("provider_name");
        let measurementID = row.getResultByName("measurement_id");
        let measurementName = row.getResultByName("measurement_name");
        let measurementVersion = row.getResultByName("measurement_version");

        self._providerIDs.set(providerName, providerID);

        let info = [providerName, measurementName, measurementVersion].join(":");

        self._measurementsByInfo.set(info, measurementID);
        self._measurementsByID.set(measurementID, info);
        self._fieldsByMeasurement.set(measurementID, new Set());
      });

      // 5. Obtain field info.
      yield self._connection.execute(SQL.getFieldInfo, null, function onRow(row) {
        let measurementID = row.getResultByName("measurement_id");
        let fieldID = row.getResultByName("field_id");
        let fieldName = row.getResultByName("field_name");
        let typeName = row.getResultByName("type_name");

        self._fieldsByID.set(fieldID, [measurementID, fieldName, typeName]);
        self._fieldsByInfo.set([measurementID, fieldName].join(":"), fieldID);
        self._fieldsByMeasurement.get(measurementID).add(fieldID);
      });

      // Perform a checkpoint after initialization (if needed) and
      // enable auto checkpoint during regular operation.
      if (doCheckpoint) {
        yield self.checkpoint();
      }

      yield self.setAutoCheckpoint(1);
    });
  },

  /**
   * Prune all data from earlier than the specified date.
   *
   * Data stored on days before the specified Date will be permanently
   * deleted.
   *
   * This returns a promise that will be resolved when data has been deleted.
   *
   * @param date
   *        (Date) Old data threshold.
   * @return Promise<>
   */
  pruneDataBefore: function (date) {
    let statements = this._PRUNE_STATEMENTS;

    let self = this;
    return this.enqueueOperation(function doPrune() {
      return self._connection.executeTransaction(function prune(conn) {
        let days = dateToDays(date);

        let params = {days: days};
        for (let name of statements) {
          yield conn.execute(SQL[name], params);
        }
      });
    });
  },

  /**
   * Reduce memory usage as much as possible.
   *
   * This returns a promise that will be resolved on completion.
   *
   * @return Promise<>
   */
  compact: function () {
    let self = this;
    return this.enqueueOperation(function doCompact() {
      self._connection.discardCachedStatements();
      return self._connection.shrinkMemory();
    });
  },

  /**
   * Checkpoint writes requiring flush to disk.
   *
   * This is called to persist queued and non-flushed writes to disk.
   * It will force an fsync, so it is expensive and should be used
   * sparingly.
   */
  checkpoint: function () {
    if (!this._enabledWALCheckpointPages) {
      return CommonUtils.laterTickResolvingPromise();
    }

    return this.enqueueOperation(function checkpoint() {
      this._log.info("Performing manual WAL checkpoint.");
      return this._connection.execute("PRAGMA wal_checkpoint");
    }.bind(this));
  },

  setAutoCheckpoint: function (on) {
    // If we aren't in WAL mode, wal_autocheckpoint won't do anything so
    // we no-op.
    if (!this._enabledWALCheckpointPages) {
      return CommonUtils.laterTickResolvingPromise();
    }

    let val = on ? this._enabledWALCheckpointPages : 0;

    return this.enqueueOperation(function setWALCheckpoint() {
      this._log.info("Setting WAL auto checkpoint to " + val);
      return this._connection.execute("PRAGMA wal_autocheckpoint=" + val);
    }.bind(this));
  },

  /**
   * Ensure a field ID matches a specified type.
   *
   * This is called internally as part of adding values to ensure that
   * the type of a field matches the operation being performed.
   */
  _ensureFieldType: function (id, type) {
    let info = this._fieldsByID.get(id);

    if (!info || !Array.isArray(info)) {
      throw new Error("Unknown field ID: " + id);
    }

    if (type != info[2]) {
      throw new Error("Field type does not match the expected for this " +
                      "operation. Actual: " + info[2] + "; Expected: " +
                      type);
    }
  },

  /**
   * Enqueue a storage operation to be performed when the database is ready.
   *
   * The primary use case of this function is to prevent potentially
   * conflicting storage operations from being performed in parallel. By
   * calling this function, passed storage operations will be serially
   * executed, avoiding potential order of operation issues.
   *
   * The passed argument is a function that will perform storage operations.
   * The function should return a promise that will be resolved when all
   * storage operations have been completed.
   *
   * The passed function may be executed immediately. If there are already
   * queued operations, it will be appended to the queue and executed after all
   * before it have finished.
   *
   * This function returns a promise that will be resolved or rejected with
   * the same value that the function's promise was resolved or rejected with.
   *
   * @param func
   *        (function) Function performing storage interactions.
   * @return Promise<>
   */
  enqueueOperation: function (func) {
    if (typeof(func) != "function") {
      throw new Error("enqueueOperation expects a function. Got: " + typeof(func));
    }

    this._log.trace("Enqueueing operation.");
    let deferred = Promise.defer();

    this._queuedOperations.push([func, deferred]);

    if (this._queuedOperations.length == 1) {
      this._popAndPerformQueuedOperation();
    }

    return deferred.promise;
  },

  /**
   * Enqueue a function to be performed as a transaction.
   *
   * The passed function should be a generator suitable for calling with
   * `executeTransaction` from the SQLite connection.
   */
  enqueueTransaction: function (func, type) {
    return this.enqueueOperation(
      this._connection.executeTransaction.bind(this._connection, func, type)
    );
  },

  _popAndPerformQueuedOperation: function () {
    if (!this._queuedOperations.length || this._queuedInProgress) {
      return;
    }

    this._log.trace("Performing queued operation.");
    let [func, deferred] = this._queuedOperations.shift();
    let promise;

    try {
      this._queuedInProgress = true;
      promise = func();
    } catch (ex) {
      this._log.warn("Queued operation threw during execution: " +
                     CommonUtils.exceptionStr(ex));
      this._queuedInProgress = false;
      deferred.reject(ex);
      this._popAndPerformQueuedOperation();
      return;
    }

    if (!promise || typeof(promise.then) != "function") {
      let msg = "Queued operation did not return a promise: " + func;
      this._log.warn(msg);

      this._queuedInProgress = false;
      deferred.reject(new Error(msg));
      this._popAndPerformQueuedOperation();
      return;
    }

    promise.then(
      function onSuccess(result) {
        this._log.trace("Queued operation completed.");
        this._queuedInProgress = false;
        deferred.resolve(result);
        this._popAndPerformQueuedOperation();
      }.bind(this),
      function onError(error) {
        this._log.warn("Failure when performing queued operation: " +
                       CommonUtils.exceptionStr(error));
        this._queuedInProgress = false;
        deferred.reject(error);
        this._popAndPerformQueuedOperation();
      }.bind(this)
    );
  },

  /**
   * Obtain all values associated with a measurement.
   *
   * This returns a promise that resolves to an object. The keys of the object
   * are:
   *
   *   days -- DailyValues where the values are Maps of field name to data
   *     structures. The data structures could be simple (string or number) or
   *     Arrays if the field type allows multiple values per day.
   *
   *   singular -- Map of field names to values. This holds all fields that
   *     don't have a temporal component.
   *
   * @param id
   *        (Number) Primary key of measurement whose values to retrieve.
   */
  getMeasurementValues: function (id) {
    let deferred = Promise.defer();
    let days = new DailyValues();
    let singular = new Map();

    let self = this;
    this.enqueueOperation(function enqueuedGetMeasurementValues() {
      return Task.spawn(function fetchMeasurementValues() {
        function handleResult(data) {
          for (let [field, values] of data) {
            for (let [day, value] of Iterator(values)) {
              if (!days.hasDay(day)) {
                days.setDay(day, new Map());
              }

              days.getDay(day).set(field, value);
            }
          }
        }

        if (self.measurementHasAnyDailyCounterFields(id)) {
          let counters = yield self.getMeasurementDailyCountersFromMeasurementID(id);
          handleResult(counters);
        }

        if (self.measurementHasAnyDailyLastFields(id)) {
          let dailyLast = yield self.getMeasurementDailyLastValuesFromMeasurementID(id);
          handleResult(dailyLast);
        }

        if (self.measurementHasAnyDailyDiscreteFields(id)) {
          let dailyDiscrete = yield self.getMeasurementDailyDiscreteValuesFromMeasurementID(id);
          handleResult(dailyDiscrete);
        }

        if (self.measurementHasAnyLastFields(id)) {
          let last = yield self.getMeasurementLastValuesFromMeasurementID(id);

          for (let [field, value] of last) {
            singular.set(field, value);
          }
        }

      });
    }).then(function onSuccess() {
      deferred.resolve({singular: singular, days: days});
    }, function onError(error) {
      deferred.reject(error);
    });

    return deferred.promise;
  },

  //---------------------------------------------------------------------------
  // Low-level storage operations
  //
  // These will be performed immediately (or at least as soon as the underlying
  // connection allows them to be.) It is recommended to call these from within
  // a function added via `enqueueOperation()` or they may inadvertently be
  // performed during another enqueued operation, which may be a transaction
  // that is rolled back.
  // ---------------------------------------------------------------------------

  /**
   * Set state for a provider.
   *
   * Providers have the ability to register persistent state with the backend.
   * Persistent state doesn't expire. The format of the data is completely up
   * to the provider beyond the requirement that values be UTF-8 strings.
   *
   * This returns a promise that will be resolved when the underlying database
   * operation has completed.
   *
   * @param provider
   *        (string) Name of the provider.
   * @param key
   *        (string) Key under which to store this state.
   * @param value
   *        (string) Value for this state.
   * @return Promise<>
   */
  setProviderState: function (provider, key, value) {
    if (typeof(key) != "string") {
      throw new Error("State key must be a string. Got: " + key);
    }

    if (typeof(value) != "string") {
      throw new Error("State value must be a string. Got: " + value);
    }

    let id = this.providerID(provider);
    if (!id) {
      throw new Error("Unknown provider: " + provider);
    }

    return this._connection.executeCached(SQL.setProviderState, {
      provider_id: id,
      name: key,
      value: value,
    });
  },

  /**
   * Obtain named state for a provider.
   *
   *
   * The returned promise will resolve to the state from the database or null
   * if the key is not stored.
   *
   * @param provider
   *        (string) The name of the provider whose state to obtain.
   * @param key
   *        (string) The state's key to retrieve.
   *
   * @return Promise<data>
   */
  getProviderState: function (provider, key) {
    let id = this.providerID(provider);
    if (!id) {
      throw new Error("Unknown provider: " + provider);
    }

    let conn = this._connection;
    return Task.spawn(function queryDB() {
      let rows = yield conn.executeCached(SQL.getProviderStateWithName, {
        provider_id: id,
        name: key,
      });

      if (!rows.length) {
        throw new Task.Result(null);
      }

      throw new Task.Result(rows[0].getResultByIndex(0));
    });
  },

  /**
   * Increment a daily counter from a numeric field id.
   *
   * @param id
   *        (integer) Primary key of field to increment.
   * @param date
   *        (Date) When the increment occurred. This is typically "now" but can
   *        be explicitly defined for events that occurred in the past.
   * @param by
   *        (integer) How much to increment the value by. Defaults to 1.
   */
  incrementDailyCounterFromFieldID: function (id, date=new Date(), by=1) {
    this._ensureFieldType(id, this.FIELD_DAILY_COUNTER);

    let params = {
      field_id: id,
      days: dateToDays(date),
      by: by,
    };

    return this._connection.executeCached(SQL.incrementDailyCounterFromFieldID,
                                          params);
  },

  /**
   * Obtain all counts for a specific daily counter.
   *
   * @param id
   *        (integer) The ID of the field being retrieved.
   */
  getDailyCounterCountsFromFieldID: function (id) {
    this._ensureFieldType(id, this.FIELD_DAILY_COUNTER);

    let self = this;
    return Task.spawn(function fetchCounterDays() {
      let rows = yield self._connection.executeCached(SQL.getDailyCounterCountsFromFieldID,
                                                      {field_id: id});

      let result = new DailyValues();
      for (let row of rows) {
        let days = row.getResultByIndex(0);
        let counter = row.getResultByIndex(1);

        let date = daysToDate(days);
        result.setDay(date, counter);
      }

      throw new Task.Result(result);
    });
  },

  /**
   * Get the value of a daily counter for a given day.
   *
   * @param field
   *        (integer) Field ID to retrieve.
   * @param date
   *        (Date) Date for day from which to obtain data.
   */
  getDailyCounterCountFromFieldID: function (field, date) {
    this._ensureFieldType(field, this.FIELD_DAILY_COUNTER);

    let params = {
      field_id: field,
      days: dateToDays(date),
    };

    let self = this;
    return Task.spawn(function fetchCounter() {
      let rows = yield self._connection.executeCached(SQL.getDailyCounterCountFromFieldID,
                                                      params);
      if (!rows.length) {
        throw new Task.Result(null);
      }

      throw new Task.Result(rows[0].getResultByIndex(0));
    });
  },

  /**
   * Define the value for a "last numeric" field.
   *
   * The previous value (if any) will be replaced by the value passed, even if
   * the date of the incoming value is older than what's recorded in the
   * database.
   *
   * @param fieldID
   *        (Number) Integer primary key of field to update.
   * @param value
   *        (Number) Value to record.
   * @param date
   *        (Date) When this value was produced.
   */
  setLastNumericFromFieldID: function (fieldID, value, date=new Date()) {
    this._ensureFieldType(fieldID, this.FIELD_LAST_NUMERIC);

    if (typeof(value) != "number") {
      throw new Error("Value is not a number: " + value);
    }

    let params = {
      field_id: fieldID,
      days: dateToDays(date),
      value: value,
    };

    return this._connection.executeCached(SQL.setLastNumeric, params);
  },

  /**
   * Define the value of a "last text" field.
   *
   * See `setLastNumericFromFieldID` for behavior.
   */
  setLastTextFromFieldID: function (fieldID, value, date=new Date()) {
    this._ensureFieldType(fieldID, this.FIELD_LAST_TEXT);

    if (typeof(value) != "string") {
      throw new Error("Value is not a string: " + value);
    }

    let params = {
      field_id: fieldID,
      days: dateToDays(date),
      value: value,
    };

    return this._connection.executeCached(SQL.setLastText, params);
  },

  /**
   * Obtain the value of a "last numeric" field.
   *
   * This returns a promise that will be resolved with an Array of [date, value]
   * if a value is known or null if no last value is present.
   *
   * @param fieldID
   *        (Number) Integer primary key of field to retrieve.
   */
  getLastNumericFromFieldID: function (fieldID) {
    this._ensureFieldType(fieldID, this.FIELD_LAST_NUMERIC);

    let self = this;
    return Task.spawn(function fetchLastField() {
      let rows = yield self._connection.executeCached(SQL.getLastNumericFromFieldID,
                                                      {field_id: fieldID});

      if (!rows.length) {
        throw new Task.Result(null);
      }

      let row = rows[0];
      let days = row.getResultByIndex(0);
      let value = row.getResultByIndex(1);

      throw new Task.Result([daysToDate(days), value]);
    });
  },

  /**
   * Obtain the value of a "last text" field.
   *
   * See `getLastNumericFromFieldID` for behavior.
   */
  getLastTextFromFieldID: function (fieldID) {
    this._ensureFieldType(fieldID, this.FIELD_LAST_TEXT);

    let self = this;
    return Task.spawn(function fetchLastField() {
      let rows = yield self._connection.executeCached(SQL.getLastTextFromFieldID,
                                                      {field_id: fieldID});

      if (!rows.length) {
        throw new Task.Result(null);
      }

      let row = rows[0];
      let days = row.getResultByIndex(0);
      let value = row.getResultByIndex(1);

      throw new Task.Result([daysToDate(days), value]);
    });
  },

  /**
   * Delete the value (if any) in a "last numeric" field.
   */
  deleteLastNumericFromFieldID: function (fieldID) {
    this._ensureFieldType(fieldID, this.FIELD_LAST_NUMERIC);

    return this._connection.executeCached(SQL.deleteLastNumericFromFieldID,
                                          {field_id: fieldID});
  },

  /**
   * Delete the value (if any) in a "last text" field.
   */
  deleteLastTextFromFieldID: function (fieldID) {
    this._ensureFieldType(fieldID, this.FIELD_LAST_TEXT);

    return this._connection.executeCached(SQL.deleteLastTextFromFieldID,
                                          {field_id: fieldID});
  },

  /**
   * Record a value for a "daily last numeric" field.
   *
   * The field can hold 1 value per calendar day. If the field already has a
   * value for the day specified (defaults to now), that value will be
   * replaced, even if the date specified is older (within the day) than the
   * previously recorded value.
   *
   * @param fieldID
   *        (Number) Integer primary key of field.
   * @param value
   *        (Number) Value to record.
   * @param date
   *        (Date) When the value was produced. Defaults to now.
   */
  setDailyLastNumericFromFieldID: function (fieldID, value, date=new Date()) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_LAST_NUMERIC);

    let params = {
      field_id: fieldID,
      days: dateToDays(date),
      value: value,
    };

    return this._connection.executeCached(SQL.setDailyLastNumeric, params);
  },

  /**
   * Record a value for a "daily last text" field.
   *
   * See `setDailyLastNumericFromFieldID` for behavior.
   */
  setDailyLastTextFromFieldID: function (fieldID, value, date=new Date()) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_LAST_TEXT);

    let params = {
      field_id: fieldID,
      days: dateToDays(date),
      value: value,
    };

    return this._connection.executeCached(SQL.setDailyLastText, params);
  },

  /**
   * Obtain value(s) from a "daily last numeric" field.
   *
   * This returns a promise that resolves to a DailyValues instance. If `date`
   * is specified, that instance will have at most 1 entry. If there is no
   * `date` constraint, then all stored values will be retrieved.
   *
   * @param fieldID
   *        (Number) Integer primary key of field to retrieve.
   * @param date optional
   *        (Date) If specified, only return data for this day.
   *
   * @return Promise<DailyValues>
   */
  getDailyLastNumericFromFieldID: function (fieldID, date=null) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_LAST_NUMERIC);

    let params = {field_id: fieldID};
    let name = "getDailyLastNumericFromFieldID";

    if (date) {
      params.days = dateToDays(date);
      name = "getDailyLastNumericFromFieldIDAndDay";
    }

    return this._getDailyLastFromFieldID(name, params);
  },

  /**
   * Obtain value(s) from a "daily last text" field.
   *
   * See `getDailyLastNumericFromFieldID` for behavior.
   */
  getDailyLastTextFromFieldID: function (fieldID, date=null) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_LAST_TEXT);

    let params = {field_id: fieldID};
    let name = "getDailyLastTextFromFieldID";

    if (date) {
      params.days = dateToDays(date);
      name = "getDailyLastTextFromFieldIDAndDay";
    }

    return this._getDailyLastFromFieldID(name, params);
  },

  _getDailyLastFromFieldID: function (name, params) {
    let self = this;
    return Task.spawn(function fetchDailyLastForField() {
      let rows = yield self._connection.executeCached(SQL[name], params);

      let result = new DailyValues();
      for (let row of rows) {
        let d = daysToDate(row.getResultByIndex(0));
        let value = row.getResultByIndex(1);

        result.setDay(d, value);
      }

      throw new Task.Result(result);
    });
  },

  /**
   * Add a new value for a "daily discrete numeric" field.
   *
   * This appends a new value to the list of values for a specific field. All
   * values are retained. Duplicate values are allowed.
   *
   * @param fieldID
   *        (Number) Integer primary key of field.
   * @param value
   *        (Number) Value to record.
   * @param date optional
   *        (Date) When this value occurred. Values are bucketed by day.
   */
  addDailyDiscreteNumericFromFieldID: function (fieldID, value, date=new Date()) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_DISCRETE_NUMERIC);

    if (typeof(value) != "number") {
      throw new Error("Number expected. Got: " + value);
    }

    let params = {
      field_id: fieldID,
      days: dateToDays(date),
      value: value,
    };

    return this._connection.executeCached(SQL.addDailyDiscreteNumeric, params);
  },

  /**
   * Add a new value for a "daily discrete text" field.
   *
   * See `addDailyDiscreteNumericFromFieldID` for behavior.
   */
  addDailyDiscreteTextFromFieldID: function (fieldID, value, date=new Date()) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_DISCRETE_TEXT);

    if (typeof(value) != "string") {
      throw new Error("String expected. Got: " + value);
    }

    let params = {
      field_id: fieldID,
      days: dateToDays(date),
      value: value,
    };

    return this._connection.executeCached(SQL.addDailyDiscreteText, params);
  },

  /**
   * Obtain values for a "daily discrete numeric" field.
   *
   * This returns a promise that resolves to a `DailyValues` instance. If
   * `date` is specified, there will be at most 1 key in that instance. If
   * not, all data from the database will be retrieved.
   *
   * Values in that instance will be arrays of the raw values.
   *
   * @param fieldID
   *        (Number) Integer primary key of field to retrieve.
   * @param date optional
   *        (Date) Day to obtain data for. Date can be any time in the day.
   */
  getDailyDiscreteNumericFromFieldID: function (fieldID, date=null) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_DISCRETE_NUMERIC);

    let params = {field_id: fieldID};

    let name = "getDailyDiscreteNumericFromFieldID";

    if (date) {
      params.days = dateToDays(date);
      name = "getDailyDiscreteNumericFromFieldIDAndDay";
    }

    return this._getDailyDiscreteFromFieldID(name, params);
  },

  /**
   * Obtain values for a "daily discrete text" field.
   *
   * See `getDailyDiscreteNumericFromFieldID` for behavior.
   */
  getDailyDiscreteTextFromFieldID: function (fieldID, date=null) {
    this._ensureFieldType(fieldID, this.FIELD_DAILY_DISCRETE_TEXT);

    let params = {field_id: fieldID};

    let name = "getDailyDiscreteTextFromFieldID";

    if (date) {
      params.days = dateToDays(date);
      name = "getDailyDiscreteTextFromFieldIDAndDay";
    }

    return this._getDailyDiscreteFromFieldID(name, params);
  },

  _getDailyDiscreteFromFieldID: function (name, params) {
    let self = this;
    return Task.spawn(function fetchDailyDiscreteValuesForField() {
      let rows = yield self._connection.executeCached(SQL[name], params);

      let result = new DailyValues();
      for (let row of rows) {
        let d = daysToDate(row.getResultByIndex(0));
        let value = row.getResultByIndex(1);

        result.appendValue(d, value);
      }

      throw new Task.Result(result);
    });
  },

  /**
   * Obtain the counts of daily counters in a measurement.
   *
   * This returns a promise that resolves to a Map of field name strings to
   * DailyValues that hold per-day counts.
   *
   * @param id
   *        (Number) Integer primary key of measurement.
   *
   * @return Promise<Map>
   */
  getMeasurementDailyCountersFromMeasurementID: function (id) {
    let self = this;
    return Task.spawn(function fetchDailyCounters() {
      let rows = yield self._connection.execute(SQL.getMeasurementDailyCounters,
                                                {measurement_id: id});

      let result = new Map();
      for (let row of rows) {
        let field = row.getResultByName("field_name");
        let date = daysToDate(row.getResultByName("day"));
        let value = row.getResultByName("value");

        if (!result.has(field)) {
          result.set(field, new DailyValues());
        }

        result.get(field).setDay(date, value);
      }

      throw new Task.Result(result);
    });
  },

  /**
   * Obtain the values of "last" fields from a measurement.
   *
   * This returns a promise that resolves to a Map of field name to an array
   * of [date, value].
   *
   * @param id
   *        (Number) Integer primary key of measurement whose data to retrieve.
   *
   * @return Promise<Map>
   */
  getMeasurementLastValuesFromMeasurementID: function (id) {
    let self = this;
    return Task.spawn(function fetchMeasurementLastValues() {
      let rows = yield self._connection.execute(SQL.getMeasurementLastValues,
                                                {measurement_id: id});

      let result = new Map();
      for (let row of rows) {
        let date = daysToDate(row.getResultByIndex(1));
        let value = row.getResultByIndex(2);
        result.set(row.getResultByIndex(0), [date, value]);
      }

      throw new Task.Result(result);
    });
  },

  /**
   * Obtain the values of "last daily" fields from a measurement.
   *
   * This returns a promise that resolves to a Map of field name to DailyValues
   * instances. Each DailyValues instance has days for which a daily last value
   * is defined. The values in each DailyValues are the raw last value for that
   * day.
   *
   * @param id
   *        (Number) Integer primary key of measurement whose data to retrieve.
   *
   * @return Promise<Map>
   */
  getMeasurementDailyLastValuesFromMeasurementID: function (id) {
    let self = this;
    return Task.spawn(function fetchMeasurementDailyLastValues() {
      let rows = yield self._connection.execute(SQL.getMeasurementDailyLastValues,
                                                {measurement_id: id});

      let result = new Map();
      for (let row of rows) {
        let field = row.getResultByName("field_name");
        let date = daysToDate(row.getResultByName("day"));
        let value = row.getResultByName("value");

        if (!result.has(field)) {
          result.set(field, new DailyValues());
        }

        result.get(field).setDay(date, value);
      }

      throw new Task.Result(result);
    });
  },

  /**
   * Obtain the values of "daily discrete" fields from a measurement.
   *
   * This obtains all discrete values for all "daily discrete" fields in a
   * measurement.
   *
   * This returns a promise that resolves to a Map. The Map's keys are field
   * string names. Values are `DailyValues` instances. The values inside
   * the `DailyValues` are arrays of the raw discrete values.
   *
   * @param id
   *        (Number) Integer primary key of measurement.
   *
   * @return Promise<Map>
   */
  getMeasurementDailyDiscreteValuesFromMeasurementID: function (id) {
    let deferred = Promise.defer();
    let result = new Map();

    this._connection.execute(SQL.getMeasurementDailyDiscreteValues,
                             {measurement_id: id}, function onRow(row) {
      let field = row.getResultByName("field_name");
      let date = daysToDate(row.getResultByName("day"));
      let value = row.getResultByName("value");

      if (!result.has(field)) {
        result.set(field, new DailyValues());
      }

      result.get(field).appendValue(date, value);
    }).then(function onComplete() {
      deferred.resolve(result);
    }, function onError(error) {
      deferred.reject(error);
    });

    return deferred.promise;
  },
});

// Alias built-in field types to public API.
for (let property of MetricsStorageSqliteBackend.prototype._BUILTIN_TYPES) {
  this.MetricsStorageBackend[property] = MetricsStorageSqliteBackend.prototype[property];
}

//@line 27 "e:\hg38\comm-esr38\mozilla\services\metrics\Metrics.jsm"
;

this.Metrics = {
  ProviderManager: ProviderManager,
  DailyValues: DailyValues,
  Measurement: Measurement,
  Provider: Provider,
  Storage: MetricsStorageBackend,
  dateToDays: dateToDays,
  daysToDate: daysToDate,
};

//@line 36 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 20 "e:\hg38\comm-esr38\mozilla\services\healthreport\healthreporter.jsm"

Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/TelemetryStopwatch.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "UpdateChannel",
                                  "resource://gre/modules/UpdateChannel.jsm");

// Oldest year to allow in date preferences. This module was implemented in
// 2012 and no dates older than that should be encountered.
const OLDEST_ALLOWED_YEAR = 2012;

const DAYS_IN_PAYLOAD = 180;

const DEFAULT_DATABASE_NAME = "healthreport.sqlite";

const TELEMETRY_INIT = "HEALTHREPORT_INIT_MS";
const TELEMETRY_INIT_FIRSTRUN = "HEALTHREPORT_INIT_FIRSTRUN_MS";
const TELEMETRY_DB_OPEN = "HEALTHREPORT_DB_OPEN_MS";
const TELEMETRY_DB_OPEN_FIRSTRUN = "HEALTHREPORT_DB_OPEN_FIRSTRUN_MS";
const TELEMETRY_GENERATE_PAYLOAD = "HEALTHREPORT_GENERATE_JSON_PAYLOAD_MS";
const TELEMETRY_JSON_PAYLOAD_SERIALIZE = "HEALTHREPORT_JSON_PAYLOAD_SERIALIZE_MS";
const TELEMETRY_PAYLOAD_SIZE_UNCOMPRESSED = "HEALTHREPORT_PAYLOAD_UNCOMPRESSED_BYTES";
const TELEMETRY_PAYLOAD_SIZE_COMPRESSED = "HEALTHREPORT_PAYLOAD_COMPRESSED_BYTES";
const TELEMETRY_UPLOAD = "HEALTHREPORT_UPLOAD_MS";
const TELEMETRY_COLLECT_CONSTANT = "HEALTHREPORT_COLLECT_CONSTANT_DATA_MS";
const TELEMETRY_COLLECT_DAILY = "HEALTHREPORT_COLLECT_DAILY_MS";
const TELEMETRY_SHUTDOWN = "HEALTHREPORT_SHUTDOWN_MS";
const TELEMETRY_COLLECT_CHECKPOINT = "HEALTHREPORT_POST_COLLECT_CHECKPOINT_MS";


/**
 * Helper type to assist with management of Health Reporter state.
 *
 * Instances are not meant to be created outside of a HealthReporter instance.
 *
 * There are two types of IDs associated with clients.
 *
 * Since the beginning of FHR, there has existed a per-upload ID: a UUID is
 * generated at upload time and associated with the state before upload starts.
 * That same upload includes a request to delete all other upload IDs known by
 * the client.
 *
 * Per-upload IDs had the unintended side-effect of creating "orphaned"
 * records/upload IDs on the server. So, a stable client identifer has been
 * introduced. This client identifier is generated when it's missing and sent
 * as part of every upload.
 *
 * There is a high chance we may remove upload IDs in the future.
 */
function HealthReporterState(reporter) {
  this._reporter = reporter;

  let profD = OS.Constants.Path.profileDir;

  if (!profD || !profD.length) {
    throw new Error("Could not obtain profile directory. OS.File not " +
                    "initialized properly?");
  }

  this._log = reporter._log;

  this._stateDir = OS.Path.join(profD, "healthreport");

  // To facilitate testing.
  let leaf = reporter._stateLeaf || "state.json";

  this._filename = OS.Path.join(this._stateDir, leaf);
  this._log.debug("Storing state in " + this._filename);
  this._s = null;
}

HealthReporterState.prototype = Object.freeze({
  /**
   * Persistent string identifier associated with this client.
   */
  get clientID() {
    return this._s.clientID;
  },

  /**
   * The version associated with the client ID.
   */
  get clientIDVersion() {
    return this._s.clientIDVersion;
  },

  get lastPingDate() {
    return new Date(this._s.lastPingTime);
  },

  get lastSubmitID() {
    return this._s.remoteIDs[0];
  },

  get remoteIDs() {
    return this._s.remoteIDs;
  },

  get _lastPayloadPath() {
    return OS.Path.join(this._stateDir, "lastpayload.json");
  },

  init: function () {
    return Task.spawn(function* init() {
      yield OS.File.makeDir(this._stateDir);

      let drs = Cc["@mozilla.org/datareporting/service;1"]
                  .getService(Ci.nsISupports)
                  .wrappedJSObject;
      let drsClientID = yield drs.getClientID();

      let resetObjectState = function () {
        this._s = {
          // The payload version. This is bumped whenever there is a
          // backwards-incompatible change.
          v: 1,
          // The persistent client identifier.
          clientID: drsClientID,
          // Denotes the mechanism used to generate the client identifier.
          // 1: Random UUID.
          clientIDVersion: 1,
          // Upload IDs that might be on the server.
          remoteIDs: [],
          // When we last performed an uploaded.
          lastPingTime: 0,
          // Tracks whether we removed an outdated payload.
          removedOutdatedLastpayload: false,
        };
      }.bind(this);

      try {
        this._s = yield CommonUtils.readJSON(this._filename);
      } catch (ex if ex instanceof OS.File.Error &&
               ex.becauseNoSuchFile) {
        this._log.warn("Saved state file does not exist.");
        resetObjectState();
      } catch (ex) {
        this._log.error("Exception when reading state from disk: " +
                        CommonUtils.exceptionStr(ex));
        resetObjectState();

        // Don't save in case it goes away on next run.
      }

      if (typeof(this._s) != "object") {
        this._log.warn("Read state is not an object. Resetting state.");
        resetObjectState();
        yield this.save();
      }

      if (this._s.v != 1) {
        this._log.warn("Unknown version in state file: " + this._s.v);
        resetObjectState();
        // We explicitly don't save here in the hopes an application re-upgrade
        // comes along and fixes us.
      }

      this._s.clientID = drsClientID;

      // Always look for preferences. This ensures that downgrades followed
      // by reupgrades don't result in excessive data loss.
      for (let promise of this._migratePrefs()) {
        yield promise;
      }
    }.bind(this));
  },

  save: function () {
    this._log.info("Writing state file: " + this._filename);
    return CommonUtils.writeJSON(this._s, this._filename);
  },

  addRemoteID: function (id) {
    this._log.warn("Recording new remote ID: " + id);
    this._s.remoteIDs.push(id);
    return this.save();
  },

  removeRemoteID: function (id) {
    return this.removeRemoteIDs(id ? [id] : []);
  },

  removeRemoteIDs: function (ids) {
    if (!ids || !ids.length) {
      this._log.warn("No IDs passed for removal.");
      return Promise.resolve();
    }

    this._log.warn("Removing documents from remote ID list: " + ids);
    let filtered = this._s.remoteIDs.filter((x) => ids.indexOf(x) === -1);

    if (filtered.length == this._s.remoteIDs.length) {
      return Promise.resolve();
    }

    this._s.remoteIDs = filtered;
    return this.save();
  },

  setLastPingDate: function (date) {
    this._s.lastPingTime = date.getTime();

    return this.save();
  },

  updateLastPingAndRemoveRemoteID: function (date, id) {
    return this.updateLastPingAndRemoveRemoteIDs(date, id ? [id] : []);
  },

  updateLastPingAndRemoveRemoteIDs: function (date, ids) {
    if (!ids) {
      return this.setLastPingDate(date);
    }

    this._log.info("Recording last ping time and deleted remote document.");
    this._s.lastPingTime = date.getTime();
    return this.removeRemoteIDs(ids);
  },

  /**
   * Reset the client ID to something else.
   * Returns a promise that is resolved when completed.
   */
  resetClientID: Task.async(function* () {
    let drs = Cc["@mozilla.org/datareporting/service;1"]
                .getService(Ci.nsISupports)
                .wrappedJSObject;
    yield drs.resetClientID();
    this._s.clientID = yield drs.getClientID();
    this._log.info("Reset client id to " + this._s.clientID + ".");

    yield this.save();
  }),

  _migratePrefs: function () {
    let prefs = this._reporter._prefs;

    let lastID = prefs.get("lastSubmitID", null);
    let lastPingDate = CommonUtils.getDatePref(prefs, "lastPingTime",
                                               0, this._log, OLDEST_ALLOWED_YEAR);

    // If we have state from prefs, migrate and save it to a file then clear
    // out old prefs.
    if (lastID || (lastPingDate && lastPingDate.getTime() > 0)) {
      this._log.warn("Migrating saved state from preferences.");

      if (lastID) {
        this._log.info("Migrating last saved ID: " + lastID);
        this._s.remoteIDs.push(lastID);
      }

      let ourLast = this.lastPingDate;

      if (lastPingDate && lastPingDate.getTime() > ourLast.getTime()) {
        this._log.info("Migrating last ping time: " + lastPingDate);
        this._s.lastPingTime = lastPingDate.getTime();
      }

      yield this.save();
      prefs.reset(["lastSubmitID", "lastPingTime"]);
    } else {
      this._log.debug("No prefs data found.");
    }
  },
});

/**
 * This is the abstract base class of `HealthReporter`. It exists so that
 * we can sanely divide work on platforms where control of Firefox Health
 * Report is outside of Gecko (e.g., Android).
 */
function AbstractHealthReporter(branch, policy, sessionRecorder) {
  if (!branch.endsWith(".")) {
    throw new Error("Branch must end with a period (.): " + branch);
  }

  if (!policy) {
    throw new Error("Must provide policy to HealthReporter constructor.");
  }

  this._log = Log.repository.getLogger("Services.HealthReport.HealthReporter");
  this._log.info("Initializing health reporter instance against " + branch);

  this._branch = branch;
  this._prefs = new Preferences(branch);

  this._policy = policy;
  this.sessionRecorder = sessionRecorder;

  this._dbName = this._prefs.get("dbName") || DEFAULT_DATABASE_NAME;

  this._storage = null;
  this._storageInProgress = false;
  this._providerManager = null;
  this._providerManagerInProgress = false;
  this._initializeStarted = false;
  this._initialized = false;
  this._initializeHadError = false;
  this._initializedDeferred = Promise.defer();
  this._shutdownRequested = false;
  this._shutdownInitiated = false;
  this._shutdownComplete = false;
  this._deferredShutdown = Promise.defer();
  this._promiseShutdown = this._deferredShutdown.promise;

  this._errors = [];

  this._lastDailyDate = null;

  // Yes, this will probably run concurrently with remaining constructor work.
  let hasFirstRun = this._prefs.get("service.firstRun", false);
  this._initHistogram = hasFirstRun ? TELEMETRY_INIT : TELEMETRY_INIT_FIRSTRUN;
  this._dbOpenHistogram = hasFirstRun ? TELEMETRY_DB_OPEN : TELEMETRY_DB_OPEN_FIRSTRUN;

  // This is set to the name for the provider that we are currently initializing,
  // shutting down or collecting data from, if any.
  // This is used for AsyncShutdownTimeout diagnostics.
  this._currentProviderInShutdown = null;
  this._currentProviderInInit = null;
  this._currentProviderInCollect = null;
}

AbstractHealthReporter.prototype = Object.freeze({
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),

  /**
   * Whether the service is fully initialized and running.
   *
   * If this is false, it is not safe to call most functions.
   */
  get initialized() {
    return this._initialized;
  },

  /**
   * Initialize the instance.
   *
   * This must be called once after object construction or the instance is
   * useless.
   */
  init: function () {
    if (this._initializeStarted) {
      throw new Error("We have already started initialization.");
    }

    this._initializeStarted = true;

    return Task.spawn(function*() {
      TelemetryStopwatch.start(this._initHistogram, this);

      try {
        yield this._state.init();

        if (!this._state._s.removedOutdatedLastpayload) {
          yield this._deleteOldLastPayload();
          this._state._s.removedOutdatedLastpayload = true;
          // Normally we should save this to a file but it directly conflicts with
          // the "application re-upgrade" decision in HealthReporterState::init()
          // which specifically does not save the state to a file.
        }
      } catch (ex) {
        this._log.error("Error deleting last payload: " +
                        CommonUtils.exceptionStr(ex));
      }

      // As soon as we have could have storage, we need to register cleanup or
      // else bad things happen on shutdown.
      Services.obs.addObserver(this, "quit-application", false);

      // The database needs to be shut down by the end of shutdown
      // phase profileBeforeChange.
      Metrics.Storage.shutdown.addBlocker("FHR: Flushing storage shutdown",
        () => {
          // Workaround bug 1017706
          // Apparently, in some cases, quit-application is not triggered
          // (or is triggered after profile-before-change), so we need to
          // make sure that `_initiateShutdown()` is triggered at least
          // once.
          this._initiateShutdown();
          return this._promiseShutdown;
        },
        () => ({
            shutdownInitiated: this._shutdownInitiated,
            initialized: this._initialized,
            shutdownRequested: this._shutdownRequested,
            initializeHadError: this._initializeHadError,
            providerManagerInProgress: this._providerManagerInProgress,
            storageInProgress: this._storageInProgress,
            hasProviderManager: !!this._providerManager,
            hasStorage: !!this._storage,
            shutdownComplete: this._shutdownComplete,
            currentProviderInShutdown: this._currentProviderInShutdown,
            currentProviderInInit: this._currentProviderInInit,
            currentProviderInCollect: this._currentProviderInCollect,
          }));

      try {
        this._storageInProgress = true;
        TelemetryStopwatch.start(this._dbOpenHistogram, this);
        let storage = yield Metrics.Storage(this._dbName);
        TelemetryStopwatch.finish(this._dbOpenHistogram, this);
        yield this._onStorageCreated();

        delete this._dbOpenHistogram;
        this._log.info("Storage initialized.");
        this._storage = storage;
        this._storageInProgress = false;

        if (this._shutdownRequested) {
          this._initiateShutdown();
          return null;
        }

        yield this._initializeProviderManager();
        yield this._onProviderManagerInitialized();
        this._initializedDeferred.resolve();
        return this.onInit();
      } catch (ex) {
        yield this._onInitError(ex);
        this._initializedDeferred.reject(ex);
      }
    }.bind(this));
  },

  //----------------------------------------------------
  // SERVICE CONTROL FUNCTIONS
  //
  // You shouldn't need to call any of these externally.
  //----------------------------------------------------

  _onInitError: function (error) {
    TelemetryStopwatch.cancel(this._initHistogram, this);
    TelemetryStopwatch.cancel(this._dbOpenHistogram, this);
    delete this._initHistogram;
    delete this._dbOpenHistogram;

    this._recordError("Error during initialization", error);
    this._initializeHadError = true;
    this._initiateShutdown();
    return Promise.reject(error);

    // FUTURE consider poisoning prototype's functions so calls fail with a
    // useful error message.
  },


  /**
   * Removes the outdated lastpaylaod.json and lastpayload.json.tmp files
   * @see Bug #867902
   * @return a promise for when all the files have been deleted
   */
  _deleteOldLastPayload: function () {
    let paths = [this._state._lastPayloadPath, this._state._lastPayloadPath + ".tmp"];
    return Task.spawn(function removeAllFiles () {
      for (let path of paths) {
        try {
          OS.File.remove(path);
        } catch (ex) {
          if (!ex.becauseNoSuchFile) {
            this._log.error("Exception when removing outdated payload files: " +
                            CommonUtils.exceptionStr(ex));
          }
        }
      }
    }.bind(this));
  },

  _initializeProviderManager: Task.async(function* _initializeProviderManager() {
    if (this._collector) {
      throw new Error("Provider manager has already been initialized.");
    }

    this._log.info("Initializing provider manager.");
    this._providerManager = new Metrics.ProviderManager(this._storage);
    this._providerManager.onProviderError = this._recordError.bind(this);
    this._providerManager.onProviderInit = this._initProvider.bind(this);
    this._providerManagerInProgress = true;

    let catString = this._prefs.get("service.providerCategories") || "";
    if (catString.length) {
      for (let category of catString.split(",")) {
        yield this._providerManager.registerProvidersFromCategoryManager(category,
                     providerName => this._currentProviderInInit = providerName);
      }
      this._currentProviderInInit = null;
    }
  }),

  _onProviderManagerInitialized: function () {
    TelemetryStopwatch.finish(this._initHistogram, this);
    delete this._initHistogram;
    this._log.debug("Provider manager initialized.");
    this._providerManagerInProgress = false;

    if (this._shutdownRequested) {
      this._initiateShutdown();
      return;
    }

    this._log.info("HealthReporter started.");
    this._initialized = true;
    Services.obs.addObserver(this, "idle-daily", false);

    // If upload is not enabled, ensure daily collection works. If upload
    // is enabled, this will be performed as part of upload.
    //
    // This is important because it ensures about:healthreport contains
    // longitudinal data even if upload is disabled. Having about:healthreport
    // provide useful info even if upload is disabled was a core launch
    // requirement.
    //
    // We do not catch changes to the backing pref. So, if the session lasts
    // many days, we may fail to collect. However, most sessions are short and
    // this code will likely be refactored as part of splitting up policy to
    // serve Android. So, meh.
    if (!this._policy.healthReportUploadEnabled) {
      this._log.info("Upload not enabled. Scheduling daily collection.");
      // Since the timer manager is a singleton and there could be multiple
      // HealthReporter instances, we need to encode a unique identifier in
      // the timer ID.
      try {
        let timerName = this._branch.replace(".", "-", "g") + "lastDailyCollection";
        let tm = Cc["@mozilla.org/updates/timer-manager;1"]
                   .getService(Ci.nsIUpdateTimerManager);
        tm.registerTimer(timerName, this.collectMeasurements.bind(this),
                         24 * 60 * 60);
      } catch (ex) {
        this._log.error("Error registering collection timer: " +
                        CommonUtils.exceptionStr(ex));
      }
    }

    // Clean up caches and reduce memory usage.
    this._storage.compact();
  },

  // nsIObserver to handle shutdown.
  observe: function (subject, topic, data) {
    switch (topic) {
      case "quit-application":
        Services.obs.removeObserver(this, "quit-application");
        this._initiateShutdown();
        break;

      case "idle-daily":
        this._performDailyMaintenance();
        break;
    }
  },

  _initiateShutdown: function () {
    // Ensure we only begin the main shutdown sequence once.
    if (this._shutdownInitiated) {
      this._log.warn("Shutdown has already been initiated. No-op.");
      return;
    }

    this._log.info("Request to shut down.");

    this._initialized = false;
    this._shutdownRequested = true;

    if (this._initializeHadError) {
      this._log.warn("Initialization had error. Shutting down immediately.");
    } else {
      if (this._providerManagerInProgress) {
        this._log.warn("Provider manager is in progress of initializing. " +
                       "Waiting to finish.");
        return;
      }

      // If storage is in the process of initializing, we need to wait for it
      // to finish before continuing. The initialization process will call us
      // again once storage has initialized.
      if (this._storageInProgress) {
        this._log.warn("Storage is in progress of initializing. Waiting to finish.");
        return;
      }
    }

    this._log.warn("Initiating main shutdown procedure.");

    // Everything from here must only be performed once or else race conditions
    // could occur.

    TelemetryStopwatch.start(TELEMETRY_SHUTDOWN, this);
    this._shutdownInitiated = true;

    // We may not have registered the observer yet. If not, this will
    // throw.
    try {
      Services.obs.removeObserver(this, "idle-daily");
    } catch (ex) { }

    Task.spawn(function*() {
      try {
        if (this._providerManager) {
          this._log.info("Shutting down provider manager.");
          for (let provider of this._providerManager.providers) {
            try {
              this._log.info("Shutting down provider: " + provider.name);
              this._currentProviderInShutdown = provider.name;
              yield provider.shutdown();
            } catch (ex) {
              this._log.warn("Error when shutting down provider: " +
                             CommonUtils.exceptionStr(ex));
            }
          }
          this._log.info("Provider manager shut down.");
          this._providerManager = null;
          this._currentProviderInShutdown = null;
          this._onProviderManagerShutdown();
        }
        if (this._storage) {
          this._log.info("Shutting down storage.");
          try {
            yield this._storage.close();
            yield this._onStorageClose();
          } catch (error) {
            this._log.warn("Error when closing storage: " +
                           CommonUtils.exceptionStr(error));
          }
          this._storage = null;
        }

        this._log.warn("Shutdown complete.");
        this._shutdownComplete = true;
      } finally {
        this._deferredShutdown.resolve();
        TelemetryStopwatch.finish(TELEMETRY_SHUTDOWN, this);
      }
    }.bind(this));
  },

  onInit: function() {
    return this._initializedDeferred.promise;
  },

  _onStorageCreated: function() {
    // Do nothing.
    // This method provides a hook point for the test suite.
  },

  _onStorageClose: function() {
    // Do nothing.
    // This method provides a hook point for the test suite.
  },

  _onProviderManagerShutdown: function() {
    // Do nothing.
    // This method provides a hook point for the test suite.
  },

  /**
   * Convenience method to shut down the instance.
   *
   * This should *not* be called outside of tests.
   */
  _shutdown: function () {
    this._initiateShutdown();
    return this._promiseShutdown;
  },

  _performDailyMaintenance: function () {
    this._log.info("Request to perform daily maintenance.");

    if (!this._initialized) {
      return;
    }

    let now = new Date();
    let cutoff = new Date(now.getTime() - MILLISECONDS_PER_DAY * (DAYS_IN_PAYLOAD - 1));

    // The operation is enqueued and put in a transaction by the storage module.
    this._storage.pruneDataBefore(cutoff);
  },

  //--------------------
  // Provider Management
  //--------------------

  /**
   * Obtain a provider from its name.
   *
   * This will only return providers that are currently initialized. If
   * a provider is lazy initialized (like pull-only providers) this
   * will likely not return anything.
   */
  getProvider: function (name) {
    if (!this._providerManager) {
      return null;
    }

    return this._providerManager.getProvider(name);
  },

  _initProvider: function (provider) {
    provider.healthReporter = this;
  },

  /**
   * Record an exception for reporting in the payload.
   *
   * A side effect is the exception is logged.
   *
   * Note that callers need to be extra sensitive about ensuring personal
   * or otherwise private details do not leak into this. All of the user data
   * on the stack in FHR code should be limited to data we were collecting with
   * the intent to submit. So, it is covered under the user's consent to use
   * the feature.
   *
   * @param message
   *        (string) Human readable message describing error.
   * @param ex
   *        (Error) The error that should be captured.
   */
  _recordError: function (message, ex) {
    let recordMessage = message;
    let logMessage = message;

    if (ex) {
      recordMessage += ": " + CommonUtils.exceptionStr(ex);
      logMessage += ": " + CommonUtils.exceptionStr(ex);
    }

    // Scrub out potentially identifying information from strings that could
    // make the payload.
    let appData = Services.dirsvc.get("UAppData", Ci.nsIFile);
    let profile = Services.dirsvc.get("ProfD", Ci.nsIFile);

    let appDataURI = Services.io.newFileURI(appData);
    let profileURI = Services.io.newFileURI(profile);

    // Order of operation is important here. We do the URI before the path version
    // because the path may be a subset of the URI. We also have to check for the case
    // where UAppData is underneath the profile directory (or vice-versa) so we
    // don't substitute incomplete strings.

    function replace(uri, path, thing) {
      // Try is because .spec can throw on invalid URI.
      try {
        recordMessage = recordMessage.replace(uri.spec, '<' + thing + 'URI>', 'g');
      } catch (ex) { }

      recordMessage = recordMessage.replace(path, '<' + thing + 'Path>', 'g');
    }

    if (appData.path.contains(profile.path)) {
      replace(appDataURI, appData.path, 'AppData');
      replace(profileURI, profile.path, 'Profile');
    } else {
      replace(profileURI, profile.path, 'Profile');
      replace(appDataURI, appData.path, 'AppData');
    }

    this._log.warn(logMessage);
    this._errors.push(recordMessage);
  },

  /**
   * Collect all measurements for all registered providers.
   */
  collectMeasurements: function () {
    if (!this._initialized) {
      return Promise.reject(new Error("Not initialized."));
    }

    return Task.spawn(function doCollection() {
      yield this._providerManager.ensurePullOnlyProvidersRegistered();

      try {
        TelemetryStopwatch.start(TELEMETRY_COLLECT_CONSTANT, this);
        yield this._providerManager.collectConstantData(name => this._currentProviderInCollect = name);
        this._currentProviderInCollect = null;
        TelemetryStopwatch.finish(TELEMETRY_COLLECT_CONSTANT, this);
      } catch (ex) {
        TelemetryStopwatch.cancel(TELEMETRY_COLLECT_CONSTANT, this);
        this._log.warn("Error collecting constant data: " +
                       CommonUtils.exceptionStr(ex));
      }

      // Daily data is collected if it hasn't yet been collected this
      // application session or if it has been more than a day since the
      // last collection. This means that providers could see many calls to
      // collectDailyData per calendar day. However, this collection API
      // makes no guarantees about limits. The alternative would involve
      // recording state. The simpler implementation prevails for now.
      if (!this._lastDailyDate ||
          Date.now() - this._lastDailyDate > MILLISECONDS_PER_DAY) {

        try {
          TelemetryStopwatch.start(TELEMETRY_COLLECT_DAILY, this);
          this._lastDailyDate = new Date();
          yield this._providerManager.collectDailyData(name => this._currentProviderInCollect = name);
          this._currentProviderInCollect = null;
          TelemetryStopwatch.finish(TELEMETRY_COLLECT_DAILY, this);
        } catch (ex) {
          TelemetryStopwatch.cancel(TELEMETRY_COLLECT_DAILY, this);
          this._log.warn("Error collecting daily data from providers: " +
                         CommonUtils.exceptionStr(ex));
        }
      }

      yield this._providerManager.ensurePullOnlyProvidersUnregistered();

      // Flush gathered data to disk. This will incur an fsync. But, if
      // there is ever a time we want to persist data to disk, it's
      // after a massive collection.
      try {
        TelemetryStopwatch.start(TELEMETRY_COLLECT_CHECKPOINT, this);
        yield this._storage.checkpoint();
        TelemetryStopwatch.finish(TELEMETRY_COLLECT_CHECKPOINT, this);
      } catch (ex) {
        TelemetryStopwatch.cancel(TELEMETRY_COLLECT_CHECKPOINT, this);
        throw ex;
      }

      throw new Task.Result();
    }.bind(this));
  },

  /**
   * Helper function to perform data collection and obtain the JSON payload.
   *
   * If you are looking for an up-to-date snapshot of FHR data that pulls in
   * new data since the last upload, this is how you should obtain it.
   *
   * @param asObject
   *        (bool) Whether to resolve an object or JSON-encoded string of that
   *        object (the default).
   *
   * @return Promise<Object | string>
   */
  collectAndObtainJSONPayload: function (asObject=false) {
    if (!this._initialized) {
      return Promise.reject(new Error("Not initialized."));
    }

    return Task.spawn(function collectAndObtain() {
      yield this._storage.setAutoCheckpoint(0);
      yield this._providerManager.ensurePullOnlyProvidersRegistered();

      let payload;
      let error;

      try {
        yield this.collectMeasurements();
        payload = yield this.getJSONPayload(asObject);
      } catch (ex) {
        error = ex;
        this._collectException("Error collecting and/or retrieving JSON payload",
                               ex);
      } finally {
        yield this._providerManager.ensurePullOnlyProvidersUnregistered();
        yield this._storage.setAutoCheckpoint(1);

        if (error) {
          throw error;
        }
      }

      // We hold off throwing to ensure that behavior between finally
      // and generators and throwing is sane.
      throw new Task.Result(payload);
    }.bind(this));
  },


  /**
   * Obtain the JSON payload for currently-collected data.
   *
   * The payload only contains data that has been recorded to FHR. Some
   * providers may have newer data available. If you want to ensure you
   * have all available data, call `collectAndObtainJSONPayload`
   * instead.
   *
   * @param asObject
   *        (bool) Whether to return an object or JSON encoding of that
   *        object (the default).
   *
   * @return Promise<string|object>
   */
  getJSONPayload: function (asObject=false) {
    TelemetryStopwatch.start(TELEMETRY_GENERATE_PAYLOAD, this);
    let deferred = Promise.defer();

    Task.spawn(this._getJSONPayload.bind(this, this._now(), asObject)).then(
      function onResult(result) {
        TelemetryStopwatch.finish(TELEMETRY_GENERATE_PAYLOAD, this);
        deferred.resolve(result);
      }.bind(this),
      function onError(error) {
        TelemetryStopwatch.cancel(TELEMETRY_GENERATE_PAYLOAD, this);
        deferred.reject(error);
      }.bind(this)
    );

    return deferred.promise;
  },

  _getJSONPayload: function (now, asObject=false) {
    let pingDateString = this._formatDate(now);
    this._log.info("Producing JSON payload for " + pingDateString);

    // May not be present if we are generating as a result of init error.
    if (this._providerManager) {
      yield this._providerManager.ensurePullOnlyProvidersRegistered();
    }

    let o = {
      version: 2,
      clientID: this._state.clientID,
      clientIDVersion: this._state.clientIDVersion,
      thisPingDate: pingDateString,
      geckoAppInfo: this.obtainAppInfo(this._log),
      data: {last: {}, days: {}},
    };

    let outputDataDays = o.data.days;

    // Guard here in case we don't track this (e.g., on Android).
    let lastPingDate = this.lastPingDate;
    if (lastPingDate && lastPingDate.getTime() > 0) {
      o.lastPingDate = this._formatDate(lastPingDate);
    }

    // We can still generate a payload even if we're not initialized.
    // This is to facilitate error upload on init failure.
    if (this._initialized) {
      for (let provider of this._providerManager.providers) {
        let providerName = provider.name;

        let providerEntry = {
          measurements: {},
        };

        // Measurement name to recorded version.
        let lastVersions = {};
        // Day string to mapping of measurement name to recorded version.
        let dayVersions = {};

        for (let [measurementKey, measurement] of provider.measurements) {
          let name = providerName + "." + measurement.name;
          let version = measurement.version;

          let serializer;
          try {
            // The measurement is responsible for returning a serializer which
            // is aware of the measurement version.
            serializer = measurement.serializer(measurement.SERIALIZE_JSON);
          } catch (ex) {
            this._recordError("Error obtaining serializer for measurement: " +
                              name, ex);
            continue;
          }

          let data;
          try {
            data = yield measurement.getValues();
          } catch (ex) {
            this._recordError("Error obtaining data for measurement: " + name,
                              ex);
            continue;
          }

          if (data.singular.size) {
            try {
              let serialized = serializer.singular(data.singular);
              if (serialized) {
                // Only replace the existing data if there is no data or if our
                // version is newer than the old one.
                if (!(name in o.data.last) || version > lastVersions[name]) {
                  o.data.last[name] = serialized;
                  lastVersions[name] = version;
                }
              }
            } catch (ex) {
              this._recordError("Error serializing singular data: " + name,
                                ex);
              continue;
            }
          }

          let dataDays = data.days;
          for (let i = 0; i < DAYS_IN_PAYLOAD; i++) {
            let date = new Date(now.getTime() - i * MILLISECONDS_PER_DAY);
            if (!dataDays.hasDay(date)) {
              continue;
            }
            let dateFormatted = this._formatDate(date);

            try {
              let serialized = serializer.daily(dataDays.getDay(date));
              if (!serialized) {
                continue;
              }

              if (!(dateFormatted in outputDataDays)) {
                outputDataDays[dateFormatted] = {};
              }

              // This needs to be separate because dayVersions is provider
              // specific and gets blown away in a loop while outputDataDays
              // is persistent.
              if (!(dateFormatted in dayVersions)) {
                dayVersions[dateFormatted] = {};
              }

              if (!(name in outputDataDays[dateFormatted]) ||
                  version > dayVersions[dateFormatted][name]) {
                outputDataDays[dateFormatted][name] = serialized;
                dayVersions[dateFormatted][name] = version;
              }
            } catch (ex) {
              this._recordError("Error populating data for day: " + name, ex);
              continue;
            }
          }
        }
      }
    } else {
      o.notInitialized = 1;
      this._log.warn("Not initialized. Sending report with only error info.");
    }

    if (this._errors.length) {
      o.errors = this._errors.slice(0, 20);
    }

    if (this._initialized) {
      this._storage.compact();
    }

    if (!asObject) {
      TelemetryStopwatch.start(TELEMETRY_JSON_PAYLOAD_SERIALIZE, this);
      o = JSON.stringify(o);
      TelemetryStopwatch.finish(TELEMETRY_JSON_PAYLOAD_SERIALIZE, this);
    }

    if (this._providerManager) {
      yield this._providerManager.ensurePullOnlyProvidersUnregistered();
    }

    throw new Task.Result(o);
  },

  _now: function _now() {
    return new Date();
  },

  // These are stolen from AppInfoProvider.
  appInfoVersion: 1,
  appInfoFields: {
    // From nsIXULAppInfo.
    vendor: "vendor",
    name: "name",
    id: "ID",
    version: "version",
    appBuildID: "appBuildID",
    platformVersion: "platformVersion",
    platformBuildID: "platformBuildID",

    // From nsIXULRuntime.
    os: "OS",
    xpcomabi: "XPCOMABI",
  },

  /**
   * Statically return a bundle of app info data, a subset of that produced by
   * AppInfoProvider._populateConstants. This allows us to more usefully handle
   * payloads that, due to error, contain no data.
   *
   * Returns a very sparse object if Services.appinfo is unavailable.
   */
  obtainAppInfo: function () {
    let out = {"_v": this.appInfoVersion};
    try {
      let ai = Services.appinfo;
      for (let [k, v] in Iterator(this.appInfoFields)) {
        out[k] = ai[v];
      }
    } catch (ex) {
      this._log.warn("Could not obtain Services.appinfo: " +
                     CommonUtils.exceptionStr(ex));
    }

    try {
      out["updateChannel"] = UpdateChannel.get();
    } catch (ex) {
      this._log.warn("Could not obtain update channel: " +
                     CommonUtils.exceptionStr(ex));
    }

    return out;
  },
});

/**
 * HealthReporter and its abstract superclass coordinate collection and
 * submission of health report metrics.
 *
 * This is the main type for Firefox Health Report on desktop. It glues all the
 * lower-level components (such as collection and submission) together.
 *
 * An instance of this type is created as an XPCOM service. See
 * DataReportingService.js and
 * DataReporting.manifest/HealthReportComponents.manifest.
 *
 * It is theoretically possible to have multiple instances of this running
 * in the application. For example, this type may one day handle submission
 * of telemetry data as well. However, there is some moderate coupling between
 * this type and *the* Firefox Health Report (e.g., the policy). This could
 * be abstracted if needed.
 *
 * Note that `AbstractHealthReporter` exists to allow for Firefox Health Report
 * to be more easily implemented on platforms where a separate controlling
 * layer is responsible for payload upload and deletion.
 *
 * IMPLEMENTATION NOTES
 * ====================
 *
 * These notes apply to the combination of `HealthReporter` and
 * `AbstractHealthReporter`.
 *
 * Initialization and shutdown are somewhat complicated and worth explaining
 * in extra detail.
 *
 * The complexity is driven by the requirements of SQLite connection management.
 * Once you have a SQLite connection, it isn't enough to just let the
 * application shut down. If there is an open connection or if there are
 * outstanding SQL statements come XPCOM shutdown time, Storage will assert.
 * On debug builds you will crash. On release builds you will get a shutdown
 * hang. This must be avoided!
 *
 * During initialization, the second we create a SQLite connection (via
 * Metrics.Storage) we register observers for application shutdown. The
 * "quit-application" notification initiates our shutdown procedure. The
 * subsequent "profile-do-change" notification ensures it has completed.
 *
 * The handler for "profile-do-change" may result in event loop spinning. This
 * is because of race conditions between our shutdown code and application
 * shutdown.
 *
 * All of our shutdown routines are async. There is the potential that these
 * async functions will not complete before XPCOM shutdown. If they don't
 * finish in time, we could get assertions in Storage. Our solution is to
 * initiate storage early in the shutdown cycle ("quit-application").
 * Hopefully all the async operations have completed by the time we reach
 * "profile-do-change." If so, great. If not, we spin the event loop until
 * they have completed, avoiding potential race conditions.
 *
 * @param branch
 *        (string) The preferences branch to use for state storage. The value
 *        must end with a period (.).
 *
 * @param policy
 *        (HealthReportPolicy) Policy driving execution of HealthReporter.
 */
this.HealthReporter = function (branch, policy, sessionRecorder, stateLeaf=null) {
  this._stateLeaf = stateLeaf;
  this._uploadInProgress = false;

  AbstractHealthReporter.call(this, branch, policy, sessionRecorder);

  if (!this.serverURI) {
    throw new Error("No server URI defined. Did you forget to define the pref?");
  }

  if (!this.serverNamespace) {
    throw new Error("No server namespace defined. Did you forget a pref?");
  }

  this._state = new HealthReporterState(this);
}

this.HealthReporter.prototype = Object.freeze({
  __proto__: AbstractHealthReporter.prototype,

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),

  get lastSubmitID() {
    return this._state.lastSubmitID;
  },

  /**
   * When we last successfully submitted data to the server.
   *
   * This is sent as part of the upload. This is redundant with similar data
   * in the policy because we like the modules to be loosely coupled and the
   * similar data in the policy is only used for forensic purposes.
   */
  get lastPingDate() {
    return this._state.lastPingDate;
  },

  /**
   * The base URI of the document server to which to submit data.
   *
   * This is typically a Bagheera server instance. It is the URI up to but not
   * including the version prefix. e.g. https://data.metrics.mozilla.com/
   */
  get serverURI() {
    return this._prefs.get("documentServerURI", null);
  },

  set serverURI(value) {
    if (!value) {
      throw new Error("serverURI must have a value.");
    }

    if (typeof(value) != "string") {
      throw new Error("serverURI must be a string: " + value);
    }

    this._prefs.set("documentServerURI", value);
  },

  /**
   * The namespace on the document server to which we will be submitting data.
   */
  get serverNamespace() {
    return this._prefs.get("documentServerNamespace", "metrics");
  },

  set serverNamespace(value) {
    if (!value) {
      throw new Error("serverNamespace must have a value.");
    }

    if (typeof(value) != "string") {
      throw new Error("serverNamespace must be a string: " + value);
    }

    this._prefs.set("documentServerNamespace", value);
  },

  /**
   * Whether this instance will upload data to a server.
   */
  get willUploadData() {
    return  this._policy.userNotifiedOfCurrentPolicy &&
            this._policy.healthReportUploadEnabled;
  },

  /**
   * Whether remote data is currently stored.
   *
   * @return bool
   */
  haveRemoteData: function () {
    return !!this._state.lastSubmitID;
  },

  /**
   * Called to initiate a data upload.
   *
   * The passed argument is a `DataSubmissionRequest` from policy.jsm.
   */
  requestDataUpload: function (request) {
    if (!this._initialized) {
      return Promise.reject(new Error("Not initialized."));
    }

    return Task.spawn(function doUpload() {
      yield this._providerManager.ensurePullOnlyProvidersRegistered();
      try {
        yield this.collectMeasurements();
        try {
          yield this._uploadData(request);
        } catch (ex) {
          this._onSubmitDataRequestFailure(ex);
        }
      } finally {
        yield this._providerManager.ensurePullOnlyProvidersUnregistered();
      }
    }.bind(this));
  },

  /**
   * Request that server data be deleted.
   *
   * If deletion is scheduled to occur immediately, a promise will be returned
   * that will be fulfilled when the deletion attempt finishes. Otherwise,
   * callers should poll haveRemoteData() to determine when remote data is
   * deleted.
   */
  requestDeleteRemoteData: function (reason) {
    if (!this.haveRemoteData()) {
      return;
    }

    return this._policy.deleteRemoteData(reason);
  },

  /**
   * Override default handler to incur an upload describing the error.
   */
  _onInitError: function (error) {
    // Need to capture this before we call the parent else it's always
    // set.
    let inShutdown = this._shutdownRequested;
    let result;

    try {
      result = AbstractHealthReporter.prototype._onInitError.call(this, error);
    } catch (ex) {
      this._log.error("Error when calling _onInitError: " +
                      CommonUtils.exceptionStr(ex));
    }

    // This bypasses a lot of the checks in policy, such as respect for
    // backoff. We should arguably not do this. However, reporting
    // startup errors is important. And, they should not occur with much
    // frequency in the wild. So, it shouldn't be too big of a deal.
    if (!inShutdown &&
        this._policy.healthReportUploadEnabled &&
        this._policy.ensureUserNotified()) {
      // We don't care about what happens to this request. It's best
      // effort.
      let request = {
        onNoDataAvailable: function () {},
        onSubmissionSuccess: function () {},
        onSubmissionFailureSoft: function () {},
        onSubmissionFailureHard: function () {},
        onUploadInProgress: function () {},
      };

      this._uploadData(request);
    }

    return result;
  },

  _onBagheeraResult: function (request, isDelete, date, result) {
    this._log.debug("Received Bagheera result.");

    return Task.spawn(function onBagheeraResult() {
      let hrProvider = this.getProvider("org.mozilla.healthreport");

      if (!result.transportSuccess) {
        // The built-in provider may not be initialized if this instance failed
        // to initialize fully.
        if (hrProvider && !isDelete) {
          try {
            hrProvider.recordEvent("uploadTransportFailure", date);
          } catch (ex) {
            this._log.error("Error recording upload transport failure: " +
                            CommonUtils.exceptionStr(ex));
          }
        }

        request.onSubmissionFailureSoft("Network transport error.");
        throw new Task.Result(false);
      }

      if (!result.serverSuccess) {
        if (hrProvider && !isDelete) {
          try {
            hrProvider.recordEvent("uploadServerFailure", date);
          } catch (ex) {
            this._log.error("Error recording server failure: " +
                            CommonUtils.exceptionStr(ex));
          }
        }

        request.onSubmissionFailureHard("Server failure.");
        throw new Task.Result(false);
      }

      if (hrProvider && !isDelete) {
        try {
          hrProvider.recordEvent("uploadSuccess", date);
        } catch (ex) {
          this._log.error("Error recording upload success: " +
                          CommonUtils.exceptionStr(ex));
        }
      }

      if (isDelete) {
        this._log.warn("Marking delete as successful.");
        yield this._state.removeRemoteIDs([result.id]);
      } else {
        this._log.warn("Marking upload as successful.");
        yield this._state.updateLastPingAndRemoveRemoteIDs(date, result.deleteIDs);
      }

      request.onSubmissionSuccess(this._now());

      throw new Task.Result(true);
    }.bind(this));
  },

  _onSubmitDataRequestFailure: function (error) {
    this._log.error("Error processing request to submit data: " +
                    CommonUtils.exceptionStr(error));
  },

  _formatDate: function (date) {
    // Why, oh, why doesn't JS have a strftime() equivalent?
    return date.toISOString().substr(0, 10);
  },

  _uploadData: function (request) {
    // Under ideal circumstances, clients should never race to this
    // function. However, server logs have observed behavior where
    // racing to this function could be a cause. So, this lock was
    // instituted.
    if (this._uploadInProgress) {
      this._log.warn("Upload requested but upload already in progress.");
      let provider = this.getProvider("org.mozilla.healthreport");
      let promise = provider.recordEvent("uploadAlreadyInProgress");
      request.onUploadInProgress("Upload already in progress.");
      return promise;
    }

    let id = CommonUtils.generateUUID();

    this._log.info("Uploading data to server: " + this.serverURI + " " +
                   this.serverNamespace + ":" + id);
    let client = new BagheeraClient(this.serverURI);
    let now = this._now();

    return Task.spawn(function doUpload() {
      try {
        // The test for upload locking monkeypatches getJSONPayload.
        // If the next two lines change, be sure to verify the test is
        // accurate!
        this._uploadInProgress = true;
        let payload = yield this.getJSONPayload();

        let histogram = Services.telemetry.getHistogramById(TELEMETRY_PAYLOAD_SIZE_UNCOMPRESSED);
        histogram.add(payload.length);

        let lastID = this.lastSubmitID;
        yield this._state.addRemoteID(id);

        let hrProvider = this.getProvider("org.mozilla.healthreport");
        if (hrProvider) {
          let event = lastID ? "continuationUploadAttempt"
                             : "firstDocumentUploadAttempt";
          try {
            hrProvider.recordEvent(event, now);
          } catch (ex) {
            this._log.error("Error when recording upload attempt: " +
                            CommonUtils.exceptionStr(ex));
          }
        }

        TelemetryStopwatch.start(TELEMETRY_UPLOAD, this);
        let result;
        try {
          let options = {
            deleteIDs: this._state.remoteIDs.filter((x) => { return x != id; }),
            telemetryCompressed: TELEMETRY_PAYLOAD_SIZE_COMPRESSED,
          };
          result = yield client.uploadJSON(this.serverNamespace, id, payload,
                                           options);
          TelemetryStopwatch.finish(TELEMETRY_UPLOAD, this);
        } catch (ex) {
          TelemetryStopwatch.cancel(TELEMETRY_UPLOAD, this);
          if (hrProvider) {
            try {
              hrProvider.recordEvent("uploadClientFailure", now);
            } catch (ex) {
              this._log.error("Error when recording client failure: " +
                              CommonUtils.exceptionStr(ex));
            }
          }
          throw ex;
        }

        yield this._onBagheeraResult(request, false, now, result);
      } finally {
        this._uploadInProgress = false;
      }
    }.bind(this));
  },

  /**
   * Request deletion of remote data.
   *
   * @param request
   *        (DataSubmissionRequest) Tracks progress of this request.
   */
  deleteRemoteData: function (request) {
    if (!this._state.lastSubmitID) {
      this._log.info("Received request to delete remote data but no data stored.");
      request.onNoDataAvailable();
      return;
    }

    this._log.warn("Deleting remote data.");
    let client = new BagheeraClient(this.serverURI);

    return Task.spawn(function* doDelete() {
      try {
        let result = yield client.deleteDocument(this.serverNamespace,
                                                 this.lastSubmitID);
        yield this._onBagheeraResult(request, true, this._now(), result);
      } catch (ex) {
        this._log.error("Error processing request to delete data: " +
                        CommonUtils.exceptionStr(error));
      } finally {
        // If we don't have any remote documents left, nuke the ID.
        // This is done for privacy reasons. Why preserve the ID if we
        // don't need to?
        if (!this.haveRemoteData()) {
          yield this._state.resetClientID();
        }
      }
    }.bind(this));
  },
});

//@line 38 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

//@line 40 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"
;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file contains metrics data providers for the Firefox Health
 * Report. Ideally each provider in this file exists in separate modules
 * and lives close to the code it is querying. However, because of the
 * overhead of JS compartments (which are created for each module), we
 * currently have all the code in one file. When the overhead of
 * compartments reaches a reasonable level, this file should be split
 * up.
 */

//@line 38 "e:\hg38\comm-esr38\mozilla\services\healthreport\providers.jsm"

Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-common/utils.js");

XPCOMUtils.defineLazyModuleGetter(this, "AddonManager",
                                  "resource://gre/modules/AddonManager.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "UpdateChannel",
                                  "resource://gre/modules/UpdateChannel.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesDBUtils",
                                  "resource://gre/modules/PlacesDBUtils.jsm");


const LAST_NUMERIC_FIELD = {type: Metrics.Storage.FIELD_LAST_NUMERIC};
const LAST_TEXT_FIELD = {type: Metrics.Storage.FIELD_LAST_TEXT};
const DAILY_DISCRETE_NUMERIC_FIELD = {type: Metrics.Storage.FIELD_DAILY_DISCRETE_NUMERIC};
const DAILY_LAST_NUMERIC_FIELD = {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC};
const DAILY_LAST_TEXT_FIELD = {type: Metrics.Storage.FIELD_DAILY_LAST_TEXT};
const DAILY_COUNTER_FIELD = {type: Metrics.Storage.FIELD_DAILY_COUNTER};

const TELEMETRY_PREF = "toolkit.telemetry.enabled";

function isTelemetryEnabled(prefs) {
  return prefs.get(TELEMETRY_PREF, false);
}

/**
 * Represents basic application state.
 *
 * This is roughly a union of nsIXULAppInfo, nsIXULRuntime, with a few extra
 * pieces thrown in.
 */
function AppInfoMeasurement() {
  Metrics.Measurement.call(this);
}

AppInfoMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "appinfo",
  version: 2,

  fields: {
    vendor: LAST_TEXT_FIELD,
    name: LAST_TEXT_FIELD,
    id: LAST_TEXT_FIELD,
    version: LAST_TEXT_FIELD,
    appBuildID: LAST_TEXT_FIELD,
    platformVersion: LAST_TEXT_FIELD,
    platformBuildID: LAST_TEXT_FIELD,
    os: LAST_TEXT_FIELD,
    xpcomabi: LAST_TEXT_FIELD,
    updateChannel: LAST_TEXT_FIELD,
    distributionID: LAST_TEXT_FIELD,
    distributionVersion: LAST_TEXT_FIELD,
    hotfixVersion: LAST_TEXT_FIELD,
    locale: LAST_TEXT_FIELD,
    isDefaultBrowser: {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC},
    isTelemetryEnabled: {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC},
    isBlocklistEnabled: {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC},
  },
});

/**
 * Legacy version of app info before Telemetry was added.
 *
 * The "last" fields have all been removed. We only report the longitudinal
 * field.
 */
function AppInfoMeasurement1() {
  Metrics.Measurement.call(this);
}

AppInfoMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "appinfo",
  version: 1,

  fields: {
    isDefaultBrowser: {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC},
  },
});


function AppVersionMeasurement1() {
  Metrics.Measurement.call(this);
}

AppVersionMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "versions",
  version: 1,

  fields: {
    version: {type: Metrics.Storage.FIELD_DAILY_DISCRETE_TEXT},
  },
});

// Version 2 added the build ID.
function AppVersionMeasurement2() {
  Metrics.Measurement.call(this);
}

AppVersionMeasurement2.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "versions",
  version: 2,

  fields: {
    appVersion: {type: Metrics.Storage.FIELD_DAILY_DISCRETE_TEXT},
    platformVersion: {type: Metrics.Storage.FIELD_DAILY_DISCRETE_TEXT},
    appBuildID: {type: Metrics.Storage.FIELD_DAILY_DISCRETE_TEXT},
    platformBuildID: {type: Metrics.Storage.FIELD_DAILY_DISCRETE_TEXT},
  },
});

/**
 * Holds data on the application update functionality.
 */
function AppUpdateMeasurement1() {
  Metrics.Measurement.call(this);
}

AppUpdateMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "update",
  version: 1,

  fields: {
    enabled: {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC},
    autoDownload: {type: Metrics.Storage.FIELD_DAILY_LAST_NUMERIC},
  },
});

this.AppInfoProvider = function AppInfoProvider() {
  Metrics.Provider.call(this);

  this._prefs = new Preferences({defaultBranch: null});
}
AppInfoProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.appInfo",

  measurementTypes: [
    AppInfoMeasurement,
    AppInfoMeasurement1,
    AppUpdateMeasurement1,
    AppVersionMeasurement1,
    AppVersionMeasurement2,
  ],

  pullOnly: true,

  appInfoFields: {
    // From nsIXULAppInfo.
    vendor: "vendor",
    name: "name",
    id: "ID",
    version: "version",
    appBuildID: "appBuildID",
    platformVersion: "platformVersion",
    platformBuildID: "platformBuildID",

    // From nsIXULRuntime.
    os: "OS",
    xpcomabi: "XPCOMABI",
  },

  postInit: function () {
    return Task.spawn(this._postInit.bind(this));
  },

  _postInit: function () {
    let recordEmptyAppInfo = function () {
      this._setCurrentAppVersion("");
      this._setCurrentPlatformVersion("");
      this._setCurrentAppBuildID("");
      return this._setCurrentPlatformBuildID("");
    }.bind(this);

    // Services.appInfo should always be defined for any reasonably behaving
    // Gecko app. If it isn't, we insert a empty string sentinel value.
    let ai;
    try {
      ai = Services.appinfo;
    } catch (ex) {
      this._log.error("Could not obtain Services.appinfo: " +
                     CommonUtils.exceptionStr(ex));
      yield recordEmptyAppInfo();
      return;
    }

    if (!ai) {
      this._log.error("Services.appinfo is unavailable.");
      yield recordEmptyAppInfo();
      return;
    }

    let currentAppVersion = ai.version;
    let currentPlatformVersion = ai.platformVersion;
    let currentAppBuildID = ai.appBuildID;
    let currentPlatformBuildID = ai.platformBuildID;

    // State's name doesn't contain "app" for historical compatibility.
    let lastAppVersion = yield this.getState("lastVersion");
    let lastPlatformVersion = yield this.getState("lastPlatformVersion");
    let lastAppBuildID = yield this.getState("lastAppBuildID");
    let lastPlatformBuildID = yield this.getState("lastPlatformBuildID");

    if (currentAppVersion != lastAppVersion) {
      yield this._setCurrentAppVersion(currentAppVersion);
    }

    if (currentPlatformVersion != lastPlatformVersion) {
      yield this._setCurrentPlatformVersion(currentPlatformVersion);
    }

    if (currentAppBuildID != lastAppBuildID) {
      yield this._setCurrentAppBuildID(currentAppBuildID);
    }

    if (currentPlatformBuildID != lastPlatformBuildID) {
      yield this._setCurrentPlatformBuildID(currentPlatformBuildID);
    }
  },

  _setCurrentAppVersion: function (version) {
    this._log.info("Recording new application version: " + version);
    let m = this.getMeasurement("versions", 2);
    m.addDailyDiscreteText("appVersion", version);

    // "app" not encoded in key for historical compatibility.
    return this.setState("lastVersion", version);
  },

  _setCurrentPlatformVersion: function (version) {
    this._log.info("Recording new platform version: " + version);
    let m = this.getMeasurement("versions", 2);
    m.addDailyDiscreteText("platformVersion", version);
    return this.setState("lastPlatformVersion", version);
  },

  _setCurrentAppBuildID: function (build) {
    this._log.info("Recording new application build ID: " + build);
    let m = this.getMeasurement("versions", 2);
    m.addDailyDiscreteText("appBuildID", build);
    return this.setState("lastAppBuildID", build);
  },

  _setCurrentPlatformBuildID: function (build) {
    this._log.info("Recording new platform build ID: " + build);
    let m = this.getMeasurement("versions", 2);
    m.addDailyDiscreteText("platformBuildID", build);
    return this.setState("lastPlatformBuildID", build);
  },


  collectConstantData: function () {
    return this.storage.enqueueTransaction(this._populateConstants.bind(this));
  },

  _populateConstants: function () {
    let m = this.getMeasurement(AppInfoMeasurement.prototype.name,
                                AppInfoMeasurement.prototype.version);

    let ai;
    try {
      ai = Services.appinfo;
    } catch (ex) {
      this._log.warn("Could not obtain Services.appinfo: " +
                     CommonUtils.exceptionStr(ex));
      throw ex;
    }

    if (!ai) {
      this._log.warn("Services.appinfo is unavailable.");
      throw ex;
    }

    for (let [k, v] in Iterator(this.appInfoFields)) {
      try {
        yield m.setLastText(k, ai[v]);
      } catch (ex) {
        this._log.warn("Error obtaining Services.appinfo." + v);
      }
    }

    try {
      yield m.setLastText("updateChannel", UpdateChannel.get());
    } catch (ex) {
      this._log.warn("Could not obtain update channel: " +
                     CommonUtils.exceptionStr(ex));
    }

    yield m.setLastText("distributionID", this._prefs.get("distribution.id", ""));
    yield m.setLastText("distributionVersion", this._prefs.get("distribution.version", ""));
    yield m.setLastText("hotfixVersion", this._prefs.get("extensions.hotfix.lastVersion", ""));

    try {
      let locale = Cc["@mozilla.org/chrome/chrome-registry;1"]
                     .getService(Ci.nsIXULChromeRegistry)
                     .getSelectedLocale("global");
      yield m.setLastText("locale", locale);
    } catch (ex) {
      this._log.warn("Could not obtain application locale: " +
                     CommonUtils.exceptionStr(ex));
    }

    // FUTURE this should be retrieved periodically or at upload time.
    yield this._recordIsTelemetryEnabled(m);
    yield this._recordIsBlocklistEnabled(m);
    yield this._recordDefaultBrowser(m);
  },

  _recordIsTelemetryEnabled: function (m) {
    let enabled = isTelemetryEnabled(this._prefs);
    this._log.debug("Recording telemetry enabled (" + TELEMETRY_PREF + "): " + enabled);
    yield m.setDailyLastNumeric("isTelemetryEnabled", enabled ? 1 : 0);
  },

  _recordIsBlocklistEnabled: function (m) {
    let enabled = this._prefs.get("extensions.blocklist.enabled", false);
    this._log.debug("Recording blocklist enabled: " + enabled);
    yield m.setDailyLastNumeric("isBlocklistEnabled", enabled ? 1 : 0);
  },

  _recordDefaultBrowser: function (m) {
    let shellService;
    try {
      shellService = Cc["@mozilla.org/browser/shell-service;1"]
                       .getService(Ci.nsIShellService);
    } catch (ex) {
      this._log.warn("Could not obtain shell service: " +
                     CommonUtils.exceptionStr(ex));
    }

    let isDefault = -1;

    if (shellService) {
      try {
        // This uses the same set of flags used by the pref pane.
        isDefault = shellService.isDefaultBrowser(false, true) ? 1 : 0;
      } catch (ex) {
        this._log.warn("Could not determine if default browser: " +
                       CommonUtils.exceptionStr(ex));
      }
    }

    return m.setDailyLastNumeric("isDefaultBrowser", isDefault);
  },

  collectDailyData: function () {
    return this.storage.enqueueTransaction(function getDaily() {
      let m = this.getMeasurement(AppUpdateMeasurement1.prototype.name,
                                  AppUpdateMeasurement1.prototype.version);

      let enabled = this._prefs.get("app.update.enabled", false);
      yield m.setDailyLastNumeric("enabled", enabled ? 1 : 0);

      let auto = this._prefs.get("app.update.auto", false);
      yield m.setDailyLastNumeric("autoDownload", auto ? 1 : 0);
    }.bind(this));
  },
});


function SysInfoMeasurement() {
  Metrics.Measurement.call(this);
}

SysInfoMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "sysinfo",
  version: 2,

  fields: {
    cpuCount: {type: Metrics.Storage.FIELD_LAST_NUMERIC},
    memoryMB: {type: Metrics.Storage.FIELD_LAST_NUMERIC},
    manufacturer: LAST_TEXT_FIELD,
    device: LAST_TEXT_FIELD,
    hardware: LAST_TEXT_FIELD,
    name: LAST_TEXT_FIELD,
    version: LAST_TEXT_FIELD,
    architecture: LAST_TEXT_FIELD,
    isWow64: LAST_NUMERIC_FIELD,
  },
});


this.SysInfoProvider = function SysInfoProvider() {
  Metrics.Provider.call(this);
};

SysInfoProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.sysinfo",

  measurementTypes: [SysInfoMeasurement],

  pullOnly: true,

  sysInfoFields: {
    cpucount: "cpuCount",
    memsize: "memoryMB",
    manufacturer: "manufacturer",
    device: "device",
    hardware: "hardware",
    name: "name",
    version: "version",
    arch: "architecture",
    isWow64: "isWow64",
  },

  collectConstantData: function () {
    return this.storage.enqueueTransaction(this._populateConstants.bind(this));
  },

  _populateConstants: function () {
    let m = this.getMeasurement(SysInfoMeasurement.prototype.name,
                                SysInfoMeasurement.prototype.version);

    let si = Cc["@mozilla.org/system-info;1"]
               .getService(Ci.nsIPropertyBag2);

    for (let [k, v] in Iterator(this.sysInfoFields)) {
      try {
        if (!si.hasKey(k)) {
          this._log.debug("Property not available: " + k);
          continue;
        }

        let value = si.getProperty(k);
        let method = "setLastText";

        if (["cpucount", "memsize"].indexOf(k) != -1) {
          let converted = parseInt(value, 10);
          if (Number.isNaN(converted)) {
            continue;
          }

          value = converted;
          method = "setLastNumeric";
        }

        switch (k) {
          case "memsize":
            // Round memory to mebibytes.
            value = Math.round(value / 1048576);
            break;
          case "isWow64":
            // Property is only present on Windows. hasKey() skipping from
            // above ensures undefined or null doesn't creep in here.
            value = value ? 1 : 0;
            method = "setLastNumeric";
            break;
        }

        yield m[method](v, value);
      } catch (ex) {
        this._log.warn("Error obtaining system info field: " + k + " " +
                       CommonUtils.exceptionStr(ex));
      }
    }
  },
});


/**
 * Holds information about the current/active session.
 *
 * The fields within the current session are moved to daily session fields when
 * the application is shut down.
 *
 * This measurement is backed by the SessionRecorder, not the database.
 */
function CurrentSessionMeasurement() {
  Metrics.Measurement.call(this);
}

CurrentSessionMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "current",
  version: 3,

  // Storage is in preferences.
  fields: {},

  /**
   * All data is stored in prefs, so we have a custom implementation.
   */
  getValues: function () {
    let sessions = this.provider.healthReporter.sessionRecorder;

    let fields = new Map();
    let now = new Date();
    fields.set("startDay", [now, Metrics.dateToDays(sessions.startDate)]);
    fields.set("activeTicks", [now, sessions.activeTicks]);
    fields.set("totalTime", [now, sessions.totalTime]);
    fields.set("main", [now, sessions.main]);
    fields.set("firstPaint", [now, sessions.firstPaint]);
    fields.set("sessionRestored", [now, sessions.sessionRestored]);

    return CommonUtils.laterTickResolvingPromise({
      days: new Metrics.DailyValues(),
      singular: fields,
    });
  },

  _serializeJSONSingular: function (data) {
    let result = {"_v": this.version};

    for (let [field, value] of data) {
      result[field] = value[1];
    }

    return result;
  },
});

/**
 * Records a history of all application sessions.
 */
function PreviousSessionsMeasurement() {
  Metrics.Measurement.call(this);
}

PreviousSessionsMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "previous",
  version: 3,

  fields: {
    // Milliseconds of sessions that were properly shut down.
    cleanActiveTicks: DAILY_DISCRETE_NUMERIC_FIELD,
    cleanTotalTime: DAILY_DISCRETE_NUMERIC_FIELD,

    // Milliseconds of sessions that were not properly shut down.
    abortedActiveTicks: DAILY_DISCRETE_NUMERIC_FIELD,
    abortedTotalTime: DAILY_DISCRETE_NUMERIC_FIELD,

    // Startup times in milliseconds.
    main: DAILY_DISCRETE_NUMERIC_FIELD,
    firstPaint: DAILY_DISCRETE_NUMERIC_FIELD,
    sessionRestored: DAILY_DISCRETE_NUMERIC_FIELD,
  },
});


/**
 * Records information about the current browser session.
 *
 * A browser session is defined as an application/process lifetime. We
 * start a new session when the application starts (essentially when
 * this provider is instantiated) and end the session on shutdown.
 *
 * As the application runs, we record basic information about the
 * "activity" of the session. Activity is defined by the presence of
 * physical input into the browser (key press, mouse click, touch, etc).
 *
 * We differentiate between regular sessions and "aborted" sessions. An
 * aborted session is one that does not end expectedly. This is often the
 * result of a crash. We detect aborted sessions by storing the current
 * session separate from completed sessions. We normally move the
 * current session to completed sessions on application shutdown. If a
 * current session is present on application startup, that means that
 * the previous session was aborted.
 */
this.SessionsProvider = function () {
  Metrics.Provider.call(this);
};

SessionsProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.appSessions",

  measurementTypes: [CurrentSessionMeasurement, PreviousSessionsMeasurement],

  pullOnly: true,

  collectConstantData: function () {
    let previous = this.getMeasurement("previous", 3);

    return this.storage.enqueueTransaction(this._recordAndPruneSessions.bind(this));
  },

  _recordAndPruneSessions: function () {
    this._log.info("Moving previous sessions from session recorder to storage.");
    let recorder = this.healthReporter.sessionRecorder;
    let sessions = recorder.getPreviousSessions();
    this._log.debug("Found " + Object.keys(sessions).length + " previous sessions.");

    let daily = this.getMeasurement("previous", 3);

    // Please note the coupling here between the session recorder and our state.
    // If the pruned index or the current index of the session recorder is ever
    // deleted or reset to 0, our stored state of a later index would mean that
    // new sessions would never be captured by this provider until the session
    // recorder index catches up to our last session ID. This should not happen
    // under normal circumstances, so we don't worry too much about it. We
    // should, however, consider this as part of implementing bug 841561.
    let lastRecordedSession = yield this.getState("lastSession");
    if (lastRecordedSession === null) {
      lastRecordedSession = -1;
    }
    this._log.debug("The last recorded session was #" + lastRecordedSession);

    for (let [index, session] in Iterator(sessions)) {
      if (index <= lastRecordedSession) {
        this._log.warn("Already recorded session " + index + ". Did the last " +
                       "session crash or have an issue saving the prefs file?");
        continue;
      }

      let type = session.clean ? "clean" : "aborted";
      let date = session.startDate;
      yield daily.addDailyDiscreteNumeric(type + "ActiveTicks", session.activeTicks, date);
      yield daily.addDailyDiscreteNumeric(type + "TotalTime", session.totalTime, date);

      for (let field of ["main", "firstPaint", "sessionRestored"]) {
        yield daily.addDailyDiscreteNumeric(field, session[field], date);
      }

      lastRecordedSession = index;
    }

    yield this.setState("lastSession", "" + lastRecordedSession);
    recorder.pruneOldSessions(new Date());
  },
});

/**
 * Stores the set of active addons in storage.
 *
 * We do things a little differently than most other measurements. Because
 * addons are difficult to shoehorn into distinct fields, we simply store a
 * JSON blob in storage in a text field.
 */
function ActiveAddonsMeasurement() {
  Metrics.Measurement.call(this);

  this._serializers = {};
  this._serializers[this.SERIALIZE_JSON] = {
    singular: this._serializeJSONSingular.bind(this),
    // We don't need a daily serializer because we have none of this data.
  };
}

ActiveAddonsMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "addons",
  version: 2,

  fields: {
    addons: LAST_TEXT_FIELD,
  },

  _serializeJSONSingular: function (data) {
    if (!data.has("addons")) {
      this._log.warn("Don't have addons info. Weird.");
      return null;
    }

    // Exceptions are caught in the caller.
    let result = JSON.parse(data.get("addons")[1]);
    result._v = this.version;
    return result;
  },
});

/**
 * Stores the set of active plugins in storage.
 *
 * This stores the data in a JSON blob in a text field similar to the
 * ActiveAddonsMeasurement.
 */
function ActivePluginsMeasurement() {
  Metrics.Measurement.call(this);

  this._serializers = {};
  this._serializers[this.SERIALIZE_JSON] = {
    singular: this._serializeJSONSingular.bind(this),
    // We don't need a daily serializer because we have none of this data.
  };
}

ActivePluginsMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "plugins",
  version: 1,

  fields: {
    plugins: LAST_TEXT_FIELD,
  },

  _serializeJSONSingular: function (data) {
    if (!data.has("plugins")) {
      this._log.warn("Don't have plugins info. Weird.");
      return null;
    }

    // Exceptions are caught in the caller.
    let result = JSON.parse(data.get("plugins")[1]);
    result._v = this.version;
    return result;
  },
});

function ActiveGMPluginsMeasurement() {
  Metrics.Measurement.call(this);

  this._serializers = {};
  this._serializers[this.SERIALIZE_JSON] = {
    singular: this._serializeJSONSingular.bind(this),
  };
}

ActiveGMPluginsMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "gm-plugins",
  version: 1,

  fields: {
    "gm-plugins": LAST_TEXT_FIELD,
  },

  _serializeJSONSingular: function (data) {
    if (!data.has("gm-plugins")) {
      this._log.warn("Don't have GM plugins info. Weird.");
      return null;
    }

    let result = JSON.parse(data.get("gm-plugins")[1]);
    result._v = this.version;
    return result;
  },
});

function AddonCountsMeasurement() {
  Metrics.Measurement.call(this);
}

AddonCountsMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "counts",
  version: 2,

  fields: {
    theme: DAILY_LAST_NUMERIC_FIELD,
    lwtheme: DAILY_LAST_NUMERIC_FIELD,
    plugin: DAILY_LAST_NUMERIC_FIELD,
    extension: DAILY_LAST_NUMERIC_FIELD,
    service: DAILY_LAST_NUMERIC_FIELD,
  },
});


/**
 * Legacy version of addons counts before services was added.
 */
function AddonCountsMeasurement1() {
  Metrics.Measurement.call(this);
}

AddonCountsMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "counts",
  version: 1,

  fields: {
    theme: DAILY_LAST_NUMERIC_FIELD,
    lwtheme: DAILY_LAST_NUMERIC_FIELD,
    plugin: DAILY_LAST_NUMERIC_FIELD,
    extension: DAILY_LAST_NUMERIC_FIELD,
  },
});


this.AddonsProvider = function () {
  Metrics.Provider.call(this);

  this._prefs = new Preferences({defaultBranch: null});
};

AddonsProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  // Whenever these AddonListener callbacks are called, we repopulate
  // and store the set of addons. Note that these events will only fire
  // for restartless add-ons. For actions that require a restart, we
  // will catch the change after restart. The alternative is a lot of
  // state tracking here, which isn't desirable.
  ADDON_LISTENER_CALLBACKS: [
    "onEnabled",
    "onDisabled",
    "onInstalled",
    "onUninstalled",
  ],

  // Add-on types for which full details are uploaded in the
  // ActiveAddonsMeasurement. All other types are ignored.
  FULL_DETAIL_TYPES: [
    "extension",
    "service",
  ],

  name: "org.mozilla.addons",

  measurementTypes: [
    ActiveAddonsMeasurement,
    ActivePluginsMeasurement,
    ActiveGMPluginsMeasurement,
    AddonCountsMeasurement1,
    AddonCountsMeasurement,
  ],

  postInit: function () {
    let listener = {};

    for (let method of this.ADDON_LISTENER_CALLBACKS) {
      listener[method] = this._collectAndStoreAddons.bind(this);
    }

    this._listener = listener;
    AddonManager.addAddonListener(this._listener);

    return CommonUtils.laterTickResolvingPromise();
  },

  onShutdown: function () {
    AddonManager.removeAddonListener(this._listener);
    this._listener = null;

    return CommonUtils.laterTickResolvingPromise();
  },

  collectConstantData: function () {
    return this._collectAndStoreAddons();
  },

  _collectAndStoreAddons: function () {
    let deferred = Promise.defer();

    AddonManager.getAllAddons(function onAllAddons(allAddons) {
      let data;
      let addonsField;
      let pluginsField;
      let gmPluginsField;
      try {
        data = this._createDataStructure(allAddons);
        addonsField = JSON.stringify(data.addons);
        pluginsField = JSON.stringify(data.plugins);
        gmPluginsField = JSON.stringify(data.gmPlugins);
      } catch (ex) {
        this._log.warn("Exception when populating add-ons data structure: " +
                       CommonUtils.exceptionStr(ex));
        deferred.reject(ex);
        return;
      }

      let now = new Date();
      let addons = this.getMeasurement("addons", 2);
      let plugins = this.getMeasurement("plugins", 1);
      let gmPlugins = this.getMeasurement("gm-plugins", 1);
      let counts = this.getMeasurement(AddonCountsMeasurement.prototype.name,
                                       AddonCountsMeasurement.prototype.version);

      this.enqueueStorageOperation(function storageAddons() {
        for (let type in data.counts) {
          try {
            counts.fieldID(type);
          } catch (ex) {
            this._log.warn("Add-on type without field: " + type);
            continue;
          }

          counts.setDailyLastNumeric(type, data.counts[type], now);
        }

        return addons.setLastText("addons", addonsField).then(
          function onSuccess() {
            return plugins.setLastText("plugins", pluginsField).then(
              function onSuccess() {
                return gmPlugins.setLastText("gm-plugins", gmPluginsField).then(
                  function onSuccess() {
                    deferred.resolve();
                  },
                  function onError(error) {
                    deferred.reject(error);
                  });
              },
              function onError(error) { deferred.reject(error); }
            );
          },
          function onError(error) { deferred.reject(error); }
        );
      }.bind(this));
    }.bind(this));

    return deferred.promise;
  },

  COPY_ADDON_FIELDS: [
    "userDisabled",
    "appDisabled",
    "name",
    "version",
    "type",
    "scope",
    "description",
    "foreignInstall",
    "hasBinaryComponents",
  ],

  COPY_PLUGIN_FIELDS: [
    "name",
    "version",
    "description",
    "blocklisted",
    "disabled",
    "clicktoplay",
  ],

  _createDataStructure: function (addons) {
    let data = {
      addons: {},
      plugins: {},
      gmPlugins: {},
      counts: {}
    };

    for (let addon of addons) {
      let type = addon.type;

      // We count plugins separately below.
      if (addon.type == "plugin") {
        if (addon.isGMPlugin) {
          data.gmPlugins[addon.id] = {
            version: addon.version,
            userDisabled: addon.userDisabled,
            applyBackgroundUpdates: addon.applyBackgroundUpdates,
          };
        }
        continue;
      }

      data.counts[type] = (data.counts[type] || 0) + 1;

      if (this.FULL_DETAIL_TYPES.indexOf(addon.type) == -1) {
        continue;
      }

      let obj = {};
      for (let field of this.COPY_ADDON_FIELDS) {
        obj[field] = addon[field];
      }

      if (addon.installDate) {
        obj.installDay = this._dateToDays(addon.installDate);
      }

      if (addon.updateDate) {
        obj.updateDay = this._dateToDays(addon.updateDate);
      }

      data.addons[addon.id] = obj;
    }

    let pluginTags = Cc["@mozilla.org/plugin/host;1"].
                       getService(Ci.nsIPluginHost).
                       getPluginTags({});

    for (let tag of pluginTags) {
      let obj = {
        mimeTypes: tag.getMimeTypes({}),
      };

      for (let field of this.COPY_PLUGIN_FIELDS) {
        obj[field] = tag[field];
      }

      // Plugins need to have a filename and a name, so this can't be empty.
      let id = tag.filename + ":" + tag.name + ":" + tag.version + ":"
               + tag.description;
      data.plugins[id] = obj;
    }

    data.counts["plugin"] = pluginTags.length;

    return data;
  },
});

//@line 1050 "e:\hg38\comm-esr38\mozilla\services\healthreport\providers.jsm"

function DailyCrashesMeasurement1() {
  Metrics.Measurement.call(this);
}

DailyCrashesMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "crashes",
  version: 1,

  fields: {
    pending: DAILY_COUNTER_FIELD,
    submitted: DAILY_COUNTER_FIELD,
  },
});

function DailyCrashesMeasurement2() {
  Metrics.Measurement.call(this);
}

DailyCrashesMeasurement2.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "crashes",
  version: 2,

  fields: {
    mainCrash: DAILY_LAST_NUMERIC_FIELD,
  },
});

function DailyCrashesMeasurement3() {
  Metrics.Measurement.call(this);
}

DailyCrashesMeasurement3.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "crashes",
  version: 3,

  fields: {
    "main-crash": DAILY_LAST_NUMERIC_FIELD,
    "main-hang": DAILY_LAST_NUMERIC_FIELD,
    "content-crash": DAILY_LAST_NUMERIC_FIELD,
    "content-hang": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang": DAILY_LAST_NUMERIC_FIELD,
  },
});

function DailyCrashesMeasurement4() {
  Metrics.Measurement.call(this);
}

DailyCrashesMeasurement4.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "crashes",
  version: 4,

  fields: {
    "main-crash": DAILY_LAST_NUMERIC_FIELD,
    "main-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "main-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "main-hang": DAILY_LAST_NUMERIC_FIELD,
    "main-hang-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "main-hang-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "content-crash": DAILY_LAST_NUMERIC_FIELD,
    "content-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "content-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "content-hang": DAILY_LAST_NUMERIC_FIELD,
    "content-hang-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "content-hang-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang-submission-failed": DAILY_LAST_NUMERIC_FIELD,
  },
});

function DailyCrashesMeasurement5() {
  Metrics.Measurement.call(this);
}

DailyCrashesMeasurement5.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "crashes",
  version: 5,

  fields: {
    "main-crash": DAILY_LAST_NUMERIC_FIELD,
    "main-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "main-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "main-hang": DAILY_LAST_NUMERIC_FIELD,
    "main-hang-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "main-hang-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "content-crash": DAILY_LAST_NUMERIC_FIELD,
    "content-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "content-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "content-hang": DAILY_LAST_NUMERIC_FIELD,
    "content-hang-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "content-hang-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "plugin-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "plugin-hang-submission-failed": DAILY_LAST_NUMERIC_FIELD,
    "gmplugin-crash": DAILY_LAST_NUMERIC_FIELD,
    "gmplugin-crash-submission-succeeded": DAILY_LAST_NUMERIC_FIELD,
    "gmplugin-crash-submission-failed": DAILY_LAST_NUMERIC_FIELD,
  },
});

this.CrashesProvider = function () {
  Metrics.Provider.call(this);

  // So we can unit test.
  this._manager = Services.crashmanager;
};

CrashesProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.crashes",

  measurementTypes: [
    DailyCrashesMeasurement1,
    DailyCrashesMeasurement2,
    DailyCrashesMeasurement3,
    DailyCrashesMeasurement4,
    DailyCrashesMeasurement5,
  ],

  pullOnly: true,

  collectDailyData: function () {
    return this.storage.enqueueTransaction(this._populateCrashCounts.bind(this));
  },

  _populateCrashCounts: function () {
    this._log.info("Grabbing crash counts from crash manager.");
    let crashCounts = yield this._manager.getCrashCountsByDay();

    // TODO: CrashManager no longer stores submissions as crashes, but we still
    // want to send the submission data to FHR. As a temporary workaround, we
    // populate |crashCounts| with the submission data to match past behaviour.
    // See bug 1056160.
    let crashes = yield this._manager.getCrashes();
    for (let crash of crashes) {
      for (let [submissionID, submission] of crash.submissions) {
        if (!submission.responseDate) {
          continue;
        }

        let day = Metrics.dateToDays(submission.responseDate);
        if (!crashCounts.has(day)) {
          crashCounts.set(day, new Map());
        }

        let succeeded =
          submission.result == this._manager.SUBMISSION_RESULT_OK;
        let type = crash.type + "-submission-" + (succeeded ? "succeeded" :
                                                              "failed");

        let count = (crashCounts.get(day).get(type) || 0) + 1;
        crashCounts.get(day).set(type, count);
      }
    }

    let m = this.getMeasurement("crashes", 5);
    let fields = DailyCrashesMeasurement5.prototype.fields;

    for (let [day, types] of crashCounts) {
      let date = Metrics.daysToDate(day);
      for (let [type, count] of types) {
        if (!(type in fields)) {
          this._log.warn("Unknown crash type encountered: " + type);
          continue;
        }

        yield m.setDailyLastNumeric(type, count, date);
      }
    }
  },
});

//@line 1243 "e:\hg38\comm-esr38\mozilla\services\healthreport\providers.jsm"

/**
 * Records data from update hotfixes.
 *
 * This measurement has dynamic fields. Field names are of the form
 * <version>.<thing> where <version> is the hotfix version that produced
 * the data. e.g. "v20140527". The sub-version of the hotfix is omitted
 * because hotfixes can go through multiple minor versions during development
 * and we don't want to introduce more fields than necessary. Furthermore,
 * the subsequent dots make parsing field names slightly harder. By stripping,
 * we can just split on the first dot.
 */
function UpdateHotfixMeasurement1() {
  Metrics.Measurement.call(this);
}

UpdateHotfixMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "update",
  version: 1,

  hotfixFieldTypes: {
    "upgradedFrom": Metrics.Storage.FIELD_LAST_TEXT,
    "uninstallReason": Metrics.Storage.FIELD_LAST_TEXT,
    "downloadAttempts": Metrics.Storage.FIELD_LAST_NUMERIC,
    "downloadFailures": Metrics.Storage.FIELD_LAST_NUMERIC,
    "installAttempts": Metrics.Storage.FIELD_LAST_NUMERIC,
    "installFailures": Metrics.Storage.FIELD_LAST_NUMERIC,
    "notificationsShown": Metrics.Storage.FIELD_LAST_NUMERIC,
  },

  fields: { },

  // Our fields have dynamic names from the hotfix version that supplied them.
  // We need to override the default behavior to deal with unknown fields.
  shouldIncludeField: function (name) {
    return name.contains(".");
  },

  fieldType: function (name) {
    for (let known in this.hotfixFieldTypes) {
      if (name.endsWith(known)) {
        return this.hotfixFieldTypes[known];
      }
    }

    return Metrics.Measurement.prototype.fieldType.call(this, name);
  },
});

this.HotfixProvider = function () {
  Metrics.Provider.call(this);
};

HotfixProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.hotfix",
  measurementTypes: [
    UpdateHotfixMeasurement1,
  ],

  pullOnly: true,

  collectDailyData: function () {
    return this.storage.enqueueTransaction(this._populateHotfixData.bind(this));
  },

  _populateHotfixData: function* () {
    let m = this.getMeasurement("update", 1);

    // The update hotfix retains its JSON state file after uninstall.
    // The initial update hotfix had a hard-coded filename. We treat it
    // specially. Subsequent update hotfixes named their files in a
    // recognizeable pattern so we don't need to update this probe code to
    // know about them.
    let files = [
        ["v20140527", OS.Path.join(OS.Constants.Path.profileDir,
                                   "hotfix.v20140527.01.json")],
    ];

    let it = new OS.File.DirectoryIterator(OS.Constants.Path.profileDir);
    try {
      yield it.forEach((e, index, it) => {
        let m = e.name.match(/^updateHotfix\.([a-zA-Z0-9]+)\.json$/);
        if (m) {
          files.push([m[1], e.path]);
        }
      });
    } finally {
      it.close();
    }

    let decoder = new TextDecoder();
    for (let e of files) {
      let [version, path] = e;
      let p;
      try {
        let data = yield OS.File.read(path);
        p = JSON.parse(decoder.decode(data));
      } catch (ex if ex instanceof OS.File.Error && ex.becauseNoSuchFile) {
        continue;
      } catch (ex) {
        this._log.warn("Error loading update hotfix payload: " + ex.message);
      }

      // Wrap just in case.
      try {
        for (let k in m.hotfixFieldTypes) {
          if (!(k in p)) {
            continue;
          }

          let value = p[k];
          if (value === null && k == "uninstallReason") {
            value = "STILL_INSTALLED";
          }

          let field = version + "." + k;
          let fieldType;
          let storageOp;
          switch (typeof(value)) {
            case "string":
              fieldType = this.storage.FIELD_LAST_TEXT;
              storageOp = "setLastTextFromFieldID";
              break;
            case "number":
              fieldType = this.storage.FIELD_LAST_NUMERIC;
              storageOp = "setLastNumericFromFieldID";
              break;
            default:
              this._log.warn("Unknown value in hotfix state: " + k + "=" + value);
              continue;
          }

          if (this.storage.hasFieldFromMeasurement(m.id, field, fieldType)) {
            let fieldID = this.storage.fieldIDFromMeasurement(m.id, field);
            yield this.storage[storageOp](fieldID, value);
          } else {
            let fieldID = yield this.storage.registerField(m.id, field,
                                                           fieldType);
            yield this.storage[storageOp](fieldID, value);
          }
        }

      } catch (ex) {
        this._log.warn("Error processing update hotfix data: " + ex);
      }
    }
  },
});

/**
 * Holds basic statistics about the Places database.
 */
function PlacesMeasurement() {
  Metrics.Measurement.call(this);
}

PlacesMeasurement.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "places",
  version: 1,

  fields: {
    pages: DAILY_LAST_NUMERIC_FIELD,
    bookmarks: DAILY_LAST_NUMERIC_FIELD,
  },
});


/**
 * Collects information about Places.
 */
this.PlacesProvider = function () {
  Metrics.Provider.call(this);
};

PlacesProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.places",

  measurementTypes: [PlacesMeasurement],

  collectDailyData: function () {
    return this.storage.enqueueTransaction(this._collectData.bind(this));
  },

  _collectData: function () {
    let now = new Date();
    let data = yield this._getDailyValues();

    let m = this.getMeasurement("places", 1);

    yield m.setDailyLastNumeric("pages", data.PLACES_PAGES_COUNT);
    yield m.setDailyLastNumeric("bookmarks", data.PLACES_BOOKMARKS_COUNT);
  },

  _getDailyValues: function () {
    let deferred = Promise.defer();

    PlacesDBUtils.telemetry(null, function onResult(data) {
      deferred.resolve(data);
    });

    return deferred.promise;
  },
});

function SearchCountMeasurement1() {
  Metrics.Measurement.call(this);
}

SearchCountMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "counts",
  version: 1,

  // We only record searches for search engines that have partner agreements
  // with Mozilla.
  fields: {
    "amazon.com.abouthome": DAILY_COUNTER_FIELD,
    "amazon.com.contextmenu": DAILY_COUNTER_FIELD,
    "amazon.com.searchbar": DAILY_COUNTER_FIELD,
    "amazon.com.urlbar": DAILY_COUNTER_FIELD,
    "bing.abouthome": DAILY_COUNTER_FIELD,
    "bing.contextmenu": DAILY_COUNTER_FIELD,
    "bing.searchbar": DAILY_COUNTER_FIELD,
    "bing.urlbar": DAILY_COUNTER_FIELD,
    "google.abouthome": DAILY_COUNTER_FIELD,
    "google.contextmenu": DAILY_COUNTER_FIELD,
    "google.searchbar": DAILY_COUNTER_FIELD,
    "google.urlbar": DAILY_COUNTER_FIELD,
    "yahoo.abouthome": DAILY_COUNTER_FIELD,
    "yahoo.contextmenu": DAILY_COUNTER_FIELD,
    "yahoo.searchbar": DAILY_COUNTER_FIELD,
    "yahoo.urlbar": DAILY_COUNTER_FIELD,
    "other.abouthome": DAILY_COUNTER_FIELD,
    "other.contextmenu": DAILY_COUNTER_FIELD,
    "other.searchbar": DAILY_COUNTER_FIELD,
    "other.urlbar": DAILY_COUNTER_FIELD,
  },
});

/**
 * Records search counts per day per engine and where search initiated.
 *
 * We want to record granular details for individual locale-specific search
 * providers, but only if they're Mozilla partners. In order to do this, we
 * track the nsISearchEngine identifier, which denotes shipped search engines,
 * and intersect those with our partner list.
 *
 * We don't use the search engine name directly, because it is shared across
 * locales; e.g., eBay-de and eBay both share the name "eBay".
 */
function SearchCountMeasurementBase() {
  this._fieldSpecs = {};
  Metrics.Measurement.call(this);
}

SearchCountMeasurementBase.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,


  // Our fields are dynamic.
  get fields() {
    return this._fieldSpecs;
  },

  /**
   * Override the default behavior: serializers should include every counter
   * field from the DB, even if we don't currently have it registered.
   *
   * Do this so we don't have to register several hundred fields to match
   * various Firefox locales.
   *
   * We use the "provider.type" syntax as a rudimentary check for validity.
   *
   * We trust that measurement versioning is sufficient to exclude old provider
   * data.
   */
  shouldIncludeField: function (name) {
    return name.contains(".");
  },

  /**
   * The measurement type mechanism doesn't introspect the DB. Override it
   * so that we can assume all unknown fields are counters.
   */
  fieldType: function (name) {
    if (name in this.fields) {
      return this.fields[name].type;
    }

    // Default to a counter.
    return Metrics.Storage.FIELD_DAILY_COUNTER;
  },

  SOURCES: [
    "abouthome",
    "contextmenu",
    "newtab",
    "searchbar",
    "urlbar",
  ],
});

function SearchCountMeasurement2() {
  SearchCountMeasurementBase.call(this);
}

SearchCountMeasurement2.prototype = Object.freeze({
  __proto__: SearchCountMeasurementBase.prototype,
  name: "counts",
  version: 2,
});

function SearchCountMeasurement3() {
  SearchCountMeasurementBase.call(this);
}

SearchCountMeasurement3.prototype = Object.freeze({
  __proto__: SearchCountMeasurementBase.prototype,
  name: "counts",
  version: 3,

  getEngines: function () {
    return Services.search.getEngines();
  },

  getEngineID: function (engine) {
    if (!engine) {
      return "other";
    }
    if (engine.identifier) {
      return engine.identifier;
    }
    return "other-" + engine.name;
  },
});

function SearchEnginesMeasurement1() {
  Metrics.Measurement.call(this);
}

SearchEnginesMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "engines",
  version: 1,

  fields: {
    default: DAILY_LAST_TEXT_FIELD,
  },
});

this.SearchesProvider = function () {
  Metrics.Provider.call(this);

  this._prefs = new Preferences({defaultBranch: null});
};

this.SearchesProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.searches",
  measurementTypes: [
    SearchCountMeasurement1,
    SearchCountMeasurement2,
    SearchCountMeasurement3,
    SearchEnginesMeasurement1,
  ],

  /**
   * Initialize the search service before our measurements are touched.
   */
  preInit: function (storage) {
    // Initialize search service.
    let deferred = Promise.defer();
    Services.search.init(function onInitComplete () {
      deferred.resolve();
    });
    return deferred.promise;
  },

  collectDailyData: function () {
    return this.storage.enqueueTransaction(function getDaily() {
      let m = this.getMeasurement(SearchEnginesMeasurement1.prototype.name,
                                  SearchEnginesMeasurement1.prototype.version);

      let engine;
      try {
        engine = Services.search.defaultEngine;
      } catch (e) {}
      let name;

      if (!engine) {
        name = "NONE";
      } else if (engine.identifier) {
        name = engine.identifier;
      } else if (engine.name) {
        name = "other-" + engine.name;
      } else {
        name = "UNDEFINED";
      }

      yield m.setDailyLastText("default", name);
    }.bind(this));
  },

  /**
   * Record that a search occurred.
   *
   * @param engine
   *        (nsISearchEngine) The search engine used.
   * @param source
   *        (string) Where the search was initiated from. Must be one of the
   *        SearchCountMeasurement2.SOURCES values.
   *
   * @return Promise<>
   *         The promise is resolved when the storage operation completes.
   */
  recordSearch: function (engine, source) {
    let m = this.getMeasurement("counts", 3);

    if (m.SOURCES.indexOf(source) == -1) {
      throw new Error("Unknown source for search: " + source);
    }

    let field = m.getEngineID(engine) + "." + source;
    if (this.storage.hasFieldFromMeasurement(m.id, field,
                                             this.storage.FIELD_DAILY_COUNTER)) {
      let fieldID = this.storage.fieldIDFromMeasurement(m.id, field);
      return this.enqueueStorageOperation(function recordSearchKnownField() {
        return this.storage.incrementDailyCounterFromFieldID(fieldID);
      }.bind(this));
    }

    // Otherwise, we first need to create the field.
    return this.enqueueStorageOperation(function recordFieldAndSearch() {
      // This function has to return a promise.
      return Task.spawn(function () {
        let fieldID = yield this.storage.registerField(m.id, field,
                                                       this.storage.FIELD_DAILY_COUNTER);
        yield this.storage.incrementDailyCounterFromFieldID(fieldID);
      }.bind(this));
    }.bind(this));
  },
});

function HealthReportSubmissionMeasurement1() {
  Metrics.Measurement.call(this);
}

HealthReportSubmissionMeasurement1.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "submissions",
  version: 1,

  fields: {
    firstDocumentUploadAttempt: DAILY_COUNTER_FIELD,
    continuationUploadAttempt: DAILY_COUNTER_FIELD,
    uploadSuccess: DAILY_COUNTER_FIELD,
    uploadTransportFailure: DAILY_COUNTER_FIELD,
    uploadServerFailure: DAILY_COUNTER_FIELD,
    uploadClientFailure: DAILY_COUNTER_FIELD,
  },
});

function HealthReportSubmissionMeasurement2() {
  Metrics.Measurement.call(this);
}

HealthReportSubmissionMeasurement2.prototype = Object.freeze({
  __proto__: Metrics.Measurement.prototype,

  name: "submissions",
  version: 2,

  fields: {
    firstDocumentUploadAttempt: DAILY_COUNTER_FIELD,
    continuationUploadAttempt: DAILY_COUNTER_FIELD,
    uploadSuccess: DAILY_COUNTER_FIELD,
    uploadTransportFailure: DAILY_COUNTER_FIELD,
    uploadServerFailure: DAILY_COUNTER_FIELD,
    uploadClientFailure: DAILY_COUNTER_FIELD,
    uploadAlreadyInProgress: DAILY_COUNTER_FIELD,
  },
});

this.HealthReportProvider = function () {
  Metrics.Provider.call(this);
}

HealthReportProvider.prototype = Object.freeze({
  __proto__: Metrics.Provider.prototype,

  name: "org.mozilla.healthreport",

  measurementTypes: [
    HealthReportSubmissionMeasurement1,
    HealthReportSubmissionMeasurement2,
  ],

  recordEvent: function (event, date=new Date()) {
    let m = this.getMeasurement("submissions", 2);
    return this.enqueueStorageOperation(function recordCounter() {
      return m.incrementDailyCounter(event, date);
    });
  },
});
//@line 42 "e:\hg38\comm-esr38\mozilla\services\healthreport\HealthReport.jsm"
;

