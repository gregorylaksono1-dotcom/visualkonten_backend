const { response } = require("../utils");

exports.handleGetHello = async () => response(200, { message: "Hello World from BikinAi.com backend!" });
