var { serverless } = require("@chadfawcett/probot-serverless-now");
const appFn = require("./");
module.exports = serverless(appFn);
