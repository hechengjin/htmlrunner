'use strict'
/*
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
*/
const { Log } = require('resource://gre/modules/Log.jsm')
const LOGGER_ID = 'addons.manager'
let console = null
window.onload = function () {
  console = Log.repository.getLogger(LOGGER_ID)
  $('#sendmail').bind('click', function () {
      alert('Test')
  })
}

function sendMail () {
  console.info('111111')
  alert(11)
}
