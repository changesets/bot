// inlined from https://unpkg.com/@chadfawcett/probot-serverless-now@1.0.0/index.js
const { createProbot } = require("probot");
const { findPrivateKey } = require("probot/lib/private-key");
const appFn = require("./").default;

const options = {
  id: process.env.APP_ID,
  secret: process.env.WEBHOOK_SECRET,
  cert: findPrivateKey()
};

const probot = createProbot(options);

probot.load(appFn);

module.exports = probot.server;
