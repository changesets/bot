import { createNodeMiddleware, createProbot } from "probot";

import app from "../../index";

// Requires:
// - APP_ID
// - PRIVATE_KEY
// - WEBHOOK_SECRET
const probot = createProbot();

export default createNodeMiddleware(app, {
  probot,
  webhooksPath: "/api/webhook",
});
