import type { AgentCardsApp } from "../createApp.js";
import { sendJson } from "../lib/http/respond.js";
import createControllerMethod from "./utils/createControllerMethod.js";
import { forbiddenError } from "../errors.js";
import type { ApprovalLoosening } from "../lib/interactors/CardholderInteractor.js";
import { ownerAuth } from "./approvalController.js";

/* Owner API (`Authorization: Bearer uk_...` or a developer-issued `us_` session). `req.callerId` is the user. */

export const signup = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await app.cardholders.signup(req.body.email));
  });

export const getOverview = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await app.cardholders.overview(req.callerId!));
  });

export const rotateToken = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await app.cardholders.rotateToken(req.callerId!));
  });

export const submitKyc = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 200, await app.cardholders.submitKyc(req.callerId!, req.body));
  });

export const refresh = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    await app.cardholders.refresh(req.callerId!);
    sendJson(res, 200, await app.cardholders.overview(req.callerId!));
  });

export const simulateDeposit = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    await app.cardholders.simulateDeposit(req.callerId!, req.body.amountCents);
    sendJson(res, 202, { ok: true });
  });

export const simulateChainDeposit = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 202, { ok: true, ...(await app.cardholders.simulateChainDeposit(req.callerId!, req.body.id)) });
  });

export const createAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    sendJson(res, 201, await app.cardholders.createAgent(req.callerId!, req.body));
  });

export const fundAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    await app.cardholders.fundAgent(req.callerId!, req.params.agentId!, req.body.amountCents, req.body.key);
    sendJson(res, 200, { ok: true });
  });

export const reclaimAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    await app.cardholders.reclaimAgent(req.callerId!, req.params.agentId!, req.body.amountCents);
    sendJson(res, 200, { ok: true });
  });

export const revokeAgent = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    await app.cardholders.revokeAgent(req.callerId!, req.params.agentId!);
    sendJson(res, 200, { ok: true });
  });

export const updateAgentLimits = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const userId = req.callerId!;
    // Raising or switching off the approval threshold: the owner's passkey once they have one (on every route,
    // including a developer-issued us_ session), else only the owner's own uk_ token. See ApprovalInteractor.
    const authorizeLoosen = async (c: ApprovalLoosening) => {
      if (app.approvals) return app.approvals.authorizeLoosen(userId, ownerAuth(req), c, req.body.credential);
      if (ownerAuth(req) !== "owner_token") throw forbiddenError("raising or switching off approval needs the owner's own token");
    };
    sendJson(res, 200, await app.cardholders.updateAgentLimits(userId, req.params.agentId!, req.body, { authorizeLoosen }));
  });
