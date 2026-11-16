import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey } from "../src/lib/middleware/rateLimit.js";
import { ownerTokenIdleDays } from "../src/bootstrap.js";
import type { AppRequest } from "../src/domain/types/RequestTypes.js";

test("RateLimiter: allows the limit per window, refuses after, and resets when the window passes", () => {
  let t = 0;
  const l = new RateLimiter(3, 1_000, () => t);
  assert.deepEqual([l.hit("a"), l.hit("a"), l.hit("a"), l.hit("a")], [true, true, true, false]);
  assert.equal(l.blocked("a"), true);
  assert.equal(l.hit("b"), true, "keys are counted separately");
  t = 1_000;
  assert.equal(l.blocked("a"), false);
  assert.equal(l.hit("a"), true);
});

test("clientKey: the socket address unless TRUST_PROXY says a proxy of ours sets X-Forwarded-For", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as AppRequest;
  assert.equal(clientKey(req, false), "127.0.0.1", "a caller cannot pick its own key by sending the header");
  assert.equal(clientKey(req, true), "203.0.113.9");
});

test("OWNER_TOKEN_IDLE_DAYS: 30 by default, 0 turns expiry off, nonsense is refused", () => {
  assert.equal(ownerTokenIdleDays({}), 30);
  assert.equal(ownerTokenIdleDays({ OWNER_TOKEN_IDLE_DAYS: "0" }), 0);
  assert.equal(ownerTokenIdleDays({ OWNER_TOKEN_IDLE_DAYS: "7" }), 7);
  assert.throws(() => ownerTokenIdleDays({ OWNER_TOKEN_IDLE_DAYS: "-1" }), /OWNER_TOKEN_IDLE_DAYS/);
  assert.throws(() => ownerTokenIdleDays({ OWNER_TOKEN_IDLE_DAYS: "soon" }), /OWNER_TOKEN_IDLE_DAYS/);
});
