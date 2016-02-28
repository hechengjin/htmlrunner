//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\nsUrlClassifierLib.js"

// We wastefully reload the same JS files across components.  This puts all
// the common JS files used by safebrowsing and url-classifier into a
// single component.

const Cc = Components.classes;
const Ci = Components.interfaces;
const G_GDEBUG = false;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\lang.js"


/**
 * lang.js - Some missing JavaScript language features
 */

/**
 * Partially applies a function to a particular "this object" and zero or
 * more arguments. The result is a new function with some arguments of the first
 * function pre-filled and the value of |this| "pre-specified".
 *
 * Remaining arguments specified at call-time are appended to the pre-
 * specified ones.
 *
 * Usage:
 * var barMethBound = BindToObject(myFunction, myObj, "arg1", "arg2");
 * barMethBound("arg3", "arg4");
 *
 * @param fn {string} Reference to the function to be bound
 *
 * @param self {object} Specifies the object which |this| should point to
 * when the function is run. If the value is null or undefined, it will default
 * to the global object.
 *
 * @returns {function} A partially-applied form of the speficied function.
 */
this.BindToObject = function BindToObject(fn, self, opt_args) {
  var boundargs = fn.boundArgs_ || [];
  boundargs = boundargs.concat(Array.slice(arguments, 2, arguments.length));

  if (fn.boundSelf_)
    self = fn.boundSelf_;
  if (fn.boundFn_)
    fn = fn.boundFn_;

  var newfn = function() {
    // Combine the static args and the new args into one big array
    var args = boundargs.concat(Array.slice(arguments));
    return fn.apply(self, args);
  }

  newfn.boundArgs_ = boundargs;
  newfn.boundSelf_ = self;
  newfn.boundFn_ = fn;

  return newfn;
}

/**
 * Inherit the prototype methods from one constructor into another.
 *
 * Usage:
 *
 * function ParentClass(a, b) { }
 * ParentClass.prototype.foo = function(a) { }
 *
 * function ChildClass(a, b, c) {
 *   ParentClass.call(this, a, b);
 * }
 *
 * ChildClass.inherits(ParentClass);
 *
 * var child = new ChildClass("a", "b", "see");
 * child.foo(); // works
 *
 * In addition, a superclass' implementation of a method can be invoked
 * as follows:
 *
 * ChildClass.prototype.foo = function(a) {
 *   ChildClass.superClass_.foo.call(this, a);
 *   // other code
 * };
 */
Function.prototype.inherits = function(parentCtor) {
  var tempCtor = function(){};
  tempCtor.prototype = parentCtor.prototype;
  this.superClass_ = parentCtor.prototype;
  this.prototype = new tempCtor();
}
//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\preferences.js"


// Class for manipulating preferences. Aside from wrapping the pref
// service, useful functionality includes:
//
// - abstracting prefobserving so that you can observe preferences
//   without implementing nsIObserver 
// 
// - getters that return a default value when the pref doesn't exist 
//   (instead of throwing)
// 
// - get-and-set getters
//
// Example:
// 
// var p = new PROT_Preferences();
// dump(p.getPref("some-true-pref"));     // shows true
// dump(p.getPref("no-such-pref", true)); // shows true   
// dump(p.getPref("no-such-pref", null)); // shows null
//
// function observe(prefThatChanged) {
//   dump("Pref changed: " + prefThatChanged);
// };
//
// p.addObserver("somepref", observe);
// p.setPref("somepref", true);            // dumps
// p.removeObserver("somepref", observe);
//
// TODO: should probably have the prefobserver pass in the new and old
//       values

// TODO(tc): Maybe remove this class and just call natively since we're no
//           longer an extension.

/**
 * A class that wraps the preferences service.
 *
 * @param opt_startPoint        A starting point on the prefs tree to resolve 
 *                              names passed to setPref and getPref.
 *
 * @param opt_useDefaultPranch  Set to true to work against the default 
 *                              preferences tree instead of the profile one.
 *
 * @constructor
 */
this.G_Preferences =
function G_Preferences(opt_startPoint, opt_getDefaultBranch) {
  this.debugZone = "prefs";
  this.observers_ = {};
  this.getDefaultBranch_ = !!opt_getDefaultBranch;

  this.startPoint_ = opt_startPoint || null;
}

