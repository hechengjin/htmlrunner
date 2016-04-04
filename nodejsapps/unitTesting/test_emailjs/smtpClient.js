"use strict";
let expect = require('expect.js')
let SmtpClient = require('emailjs-smtp-client')
// let SmtpClient = require('../../node_modules/emailjs-smtp-client'),

describe('SmtpClient', function() {
	let smtp
	before((done) => {
		smtp = new SmtpClient('smtp.139.com', 25, {
			useSecureTransport: false,
			auth: {
				user: '15313159857@139.com',
				pass: 'Draeagi94'
			}
    });
		// smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    // smtp.oncert = function() {};
    smtp.connect();
    smtp.onidle = done;
  });

	it('onready', (done) => {
		this.timeout(100000)
    smtp.useEnvelope({
        from: '15313159857@139.com',
        to: ['15313159857@139.com']
    });
		smtp.onready = function(){
			console.log('ready....')
	    smtp.send("Subject: test\r\n");
			smtp.send("\r\n");
	    smtp.send("一起学习Html5，QQ群：245146134 呵呵");
	    smtp.end();
			//
		}
		smtp.ondone = function(success) {
        console.log('success:', success)
				smtp.onclose = done;
        smtp.quit();
    };

		smtp.onerror = function(err) {
        console.log('error:', err.message)
        smtp.onclose = done;
        smtp.quit();
    };
  });


	after((done) => {
      smtp.close()
				done()
  });

});
