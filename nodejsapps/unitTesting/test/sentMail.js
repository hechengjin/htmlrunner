"use strict";
let expect = require('expect.js');
let nodemailer = require("nodemailer");


describe('sentMail', function() {



	it('should log in and send mail', function(done) {
		this.timeout(100000)
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


		// let dateString = (new Date()).toLocaleString() // 2016-03-30 00:25:41
		// dateString = dateString.replace(/[- :]/g,'');
    let myDate = new Date()
    let dateString = myDate.toLocaleString()
    dateString = dateString + '.'

    //方法一 通过回调  adding a callback (usually named done)  to it() Mocha will know that it should wait for completion.
    /*
    getMailInfo(dateString, nm).then(function(info) {
      console.log('OK: ' + JSON.stringify(info));
      done()
    }, function(error) {
      console.error('error:', error);
      done()
    });
    */
    //方法二 function()不加done参数 直接返回promise
    //return getMailInfo(dateString, nm)

    //方法三 如果等待多个异步操作都完成再返回
    /*
    let count = 1
    for (let i = 0; i < count; i++) {
      getMailInfo(dateString, nm).then(function(info) {
      console.log('OK: ' + i + ' '+ JSON.stringify(info))
      // done()
      }, function(error) {
        console.error('error:', error);
        // done()
      });
    }
    */
    //方法四  通过周期性执行mocha ??
    // mocha file1 file2 file3 // 命令后面紧跟测试脚本的路径和文件名，可以指定多个测试脚本。
    // mocha // 默认只执行 test 子目录下面第一层的测试用例，不会执行更下层的用例。
    // mocha --recursive   // test 子目录下面所有的测试用例----不管在哪一层----都会执行。
    // mocha -h //查看更多支持的命令 http://www.tuicool.com/articles/3mIfIb

    //异步测试
    /*
    Mocha默认每个测试用例最多执行2000毫秒，如果到时没有得到结果，就报错。对于涉及异步操作的测试用例，
    这个时间往往是不够的，需要用 -t 或 --timeout 参数指定超时门槛。
    // Mocha默认会高亮显示超过75毫秒的测试用例，可以用 -s 或 --slow 调整这个参数。
    // mocha -t 5000 timeout.test.js // 需要用 -t 或 --timeout 参数，改变默认的超时设置。
    */

    //按定义时间间隔发送邮件(如每秒钟发一个)
    //setInterval setTimeout
    setInterval(() => {
      console.log(`kkkkkkkkkkkkkkkk`)
      getMailInfo(dateString, nm).then(function(info) {
      console.log('OK: ' + i + ' '+ JSON.stringify(info))
      done()
      }, function(error) {
        console.error('error:', error);
        done()
      });
    }, 1000);

  });

  var getMailInfo = function(dateString, nm) {
    var promise = new Promise(function(resolve, reject){
      let myDate = new Date()
      let milliseconds = myDate.getMilliseconds()
      let mailData = {
				from: '15313159857@139.com',
				to: ['bigdata_fire@hotmail.com'],
				subject: 'html5学习' + dateString + milliseconds,
				date: new Date(),
				messageId: 'www.firemail.wang_' + dateString + milliseconds,
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
