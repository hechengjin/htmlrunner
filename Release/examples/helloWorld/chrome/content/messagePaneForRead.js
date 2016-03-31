"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Log.jsm");
const LOGGER_ID = "addons.manager";
let logger
window.onload = function () {
  logger = Log.repository.getLogger(LOGGER_ID);
  logger.info($(document))  
}
