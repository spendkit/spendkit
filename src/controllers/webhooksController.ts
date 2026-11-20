import type { AgentCardsApp } from "../createApp.js";
import { unauthorizedError } from "../errors.js";
import { sendJson } from "../lib/http/respond.js";
import { CircleError } from "../lib/clients/circle/CircleClient.js";
import { requireCircleDeposits, requireMidenCallback } from "../lib/utils/requireFeature.js";
import { readBody } from "../lib/middleware/bodyParser.js";
import { DECISIONS } from "../lib/services/SpendIntents.js";
import createControllerMethod from "./utils/createControllerMethod.js";

const header = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Circle deposit webhooks: signed by Circle, verified over the raw body (the `rawBody` middleware).
 * A non-2xx makes Circle retry, so only a bad signature is a 4xx; anything else we could not finish is a 500.
 */
export const circleWebhook = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const circle = requireCircleDeposits(app);
    try {
      const r = await circle.handle(req.rawBody, { signature: header(req.headers["x-circle-signature"]), keyId: header(req.headers["x-circle-key-id"]) });
      if (r.status === "ignored" && !/^type /.test(r.reason)) app.log?.(`circle webhook ignored: ${r.reason}`);
      await app.alerts?.clear("circle-webhook", "Circle webhook handled a delivery again.");
      sendJson(res, 200, { ok: true, status: r.status });
    } catch (e) {
      if (e instanceof CircleError && e.status === 401) {
        app.log?.(`circle webhook refused: ${e.message}`);
        throw unauthorizedError("invalid signature");
      }
      // Anything but a bad signature is ours (Circle API down, ledger error): Circle will retry, and a person should know.
      await app.alerts?.raise("circle-webhook", `Circle webhook failed (Circle will retry): ${(e as Error).message}`);
      throw e;
    }
  });

/** Card-number fields removed from a Miden callback before anything else sees the body. */
const PAN_FIELDS = ["accountNumber", "pan", "cardNumber"];

/**
 * Miden's customer-managed authorization callback (docs/spend-intents.md). Reads the stream itself (never
 * req.rawBody): the body carries the card number in `accountNumber`, which is deleted right after parsing, so no
 * logger, error reporter or later handler can see it. The raw text is never logged or stored.
 * Always 200 with a decision except a bad signature (401: Miden applies its default decision, which must be decline).
 */
export const midenAuthorizationCallback = (app: AgentCardsApp) =>
  createControllerMethod(async (req, res) => {
    const intents = requireMidenCallback(app);
    let body: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse((await readBody(req)).toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      body = v as Record<string, unknown>;
    } catch {
      // No error detail: a parser message can quote the body.
      sendJson(res, 200, DECISIONS.invalidRequest);
      return;
    }
    for (const f of PAN_FIELDS) delete body[f];
    const answer = await intents.handleCallback(body, header(req.headers["signature"]) ?? header(req.headers["x-signature"]));
    if (answer.httpStatus === 401) {
      sendJson(res, 401, { error: "invalid signature" });
      return;
    }
    sendJson(res, 200, answer.body);
  });
