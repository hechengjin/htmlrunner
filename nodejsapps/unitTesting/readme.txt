运行pathtohere.bat

E:\zhaomokeje\htmlrunner\nodejs\npm npm install -g mocha   找不到去掉  -g 然后用
E:\zhaomokeje\htmlrunner\nodejsapps\unitTesting>E:\zhaomokeje\htmlrunner\nodejsapps\unitTesting\node_modules\.bin\mocha

命令行下进入当前目录
安装expect
E:\zhaomokeje\htmlrunner\nodejs\app\unitTesting>E:\zhaomokeje\htmlrunner\nodejs\npm install expect.js

一、在命令行上运行测试用例
建 test目录，里面建议相应的js文件，这些js文件在运行mocha命令时自动执行，如下：
E:\zhaomokeje\htmlrunner\nodejsapps\unitTesting>mocha


  在命令行下运行mocha自动运行些测试用例
    √ The name should be firemail


  1 passing (17ms)

二、在浏览器中运行
E:\zhaomokeje\htmlrunner\nodejsapps\unitTesting>mocha init BrowseTest
运行上面命令，就会在 BrowseTest 目录下生成index.html文件，以及配套的脚本和样式表。


三、实现邮件发送测试用例
1.BrowseTest\index.html 复制一份改为BrowseTest\mailTest.html
2.安装一个发送邮件的模块 mailer
npm install nodemailer --save
npm uninstall nodemailer

E:\zhaomokeje\htmlrunner\nodejs\npm install mailer
E:\zhaomokeje\htmlrunner\nodejs\npm uninstall mailer

区别： nodemailer和mailer

mailer依赖封装nodemailer
└─┬ mailer@0.6.7
  ├── colors@1.1.2
  └─┬ nodemailer@0.1.20
    └── mimelib-noiconv@0.1.9

使用 nodemailer  http://nodemailer.com/
E:\zhaomokeje\htmlrunner\nodejs\npm install nodemailer
└─┬ nodemailer@2.3.0
  ├─┬ libmime@2.0.3
  │ ├── iconv-lite@0.4.13
  │ ├── libbase64@0.1.0
  │ └── libqp@1.1.0
  ├─┬ mailcomposer@3.6.3
  │ └─┬ buildmail@3.5.2
  │   └── addressparser@1.0.1
  ├─┬ nodemailer-direct-transport@3.0.6
  │ └── smtp-connection@2.3.1
  ├─┬ nodemailer-shared@1.0.4
  │ └── nodemailer-fetch@1.3.0
  ├─┬ nodemailer-smtp-pool@2.5.1
  │ └── nodemailer-wellknown@0.1.7
  ├── nodemailer-smtp-transport@2.4.1
  └─┬ socks@1.1.8
    ├── ip@0.3.3
    └── smart-buffer@1.0.3

https://github.com/andris9  作者
https://github.com/nodemailer  源码  https://github.com/nodemailer/nodemailer

四、增加 emailjs 模块实现邮件收发 http://emailjs.org/
4.1 增加imap模块
E:\zhaomokeje\htmlrunner\nodejs\npm install emailjs-imap-client
└─┬ emailjs-imap-client@2.0.2
  ├── emailjs-addressparser@1.0.1
  ├── emailjs-imap-handler@1.0.0
  ├─┬ emailjs-mime-codec@1.0.2
  │ └── emailjs-stringencoding@1.0.1
  ├─┬ emailjs-tcp-socket@1.0.2
  │ └── node-forge@0.6.39
  └── emailjs-utf7@3.0.1

  运行指定路径下的测试用例 mocha ./test_emailjs
  
