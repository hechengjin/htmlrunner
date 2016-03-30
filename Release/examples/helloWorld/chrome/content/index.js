function hello() {
	alert(111)
		console.log(`index init`)
}

function openHtmlDialog() {
  window.openDialog('chrome://helloword/content/messageWindow.xul', '_blank',
          'all,chrome,dialog=no,status,toolbar',
          'title', {showThreaded: true}, window, [])
}
