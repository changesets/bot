// inlined from https://unpkg.com/@chadfawcett/probot-serverless-now@1.0.0/index.js
import { createProbot } from "probot";
import { findPrivateKey } from "probot/lib/private-key";
import appFn from "./";

let cert = findPrivateKey();

if (!cert) {
  throw new Error("cert not found");
}

const options = {
  id: Number(process.env.APP_ID),
  secret: process.env.WEBHOOK_SECRET,
  cert
};

const probot = createProbot(options);

probot.load(appFn);

module.exports = probot.server;
