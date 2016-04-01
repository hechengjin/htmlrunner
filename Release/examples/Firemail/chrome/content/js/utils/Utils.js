const { require } = Components.utils.import('resource://gre/modules/commonjs/toolkit/require.js', {})
const { XPCOMUtils } = require('resource://gre/modules/XPCOMUtils.jsm')
const { Class } = require('sdk/core/heritage')

// const { createRequire } = require('chrome://shell/content/RequireUtils.js') // console //  is not found
// const Observer = require('chrome://shell/content/Observer.js')  //  is not found
// const shell = require('chrome://shell/content/os/shell.js') // is not found

/*
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const {Cc, Ci, Cu} = require('chrome')

const { Services } = require('resource://gre/modules/Services.jsm')
const { OS } = require('resource://gre/modules/osfile.jsm')
Cu.import('resource://gre/modules/ctypes.jsm')

const { Task: { spawn } } = require('resource://gre/modules/Task.jsm')
*/
