import type { AgentCardsApp } from "../createApp.js";
import { Router } from "../lib/http/Router.js";
import { authorizeUser } from "../lib/middleware/auth.js";
import { jsonBody } from "../lib/middleware/bodyParser.js";
import {
  createAgent, fundAgent, getOverview, reclaimAgent, refresh, revokeAgent, rotateToken, simulateChainDeposit, simulateDeposit,
  submitKyc, updateAgentLimits,
} from "../controllers/ownerController.js";
import {
  decideIntent, decisionOptions, getIntent, getPasskeys, listPendingIntents, loosenOptions, passkeyOptions, registerPasskey,
} from "../controllers/approvalController.js";

const AGENT = "/agents/:agentId([A-Za-z0-9_]+)";
const INTENT = "/intents/:spendId([A-Za-z0-9_]{1,64})";
const DECISION = ":decision(approve|deny)";

/** Mounted at /api/me behind `authorizeUser`, so its paths are relative to /api/me ("" is /api/me itself). */
export const ownerRouter = (app: AgentCardsApp) => {
  const router = new Router();
  router.get("", getOverview(app));
  // A developer-issued session must not mint a permanent token.
  router.post("/token", authorizeUser(app, { ownerTokenOnly: true }), rotateToken(app));
  router.post("/kyc", jsonBody, submitKyc(app));
  router.post("/refresh", refresh(app));
  router.post("/simulate-deposit", jsonBody, simulateDeposit(app));
  router.post("/simulate-chain-deposit", jsonBody, simulateChainDeposit(app));
  router.post("/agents", jsonBody, createAgent(app));
  router.post(`${AGENT}/fund`, jsonBody, fundAgent(app));
  router.post(`${AGENT}/reclaim`, jsonBody, reclaimAgent(app));
  router.post(`${AGENT}/revoke`, jsonBody, revokeAgent(app));
  router.post(`${AGENT}/limits`, jsonBody, updateAgentLimits(app));
  router.post(`${AGENT}/approval-threshold/options`, jsonBody, loosenOptions(app));
  // Human approval of spend intents with the owner's passkey (WebAuthn).
  router.get("/passkeys", getPasskeys(app));
  router.post("/passkeys/options", passkeyOptions(app));
  router.post("/passkeys", jsonBody, registerPasskey(app));
  router.get("/intents/pending", listPendingIntents(app));
  router.get(INTENT, getIntent(app));
  router.post(`${INTENT}/${DECISION}/options`, decisionOptions(app));
  router.post(`${INTENT}/${DECISION}`, jsonBody, decideIntent(app));
  return router;
};