G_Preferences.setterMap_ = { "string": "setCharPref",
                             "boolean": "setBoolPref",
                             "number": "setIntPref" };

G_Preferences.getterMap_ = {};
G_Preferences.getterMap_[Ci.nsIPrefBranch.PREF_STRING] = "getCharPref";
G_Preferences.getterMap_[Ci.nsIPrefBranch.PREF_BOOL] = "getBoolPref";
G_Preferences.getterMap_[Ci.nsIPrefBranch.PREF_INT] = "getIntPref";

G_Preferences.prototype.__defineGetter__('prefs_', function() {
  var prefs;
  var prefSvc = Cc["@mozilla.org/preferences-service;1"]
                  .getService(Ci.nsIPrefService);

  if (this.getDefaultBranch_) {
    prefs = prefSvc.getDefaultBranch(this.startPoint_);
  } else {
    prefs = prefSvc.getBranch(this.startPoint_);
  }

  // QI to prefs in case we want to add observers
  prefs.QueryInterface(Ci.nsIPrefBranchInternal);
  return prefs;
});

/**
 * Stores a key/value in a user preference. Valid types for val are string,
 * boolean, and number. Complex values are not yet supported (but feel free to
 * add them!).
 */
G_Preferences.prototype.setPref = function(key, val) {
  var datatype = typeof(val);

  if (datatype == "number" && (val % 1 != 0)) {
    throw new Error("Cannot store non-integer numbers in preferences.");
  }

  var meth = G_Preferences.setterMap_[datatype];

  if (!meth) {
    throw new Error("Pref datatype {" + datatype + "} not supported.");
  }

  return this.prefs_[meth](key, val);
}

/**
 * Retrieves a user preference. Valid types for the value are the same as for
 * setPref. If the preference is not found, opt_default will be returned 
 * instead.
 */
G_Preferences.prototype.getPref = function(key, opt_default) {
  var type = this.prefs_.getPrefType(key);

  // zero means that the specified pref didn't exist
  if (type == Ci.nsIPrefBranch.PREF_INVALID) {
    return opt_default;
  }

  var meth = G_Preferences.getterMap_[type];

  if (!meth) {
    throw new Error("Pref datatype {" + type + "} not supported.");
  }

  // If a pref has been cleared, it will have a valid type but won't
  // be gettable, so this will throw.
  try {
    return this.prefs_[meth](key);
  } catch(e) {
    return opt_default;
  }
}

/**
 * Delete a preference. 
 *
 * @param which Name of preference to obliterate
 */
G_Preferences.prototype.clearPref = function(which) {
  try {
    // This throws if the pref doesn't exist, which is fine because a 
    // nonexistent pref is cleared
    this.prefs_.clearUserPref(which);
  } catch(e) {}
}

/**
 * Add an observer for a given pref.
 *
 * @param which String containing the pref to listen to
 * @param callback Function to be called when the pref changes. This
 *                 function will receive a single argument, a string 
 *                 holding the preference name that changed
 */
G_Preferences.prototype.addObserver = function(which, callback) {
  // Need to store the observer we create so we can eventually unregister it
  if (!this.observers_[which])
    this.observers_[which] = { callbacks: [], observers: [] };

  /* only add an observer if the callback hasn't been registered yet */
  if (this.observers_[which].callbacks.indexOf(callback) == -1) {
    var observer = new G_PreferenceObserver(callback);
    this.observers_[which].callbacks.push(callback);
    this.observers_[which].observers.push(observer);
    this.prefs_.addObserver(which, observer, false /* strong reference */);
  }
}

/**
 * Remove an observer for a given pref.
 *
 * @param which String containing the pref to stop listening to
 * @param callback Function to remove as an observer
 */
G_Preferences.prototype.removeObserver = function(which, callback) {
  var ix = this.observers_[which].callbacks.indexOf(callback);
  G_Assert(this, ix != -1, "Tried to unregister a nonexistent observer"); 
  this.observers_[which].callbacks.splice(ix, 1);
  var observer = this.observers_[which].observers.splice(ix, 1)[0];
  this.prefs_.removeObserver(which, observer);
}

/**
 * Remove all preference observers registered through this object.
 */
