"use strict";
let expect = require('expect.js');
let nodemailer = require("nodemailer");

describe('sentMail', function() {
	it('should log in and send mail', function (done) {
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
		
		
		let sub = (new Date()).toLocaleString() // 2016-03-30 00:25:41
		sub = sub.replace(/[- :]/g,'');

		let mailData = {
				from: '15313159857@139.com',
				to: ['bigdata_fire@hotmail.com'],
				subject: '学习Html5 ' + sub,
				date: new Date(),
				messageId: 'abc@def',
				xMailer: 'aaa',
				text: '一起学习Html5，QQ群：245146134'
		};

		nm.sendMail(mailData, function (err, info) {
				expect(err).to.not.exist; // err === null
				done();
		});
});

	
});