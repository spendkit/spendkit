import { createServer, type Server, type ServerResponse } from "node:http";
import type { AgentCardsApp } from "./createApp.js";
import type { AppRequest } from "./domain/types/RequestTypes.js";
import { notFoundError, statusOf, tooManyRequestsError } from "./errors.js";
import { sendJson } from "./lib/http/respond.js";
import { clientKey, RateLimiter } from "./lib/middleware/rateLimit.js";
import { requestGuards, type GuardOptions } from "./lib/middleware/requestGuards.js";
import { createRouter } from "./router.js";

export interface ServerOptions extends GuardOptions {
  log?: (m: string) => void;
  /** TRUST_PROXY=1: take the caller's address from X-Forwarded-For (only behind a proxy we run). */
  trustProxy?: boolean;
  /** Failed-auth (401) responses allowed per address per 10 minutes before it is refused outright. Default 30. */
  authFailureLimit?: number;
  /** Signups allowed per address per hour, per kind (owner, merchant, developer). Default 10. */
  signupLimit?: number;
}

/** Paths that never count towards, or are refused by, the failed-auth limit (signed webhooks, health checks). */
const UNLIMITED = /^\/(webhooks\/|healthz$)/;

/**
 * The HTTP server: request guards on every request, then the router (router.ts), then the error handler:
 * an AgentCardsError becomes its status and message; anything else is a logged 500 with no detail.
 */
export function createAppServer(app: AgentCardsApp, opts: ServerOptions): Server {
  const log = opts.log ?? app.log ?? (() => undefined);
  const guard = requestGuards(opts);
  const trustProxy = opts.trustProxy ?? false;
  const router = createRouter(app, { trustProxy, signupLimit: opts.signupLimit });
  // Guessing tokens: after too many 401s from one address, it gets 429 before any token is looked at.
  const authFailures = new RateLimiter(opts.authFailureLimit ?? 30, 10 * 60_000);

  async function handle(req: AppRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    req.path = url.pathname;
    req.originalPath = url.pathname;
    req.query = url.searchParams;
    req.params = {};
    req.body = {};
    req.rawBody = "";
    await guard(req, res);
    if (!UNLIMITED.test(req.path) && authFailures.blocked(clientKey(req, trustProxy))) {
      throw tooManyRequestsError("too many failed sign-ins from this address; try again in a few minutes");
    }
    if (!(await router.handle(req, res))) throw notFoundError("not found");
  }

  return createServer((req, res) => {
    handle(req as AppRequest, res).catch((e: unknown) => {
      const status = statusOf(e);
      if (status === 401 && !UNLIMITED.test(String(req.url ?? "").split("?")[0]!)) authFailures.hit(clientKey(req as AppRequest, trustProxy));
      if (status === 500) log(`500 ${req.method} ${req.url?.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}`);
      if (res.headersSent) return void res.end();
      sendJson(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
    });
  });
}