G_Preferences.prototype.removeAllObservers = function() {
  for (var which in this.observers_) {
    for each (var observer in this.observers_[which].observers) {
      this.prefs_.removeObserver(which, observer);
    }
  }
  this.observers_ = {};
}

/**
 * Helper class that knows how to observe preference changes and
 * invoke a callback when they do
 *
 * @constructor
 * @param callback Function to call when the preference changes
 */
this.G_PreferenceObserver =
function G_PreferenceObserver(callback) {
  this.debugZone = "prefobserver";
  this.callback_ = callback;
}

/**
 * Invoked by the pref system when a preference changes. Passes the
 * message along to the callback.
 *
 * @param subject The nsIPrefBranch that changed
 * @param topic String "nsPref:changed" (aka 
 *              NS_PREFBRANCH_PREFCHANGE_OBSERVER_ID -- but where does it
 *              live???)
 * @param data Name of the pref that changed
 */
G_PreferenceObserver.prototype.observe = function(subject, topic, data) {
  G_Debug(this, "Observed pref change: " + data);
  this.callback_(data);
}

/**
 * XPCOM cruft
 *
 * @param iid Interface id of the interface the caller wants
 */
G_PreferenceObserver.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) || 
      iid.equals(Ci.nsIObserver) ||
      iid.equals(Ci.nsISupportsWeakReference))
    return this;
  throw Components.results.NS_ERROR_NO_INTERFACE;
}

//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\debug.js"

//@line 834 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\debug.js"

// Stubs for the debugging aids scattered through this component.
// They will be expanded if you compile yourself a debug build.

this.G_Debug = function G_Debug(who, msg) { }
this.G_Assert = function G_Assert(who, condition, msg) { }
this.G_Error = function G_Error(who, msg) { }
this.G_debugService = { __noSuchMethod__: function() { } };

//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\alarm.js"


// An Alarm fires a callback after a certain amount of time, or at
// regular intervals. It's a convenient replacement for
// setTimeout/Interval when you don't want to bind to a specific
// window.
//
// The ConditionalAlarm is an Alarm that cancels itself if its callback 
// returns a value that type-converts to true.
//
// Example:
//
//  function foo() { dump('hi'); };
//  new G_Alarm(foo, 10*1000);                   // Fire foo in 10 seconds
//  new G_Alarm(foo, 10*1000, true /*repeat*/);  // Fire foo every 10 seconds
//  new G_Alarm(foo, 10*1000, true, 7);          // Fire foo every 10 seconds
//                                               // seven times
//  new G_ConditionalAlarm(foo, 1000, true); // Fire every sec until foo()==true
//
//  // Fire foo every 10 seconds until foo returns true or until it fires seven
//  // times, whichever happens first.
//  new G_ConditionalAlarm(foo, 10*1000, true /*repeating*/, 7);
//
// TODO: maybe pass an isFinal flag to the callback if they opted to
// set maxTimes and this is the last iteration?


/**
 * Set an alarm to fire after a given amount of time, or at specific 
 * intervals.
 *
 * @param callback Function to call when the alarm fires
 * @param delayMS Number indicating the length of the alarm period in ms
 * @param opt_repeating Boolean indicating whether this should fire 
 *                      periodically
 * @param opt_maxTimes Number indicating a maximum number of times to 
 *                     repeat (obviously only useful when opt_repeating==true)
 */
this.G_Alarm =
function G_Alarm(callback, delayMS, opt_repeating, opt_maxTimes) {
  this.debugZone = "alarm";
  this.callback_ = callback;
  this.repeating_ = !!opt_repeating;
  this.timer_ = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  var type = opt_repeating ? 
             this.timer_.TYPE_REPEATING_SLACK : 
             this.timer_.TYPE_ONE_SHOT;
  this.maxTimes_ = opt_maxTimes ? opt_maxTimes : null;
  this.nTimes_ = 0;

  this.observerServiceObserver_ = new G_ObserverServiceObserver(
                                        'xpcom-shutdown',
                                        BindToObject(this.cancel, this));

  // Ask the timer to use nsITimerCallback (.notify()) when ready
  this.timer_.initWithCallback(this, delayMS, type);
}

/**
 * Cancel this timer 
 */
