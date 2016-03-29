"use strict";
let expect = require('expect.js');
let name = "firemail";

describe("在命令行下运行mocha自动运行些测试用例", function() {
    it("The name should be firemail", function() {
        expect(name).to.eql("firemail");
    });
});
