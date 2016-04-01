function hello() {
	alert(111)
}

function openHtmlDialog() {
  window.openDialog('chrome://firemail/content/js/cards/testSentMail.xul', '_blank',
          'all,chrome,dialog=no,status,toolbar',
          'title',null, window, [])
}