G_Alarm.prototype.cancel = function() {
  if (!this.timer_) {
    return;
  }

  this.timer_.cancel();
  // Break circular reference created between this.timer_ and the G_Alarm
  // instance (this)
  this.timer_ = null;
  this.callback_ = null;

  // We don't need the shutdown observer anymore
  this.observerServiceObserver_.unregister();
}

/**
 * Invoked by the timer when it fires
 * 
 * @param timer Reference to the nsITimer which fired (not currently 
 *              passed along)
 */
G_Alarm.prototype.notify = function(timer) {
  // fire callback and save results
  var ret = this.callback_();
  
  // If they've given us a max number of times to fire, enforce it
  this.nTimes_++;
  if (this.repeating_ && 
      typeof this.maxTimes_ == "number" 
      && this.nTimes_ >= this.maxTimes_) {
    this.cancel();
  } else if (!this.repeating_) {
    // Clear out the callback closure for TYPE_ONE_SHOT timers
    this.cancel();
  }
  // We don't cancel/cleanup timers that repeat forever until either
  // xpcom-shutdown occurs or cancel() is called explicitly.

  return ret;
}

G_Alarm.prototype.setDelay = function(delay) {
  this.timer_.delay = delay;
}

/**
 * XPCOM cruft
 */
G_Alarm.prototype.QueryInterface = function(iid) {
  if (iid.equals(Components.interfaces.nsISupports) ||
      iid.equals(Components.interfaces.nsITimerCallback))
    return this;

  throw Components.results.NS_ERROR_NO_INTERFACE;
}


/**
 * An alarm with the additional property that it cancels itself if its 
 * callback returns true.
 *
 * For parameter documentation, see G_Alarm
 */
this.G_ConditionalAlarm =
function G_ConditionalAlarm(callback, delayMS, opt_repeating, opt_maxTimes) {
  G_Alarm.call(this, callback, delayMS, opt_repeating, opt_maxTimes);
  this.debugZone = "conditionalalarm";
}

G_ConditionalAlarm.inherits = function(parentCtor) {
  var tempCtor = function(){};
  tempCtor.prototype = parentCtor.prototype;
  this.superClass_ = parentCtor.prototype;
  this.prototype = new tempCtor();
}

G_ConditionalAlarm.inherits(G_Alarm);

/**
 * Invoked by the timer when it fires
 * 
 * @param timer Reference to the nsITimer which fired (not currently 
 *              passed along)
 */
G_ConditionalAlarm.prototype.notify = function(timer) {
  // Call G_Alarm::notify
  var rv = G_Alarm.prototype.notify.call(this, timer);

  if (this.repeating_ && rv) {
    G_Debug(this, "Callback of a repeating alarm returned true; cancelling.");
    this.cancel();
  }
}
//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\cryptohasher.js"


// A very thin wrapper around nsICryptoHash. It's not strictly
// necessary, but makes the code a bit cleaner and gives us the
// opportunity to verify that our implementations give the results that
// we expect, for example if we have to interoperate with a server.
//
// The digest* methods reset the state of the hasher, so it's
// necessary to call init() explicitly after them.
//
// Works only in Firefox 1.5+.
//
// IMPORTANT NOTE: Due to https://bugzilla.mozilla.org/show_bug.cgi?id=321024
// you cannot use the cryptohasher before app-startup. The symptom of doing
// so is a segfault in NSS.

/**
 * Instantiate a new hasher. You must explicitly call init() before use!
 */
this.G_CryptoHasher =
function G_CryptoHasher() {
  this.debugZone = "cryptohasher";
  this.hasher_ = null;
}

G_CryptoHasher.algorithms = {
  MD2: Ci.nsICryptoHash.MD2,
  MD5: Ci.nsICryptoHash.MD5,
  SHA1: Ci.nsICryptoHash.SHA1,
  SHA256: Ci.nsICryptoHash.SHA256,
  SHA384: Ci.nsICryptoHash.SHA384,
  SHA512: Ci.nsICryptoHash.SHA512,
};

/**
 * Initialize the hasher. This function must be called after every call
 * to one of the digest* methods.
 *
 * @param algorithm Constant from G_CryptoHasher.algorithms specifying the
 *                  algorithm this hasher will use
 */ 
