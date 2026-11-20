import type { AgentCardsApp } from "../createApp.js";
import type { AppRequest } from "../domain/types/RequestTypes.js";
import type { Decision, OwnerAuth } from "../lib/interactors/ApprovalInteractor.js";
import { sendJson } from "../lib/http/respond.js";
import { bearer } from "../lib/middleware/auth.js";
import { requireApprovals } from "../lib/utils/requireFeature.js";
import createControllerMethod from "./utils/createControllerMethod.js";

/* Owner passkeys and human approval of spend intents. Mounted under /api/me behind `authorizeUser`. */

/** How the caller reached the owner API. Only a uk_ bearer counts as the owner's own token. */
export const ownerAuth = (req: AppRequest): OwnerAuth => (bearer(req)?.startsWith("uk_") ? "owner_token" : "session");
const decisionOf = (req: AppRequest): Decision => (req.params.decision === "approve" ? "approve" : "deny");

export const getPasskeys = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireApprovals(app).passkeys(req.callerId!));
  });

export const passkeyOptions = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireApprovals(app).registrationOptions(req.callerId!));
  });

export const registerPasskey = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await requireApprovals(app).register(req.callerId!, ownerAuth(req), req.body.credential));
  });

export const listPendingIntents = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, { intents: await requireApprovals(app).listPending(req.callerId!) });
  });

export const getIntent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireApprovals(app).getIntent(req.callerId!, req.params.spendId!));
  });

export const decisionOptions = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireApprovals(app).decisionOptions(req.callerId!, req.params.spendId!, decisionOf(req)));
  });

export const decideIntent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireApprovals(app).decide(req.callerId!, req.params.spendId!, decisionOf(req), req.body.credential));
  });

export const loosenOptions = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await requireApprovals(app).loosenOptions(req.callerId!, req.params.agentId!, req.body.approvalAboveCents));
  });
