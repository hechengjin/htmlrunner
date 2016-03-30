"use strict";
let expect = require('expect.js');
let nodemailer = require("nodemailer");

describe('sentMail', function() {
  
  

	it('should log in and send mail', function(done) {
		this.timeout(10000)
		let nm = nodemailer.createTransport({
				host: 'smtp.139.com',
				port: 25,
				auth: {
						user: '15313159857@139.com',
						pass: 'Draeagi94'
				},
				ignoreTLS: true,
				logger: false
		});
		
		
		let dateString = (new Date()).toLocaleString() // 2016-03-30 00:25:41
		dateString = dateString.replace(/[- :]/g,'');
    
    let count = 5
    //for (let i = 0; i < count; i++) {
      getMailInfo(dateString, nm).then(function(info) {
      console.log('OK: ' + info);
      console.log('---i:',i)
      // done()
      }, function(error) {
        console.error('error:', error);
        // done()
      });	
    //}
    	
  });
  
  var getMailInfo = function(dateString, nm) {
    var promise = new Promise(function(resolve, reject){
      let mailData = {
				from: '15313159857@139.com',
				to: ['bigdata_fire@hotmail.com'],
				subject: 'html5学习' + dateString,
				date: new Date(),
				messageId: 'www.firemail.wang_' + dateString,
				xMailer: 'aaa',
				text: '一起学习Html5，QQ群：245146134'
      };

      nm.sendMail(mailData, function (err, info) {
        if (err === null) {
          resolve(info);
        } else {
          reject(err);
        }
      });
    });

    return promise;
  };

	
});