G_CryptoHasher.prototype.init = function(algorithm) {
  var validAlgorithm = false;
  for (var alg in G_CryptoHasher.algorithms)
    if (algorithm == G_CryptoHasher.algorithms[alg])
      validAlgorithm = true;

  if (!validAlgorithm)
    throw new Error("Invalid algorithm: " + algorithm);

  this.hasher_ = Cc["@mozilla.org/security/hash;1"]
                 .createInstance(Ci.nsICryptoHash);
  this.hasher_.init(algorithm);
}

/**
 * Update the hash's internal state with input given in a string. Can be
 * called multiple times for incrementeal hash updates.
 *
 * @param input String containing data to hash.
 */ 
G_CryptoHasher.prototype.updateFromString = function(input) {
  if (!this.hasher_)
    throw new Error("You must initialize the hasher first!");

  var stream = Cc['@mozilla.org/io/string-input-stream;1']
               .createInstance(Ci.nsIStringInputStream);
  stream.setData(input, input.length);
  this.updateFromStream(stream);
}

/**
 * Update the hash's internal state with input given in an array. Can be
 * called multiple times for incremental hash updates.
 *
 * @param input Array containing data to hash.
 */ 
G_CryptoHasher.prototype.updateFromArray = function(input) {
  if (!this.hasher_)
    throw new Error("You must initialize the hasher first!");

  this.hasher_.update(input, input.length);
}

/**
 * Update the hash's internal state with input given in a stream. Can be
 * called multiple times from incremental hash updates.
 */
G_CryptoHasher.prototype.updateFromStream = function(stream) {
  if (!this.hasher_)
    throw new Error("You must initialize the hasher first!");

  if (stream.available())
    this.hasher_.updateFromStream(stream, stream.available());
}

/**
 * @returns The hash value as a string (sequence of 8-bit values)
 */ 
G_CryptoHasher.prototype.digestRaw = function() {
  var digest = this.hasher_.finish(false /* not b64 encoded */);
  this.hasher_ = null;
  return digest;
}

/**
 * @returns The hash value as a base64-encoded string
 */ 
G_CryptoHasher.prototype.digestBase64 = function() {
  var digest = this.hasher_.finish(true /* b64 encoded */);
  this.hasher_ = null;
  return digest;
}

/**
 * @returns The hash value as a hex-encoded string
 */ 
G_CryptoHasher.prototype.digestHex = function() {
  var raw = this.digestRaw();
  return this.toHex_(raw);
}

/**
 * Converts a sequence of values to a hex-encoded string. The input is a
 * a string, so you can stick 16-bit values in each character.
 *
 * @param str String to conver to hex. (Often this is just a sequence of
 *            16-bit values)
 *
 * @returns String containing the hex representation of the input
 */ 
G_CryptoHasher.prototype.toHex_ = function(str) {
  var hexchars = '0123456789ABCDEF';
  var hexrep = new Array(str.length * 2);

  for (var i = 0; i < str.length; ++i) {
    hexrep[i * 2] = hexchars.charAt((str.charCodeAt(i) >> 4) & 15);
    hexrep[i * 2 + 1] = hexchars.charAt(str.charCodeAt(i) & 15);
  }
  return hexrep.join('');
}

//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\observer.js"


// A couple of classes to simplify creating observers. 
//
// // Example1:
//
// function doSomething() { ... }
// var observer = new G_ObserverWrapper(topic, doSomething);
// someObj.addObserver(topic, observer);
//
// // Example2: 
//
// function doSomething() { ... }
// new G_ObserverServiceObserver("profile-after-change", 
//                               doSomething,
//                               true /* run only once */);


/**
 * This class abstracts the admittedly simple boilerplate required of
 * an nsIObserver. It saves you the trouble of implementing the
 * indirection of your own observe() function.
 *
 * @param topic String containing the topic the observer will filter for
 *
 * @param observeFunction Reference to the function to call when the 
 *                        observer fires
 *
 * @constructor
 */
this.G_ObserverWrapper = function G_ObserverWrapper(topic, observeFunction) {
  this.debugZone = "observer";
  this.topic_ = topic;
  this.observeFunction_ = observeFunction;
}

