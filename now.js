// inlined from https://unpkg.com/@chadfawcett/probot-serverless-now@1.0.0/index.js

const { createProbot } = require("probot");
const { findPrivateKey } = require("probot/lib/private-key");
const appFn = require("./");

process.env.PRIVATE_KEY =
  process.env.NOW_GITHUB_COMMIT_REF === "master"
    ? process.env.PROD_PRIVATE_KEY
    : process.env.DEV_PRIVATE_KEY;

const options = {
  id:
    process.env.NOW_GITHUB_COMMIT_REF === "master"
      ? process.env.PROD_APP_ID
      : process.env.DEV_APP_ID,
  secret:
    process.env.NOW_GITHUB_COMMIT_REF === "master"
      ? process.env.PROD_WEBHOOK_SECRET
      : process.env.DEV_WEBHOOK_SECRET,
  cert: findPrivateKey()
};

const probot = createProbot(options);

probot.load(appFn);

module.exports = probot.server;
