运行pathtohere.bat
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