/**
 * XPCOM
 */
G_ObserverWrapper.prototype.QueryInterface = function(iid) {
  if (iid.equals(Ci.nsISupports) || iid.equals(Ci.nsIObserver))
    return this;
  throw Components.results.NS_ERROR_NO_INTERFACE;
}

/**
 * Invoked by the thingy being observed
 */
G_ObserverWrapper.prototype.observe = function(subject, topic, data) {
  if (topic == this.topic_)
    this.observeFunction_(subject, topic, data);
}


/**
 * This class abstracts the admittedly simple boilerplate required of
 * observing an observerservice topic. It implements the indirection
 * required, and automatically registers to hear the topic.
 *
 * @param topic String containing the topic the observer will filter for
 *
 * @param observeFunction Reference to the function to call when the 
 *                        observer fires
 *
 * @param opt_onlyOnce Boolean indicating if the observer should unregister
 *                     after it has fired
 *
 * @constructor
 */
this.G_ObserverServiceObserver =
function G_ObserverServiceObserver(topic, observeFunction, opt_onlyOnce) {
  this.debugZone = "observerserviceobserver";
  this.topic_ = topic;
  this.observeFunction_ = observeFunction;
  this.onlyOnce_ = !!opt_onlyOnce;
  
  this.observer_ = new G_ObserverWrapper(this.topic_, 
                                         BindToObject(this.observe_, this));
  this.observerService_ = Cc["@mozilla.org/observer-service;1"]
                          .getService(Ci.nsIObserverService);
  this.observerService_.addObserver(this.observer_, this.topic_, false);
}

/**
 * Unregister the observer from the observerservice
 */
G_ObserverServiceObserver.prototype.unregister = function() {
  this.observerService_.removeObserver(this.observer_, this.topic_);
  this.observerService_ = null;
}

/**
 * Invoked by the observerservice
 */
G_ObserverServiceObserver.prototype.observe_ = function(subject, topic, data) {
  this.observeFunction_(subject, topic, data);
  if (this.onlyOnce_)
    this.unregister();
}

//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\moz\protocol4.js"


// A helper class that knows how to parse from and serialize to
// protocol4. This is a simple, historical format used by some Google
// interfaces, for example the Toolbar (i.e., ancient services).
//
// Protocol4 consists of a newline-separated sequence of name/value
// pairs (strings). Each line consists of the name, the value length,
// and the value itself, all separated by colons. Example:
//
// foo:6:barbaz\n
// fritz:33:issickofdynamicallytypedlanguages\n


/**
 * This class knows how to serialize/deserialize maps to/from their
 * protocol4 representation.
 *
 * @constructor
 */
this.G_Protocol4Parser = function G_Protocol4Parser() {
  this.debugZone = "protocol4";

  this.protocol4RegExp_ = new RegExp("([^:]+):\\d+:(.*)$");
  this.newlineRegExp_ = new RegExp("(\\r)?\\n");
}

/**
 * Create a map from a protocol4 string. Silently skips invalid lines.
 *
 * @param text String holding the protocol4 representation
 * 
 * @returns Object as an associative array with keys and values 
 *          given in text. The empty object is returned if none
 *          are parsed.
 */
G_Protocol4Parser.prototype.parse = function(text) {

  var response = {};
  if (!text)
    return response;

  // Responses are protocol4: (repeated) name:numcontentbytes:content\n
  var lines = text.split(this.newlineRegExp_);
  for (var i = 0; i < lines.length; i++)
    if (this.protocol4RegExp_.exec(lines[i]))
      response[RegExp.$1] = RegExp.$2;

  return response;
}

/**
 * Create a protocol4 string from a map (object). Throws an error on 
 * an invalid input.
 *
 * @param map Object as an associative array with keys and values 
 *            given as strings.
 *
 * @returns text String holding the protocol4 representation
 */
G_Protocol4Parser.prototype.serialize = function(map) {
  if (typeof map != "object")
    throw new Error("map must be an object");

  var text = "";
  for (var key in map) {
    if (typeof map[key] != "string")
      throw new Error("Keys and values must be strings");
    
    text += key + ":" + map[key].length + ":" + map[key] + "\n";
  }
  
  return text;
}

