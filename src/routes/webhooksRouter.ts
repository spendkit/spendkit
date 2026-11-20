import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { rawBody } from "../lib/middleware/bodyParser.js";
import { requireCircleDeposits } from "../lib/utils/requireFeature.js";
import { circleWebhook, midenAuthorizationCallback } from "../controllers/webhooksController.js";
import { requireMidenCallback } from "../lib/utils/requireFeature.js";

export const webhooksRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.post(
    "/circle",
    () => void requireCircleDeposits(app), // 404 before reading the body when Circle is off
    rawBody,
    circleWebhook(app),
  );
  // No body middleware: the controller reads the stream and strips the card number first.
  router.post("/miden/authorization", () => void requireMidenCallback(app), midenAuthorizationCallback(app));
  return router;
};
