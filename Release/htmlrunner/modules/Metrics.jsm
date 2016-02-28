/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 6 "e:\hg38\comm-esr38\mozilla\services\metrics\Metrics.jsm"

"use strict";

this.EXPORTED_SYMBOLS = ["Metrics"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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