//@line 22 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\nsUrlClassifierLib.js"

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This implements logic for stopping requests if the server starts to return
// too many errors.  If we get MAX_ERRORS errors in ERROR_PERIOD minutes, we
// back off for TIMEOUT_INCREMENT minutes.  If we get another error
// immediately after we restart, we double the timeout and add
// TIMEOUT_INCREMENT minutes, etc.
// 
// This is similar to the logic used by the search suggestion service.

// HTTP responses that count as an error.  We also include any 5xx response
// as an error.
this.HTTP_FOUND                 = 302;
this.HTTP_SEE_OTHER             = 303;
this.HTTP_TEMPORARY_REDIRECT    = 307;

/**
 * @param maxErrors Number of times to request before backing off.
 * @param retryIncrement Time (ms) for each retry before backing off.
 * @param maxRequests Number the number of requests needed to trigger backoff
 * @param requestPeriod Number time (ms) in which maxRequests have to occur to
 *     trigger the backoff behavior (0 to disable maxRequests)
 * @param timeoutIncrement Number time (ms) the starting timeout period
 *     we double this time for consecutive errors
 * @param maxTimeout Number time (ms) maximum timeout period
 */
this.RequestBackoff =
function RequestBackoff(maxErrors, retryIncrement,
                        maxRequests, requestPeriod,
                        timeoutIncrement, maxTimeout) {
  this.MAX_ERRORS_ = maxErrors;
  this.RETRY_INCREMENT_ = retryIncrement;
  this.MAX_REQUESTS_ = maxRequests;
  this.REQUEST_PERIOD_ = requestPeriod;
  this.TIMEOUT_INCREMENT_ = timeoutIncrement;
  this.MAX_TIMEOUT_ = maxTimeout;

  // Queue of ints keeping the time of all requests
  this.requestTimes_ = [];

  this.numErrors_ = 0;
  this.errorTimeout_ = 0;
  this.nextRequestTime_ = 0;
}

/**
 * Reset the object for reuse. This deliberately doesn't clear requestTimes_.
 */
RequestBackoff.prototype.reset = function() {
  this.numErrors_ = 0;
  this.errorTimeout_ = 0;
  this.nextRequestTime_ = 0;
}

/**
 * Check to see if we can make a request.
 */
RequestBackoff.prototype.canMakeRequest = function() {
  var now = Date.now();
  if (now < this.nextRequestTime_) {
    return false;
  }

  return (this.requestTimes_.length < this.MAX_REQUESTS_ ||
          (now - this.requestTimes_[0]) > this.REQUEST_PERIOD_);
}

RequestBackoff.prototype.noteRequest = function() {
  var now = Date.now();
  this.requestTimes_.push(now);

  // We only care about keeping track of MAX_REQUESTS
  if (this.requestTimes_.length > this.MAX_REQUESTS_)
    this.requestTimes_.shift();
}

RequestBackoff.prototype.nextRequestDelay = function() {
  return Math.max(0, this.nextRequestTime_ - Date.now());
}

/**
 * Notify this object of the last server response.  If it's an error,
 */
RequestBackoff.prototype.noteServerResponse = function(status) {
  if (this.isErrorStatus(status)) {
    this.numErrors_++;

    if (this.numErrors_ < this.MAX_ERRORS_)
      this.errorTimeout_ = this.RETRY_INCREMENT_;
    else if (this.numErrors_ == this.MAX_ERRORS_)
      this.errorTimeout_ = this.TIMEOUT_INCREMENT_;
    else
      this.errorTimeout_ *= 2;

    this.errorTimeout_ = Math.min(this.errorTimeout_, this.MAX_TIMEOUT_);
    this.nextRequestTime_ = Date.now() + this.errorTimeout_;
  } else {
    // Reset error timeout, allow requests to go through.
    this.reset();
  }
}

/**
 * We consider 302, 303, 307, 4xx, and 5xx http responses to be errors.
 * @param status Number http status
 * @return Boolean true if we consider this http status an error
 */
RequestBackoff.prototype.isErrorStatus = function(status) {
  return ((400 <= status && status <= 599) ||
          HTTP_FOUND == status ||
          HTTP_SEE_OTHER == status ||
          HTTP_TEMPORARY_REDIRECT == status);
}

//@line 4 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\content\xml-fetcher.js"

// A simple class that encapsulates a request. You'll notice the
// style here is different from the rest of the extension; that's
// because this was re-used from really old code we had. At some
// point it might be nice to replace this with something better
// (e.g., something that has explicit onerror handler, ability
// to set headers, and so on).

/**
 * Because we might be in a component, we can't just assume that
 * XMLHttpRequest exists. So we use this tiny factory function to wrap the
 * XPCOM version.
 *
 * @return XMLHttpRequest object
 */
this.PROT_NewXMLHttpRequest = function PROT_NewXMLHttpRequest() {
  var Cc = Components.classes;
  var Ci = Components.interfaces;
  var request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
  // Need the following so we get onerror/load/progresschange
  request.QueryInterface(Ci.nsIJSXMLHttpRequest);
  return request;
}

/**
 * A helper class that does HTTP GETs and calls back a function with
 * the content it receives. Asynchronous, so uses a closure for the
 * callback.
 *
 * Note, that XMLFetcher is only used for SafeBrowsing, therefore
 * we inherit from nsILoadContext, so we can use the callbacks on the
 * channel to separate the safebrowsing cookie based on a reserved
 * appId.
 * @constructor
 */
this.PROT_XMLFetcher = function PROT_XMLFetcher() {
  this.debugZone = "xmlfetcher";
  this._request = PROT_NewXMLHttpRequest();
  // implements nsILoadContext
  this.appId = Ci.nsIScriptSecurityManager.SAFEBROWSING_APP_ID;
  this.isInBrowserElement = false;
  this.usePrivateBrowsing = false;
  this.isContent = false;
}

PROT_XMLFetcher.prototype = {
  /**
   * Function that will be called back upon fetch completion.
   */
  _callback: null,
  

  /**
   * Fetches some content.
   * 
   * @param page URL to fetch
   * @param callback Function to call back when complete.
   */
  get: function(page, callback) {
    this._request.abort();                // abort() is asynchronous, so
    this._request = PROT_NewXMLHttpRequest();
    this._callback = callback;
    var asynchronous = true;
    this._request.open("GET", page, asynchronous);
    this._request.channel.notificationCallbacks = this;

    // Create a closure
    var self = this;
    this._request.addEventListener("readystatechange", function() {
      self.readyStateChange(self);
    }, false);

    this._request.send(null);
  },

  cancel: function() {
    this._request.abort();
    this._request = null;
  },

  /**
   * Called periodically by the request to indicate some state change. 4
   * means content has been received.
   */
  readyStateChange: function(fetcher) {
    if (fetcher._request.readyState != 4)
      return;

    // If the request fails, on trunk we get status set to
    // NS_ERROR_NOT_AVAILABLE.  On 1.8.1 branch we get an exception
    // forwarded from nsIHttpChannel::GetResponseStatus.  To be consistent
    // between branch and trunk, we send back NS_ERROR_NOT_AVAILABLE for
    // http failures.
    var responseText = null;
    var status = Components.results.NS_ERROR_NOT_AVAILABLE;
    try {
      G_Debug(this, "xml fetch status code: \"" + 
              fetcher._request.status + "\"");
      status = fetcher._request.status;
      responseText = fetcher._request.responseText;
    } catch(e) {
      G_Debug(this, "Caught exception trying to read xmlhttprequest " +
              "status/response.");
      G_Debug(this, e);
    }
    if (fetcher._callback)
      fetcher._callback(responseText, status);
  },

  // nsIInterfaceRequestor
  getInterface: function(iid) {
    return this.QueryInterface(iid);
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIInterfaceRequestor,
                                         Ci.nsISupports,
                                         Ci.nsILoadContext])
};
//@line 25 "e:\hg38\comm-esr38\mozilla\toolkit\components\url-classifier\nsUrlClassifierLib.js"

// Expose this whole component.
var lib = this;

function UrlClassifierLib() {
  this.wrappedJSObject = lib;
}
UrlClassifierLib.prototype.classID = Components.ID("{26a4a019-2827-4a89-a85c-5931a678823a}");
UrlClassifierLib.prototype.QueryInterface = XPCOMUtils.generateQI([]);

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([UrlClassifierLib]);
