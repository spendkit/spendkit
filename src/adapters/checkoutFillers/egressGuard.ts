/**
 * The fence around a checkout filler's browser. The page it opens comes from an agent (and so, in the end, from a
 * model), and it runs in our server's browser, so two things must hold for the whole attempt, redirects included:
 *
 * 1. Nothing the page loads may reach this machine or a private network. Every connection (navigations, redirect
 *    hops, subresources, fetches, websockets, in every frame) goes through a small proxy here, which resolves the
 *    name itself, refuses private, loopback, link-local and metadata addresses and non-web ports, and connects to the
 *    address it checked (so a DNS answer cannot change between the check and the connection). Playwright's route()
 *    is not enough on its own: it sees only the first request of a redirect chain, and only host names.
 * 2. Until the pay button is pressed, the top-level page stays on the hosts the swap vetted. A page that sends the
 *    browser elsewhere first is stopped before a card can be typed into it. After submission it may go anywhere
 *    public: that is the merchant's own success page.
 *
 * The one exception to 1 is the start host itself when it is literally private (a local test shop): SwapInteractor
 * only lets such a URL through when the operator listed it (SWAP_INSECURE_HOSTS / SWAP_TEST_HOSTS).
 */

import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { FillResult } from "./CheckoutFiller.js";
import { isPrivateHost } from "./formScan.js";
import { isPrivateAddress } from "../../lib/utils/netAddress.js";

export interface EgressGuardOptions {
  /** The checkout URL the filler opens. */
  startUrl: string;
  /** Hosts (with port, as URL.host) the top-level page may be on before submission. The start host always is. */
  navHosts?: string[];
  /** DNS, for tests. Returns every address for the name. */
  resolve?: (host: string) => Promise<string[]>;
  /** Hosts only, never page content. */
  log?: (msg: string) => void;
}

export interface GuardedContext {
  context: BrowserContext;
  /** Call as the pay button is pressed: from then on the page may leave the vetted hosts (never the network fence). */
  submitted(): void;
  /** Why the guard stopped the page, if it did. Hosts only, card-free. */
  readonly violation: string | undefined;
  /** The proxy's address (no credential), for tests. */
  readonly proxyUrl: string;
  /** What the proxy refused, for tests and logs. "host:port (reason)". */
  readonly refused: readonly string[];
  /**
   * Call immediately before typing any card field. Throws (and stops the page) if, before submission, the top-level
   * page is not on a vetted host. Synchronous, so nothing can run between the check and the keystrokes it guards
   * being queued; framenavigated alone could land a beat late.
   */
  assertVetted(page: Page): void;
  /** Closes the context and the proxy. */
  close(): Promise<void>;
}

/**
 * Chromium flags for a checkout browser. WebRTC's UDP does not go through an HTTP proxy, so it is turned off except
 * through the proxy (which has no UDP), and local addresses are not handed to the page.
 */
export const CHECKOUT_BROWSER_ARGS: readonly string[] = [
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-features=WebRtcHideLocalIpsWithMdns",
];

/** Launch the browser a filler uses when none is injected. */
export async function launchCheckoutBrowser(headless = true): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless, args: [...CHECKOUT_BROWSER_ARGS] });
}

/** Runs in every frame before the page's own scripts: no WebRTC at all, whatever browser we were handed. */
const NO_WEBRTC = `(() => {
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCIceCandidate", "RTCSessionDescription"]) {
    try { Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
})();`;

const WEB_PORTS = new Set([80, 443]);
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_CONNECTIONS = 64;
/** Never forwarded by a proxy (RFC 9110 7.6.1), plus our own credential. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"];

export function stripHopByHop<T extends Record<string, unknown>>(h: T): T {
  const out: Record<string, unknown> = { ...h };
  const listed = String(h["connection"] ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const k of [...HOP_BY_HOP, ...listed]) delete out[k];
  return out as T;
}
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const hostOf = (raw: string): string | undefined => {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

const bare = (h: string) => h.replace(/^\[|\]$/g, "").toLowerCase();

/** "host:port" or "[v6]:port" -> parts. */
function splitAuthority(a: string): { host: string; port: number } | undefined {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(a);
  return m ? { host: bare(m[1]!), port: Number(m[2]) } : undefined;
}

async function defaultResolve(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

class Refused extends Error {}

/** The proxy. Returns the address to connect to, or throws Refused. */
function makeCheck(opts: EgressGuardOptions) {
  const resolve = opts.resolve ?? defaultResolve;
  const start = (() => {
    try {
      return new URL(opts.startUrl);
    } catch {
      return undefined;
    }
  })();
  // Only a start host that is itself private is exempt; a public name is always checked by what it resolves to.
  // A loopback test shop is the same server under any loopback name on its port (the fixtures serve their card
  // iframes from localhost while the page is on 127.0.0.1, the way real checkouts use a second origin); any other
  // port on this machine stays refused.
  const exempt = start && isPrivateHost(start.host)
    ? (() => {
      const host = bare(start.hostname);
      return { host, hosts: LOOPBACK.has(host) ? LOOPBACK : new Set([host]), port: Number(start.port || (start.protocol === "https:" ? 443 : 80)) };
    })()
    : undefined;
  return async (host: string, port: number): Promise<string> => {
    host = bare(host);
    if (exempt && exempt.hosts.has(host) && port === exempt.port) {
      // Connect to the start host itself, whichever spelling the page used.
      const addrs = await resolve(exempt.host).catch(() => []);
      if (!addrs[0]) throw new Refused("does not resolve");
      return addrs[0];
    }
    if (!WEB_PORTS.has(port)) throw new Refused("port");
    if (isPrivateHost(host.includes(":") ? `[${host}]` : host)) throw new Refused("private host");
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch {
      throw new Refused("does not resolve");
    }
    if (addrs.length === 0) throw new Refused("does not resolve");
    if (addrs.some(isPrivateAddress)) throw new Refused("private address");
    return addrs[0]!;
  };
}

async function startProxy(
  check: (host: string, port: number) => Promise<string>,
  refused: string[],
  cred: { username: string; password: string },
  log?: (m: string) => void,
) {
  // Only the browser this context runs knows the credential; anything else on this machine that finds the port gets 407.
  const expected = Buffer.from(`Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`);
  const authed = (req: http.IncomingMessage) => {
    const got = Buffer.from(String(req.headers["proxy-authorization"] ?? ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const CHALLENGE = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="checkout"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
  const refuse = (what: string, why: string) => {
    refused.push(`${what} (${why})`);
    log?.(`checkout browser: refused ${what} (${why})`);
  };
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.setTimeout(IDLE_TIMEOUT_MS, () => s.destroy());
    s.on("close", () => sockets.delete(s));
  };
  /** Outbound connections open now; past the cap a request is refused rather than queued. */
  let open = 0;
  const reserve = (): (() => void) | undefined => {
    if (open >= MAX_CONNECTIONS) return undefined;
    open++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        open--;
      }
    };
  };

  const server = http.createServer(async (req, res) => {
    if (!authed(req)) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="checkout"', connection: "close" }).end();
      return;
    }
    // Plain http, as an absolute URL.
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(u.port || 80);
    if (u.protocol !== "http:") {
      refuse(u.protocol, "scheme");
      res.writeHead(403).end();
      return;
    }
    let ip: string;
    try {
      ip = await check(u.hostname, port);
    } catch (e) {
      refuse(`${bare(u.hostname)}:${port}`, e instanceof Refused ? e.message : "error");
      res.writeHead(403).end();
      return;
    }
    const release = reserve();
    if (!release) {
      refuse(`${bare(u.hostname)}:${port}`, "too many connections");
      res.writeHead(503).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...stripHopByHop(req.headers), host: u.host };
    const up = http.request({ host: ip, port, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false, agent: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, stripHopByHop(r.headers));
      r.pipe(res);
    });
    const connectTimer = setTimeout(() => up.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    up.on("socket", (s) => {
      s.once("connect", () => clearTimeout(connectTimer));
      s.setTimeout(IDLE_TIMEOUT_MS, () => up.destroy(new Error("idle")));
    });
    up.on("close", () => {
      clearTimeout(connectTimer);
      release();
    });
    up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    res.on("close", () => up.destroy());
    req.pipe(up);
  });

  server.on("connect", async (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    track(sock);
    sock.on("error", () => undefined);
    if (!authed(req)) {
      sock.end(CHALLENGE);
      return;
    }
    const a = splitAuthority(req.url ?? "");
    if (!a) {
      sock.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    let ip: string;
    try {
      ip = await check(a.host, a.port);
    } catch (e) {
      refuse(`${a.host}:${a.port}`, e instanceof Refused ? e.message : "error");
      sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const release = reserve();
    if (!release) {
      refuse(`${a.host}:${a.port}`, "too many connections");
      sock.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    const up = net.connect({ port: a.port, host: ip, timeout: CONNECT_TIMEOUT_MS }, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    // Until connected, the timeout is the connect timeout; after, the idle one.
    up.once("connect", () => up.setTimeout(IDLE_TIMEOUT_MS));
    up.on("timeout", () => up.destroy());
    sockets.add(up);
    up.on("close", () => {
      sockets.delete(up);
      release();
    });
    up.on("error", () => sock.destroy());
    sock.on("close", () => up.destroy());
  });

  // A plain-http websocket would arrive here; wss goes through CONNECT and is checked there.
  server.on("upgrade", (_req, sock: net.Socket) => {
    refuse("ws upgrade", "plain websocket");
    sock.destroy();
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
      server.closeAllConnections?.();
    }),
  };
}

/** A fresh browser context behind the fence. Close it with the returned close(), not context.close(). */
export async function openGuardedContext(
  browser: Browser,
  opts: EgressGuardOptions,
  contextOptions: Parameters<Browser["newContext"]>[0] = {},
): Promise<GuardedContext> {
  const refused: string[] = [];
  const cred = { username: randomBytes(12).toString("hex"), password: randomBytes(24).toString("hex") };
  const proxy = await startProxy(makeCheck(opts), refused, cred, opts.log);
  let made: BrowserContext | undefined;
  try {
    // An empty bypass list, and Playwright adds <-loopback>, so localhost goes through the proxy too.
    made = await browser.newContext({ ...contextOptions, proxy: { server: proxy.url, bypass: "", ...cred } });
    await made.addInitScript(NO_WEBRTC);
  } catch (e) {
    await made?.close().catch(() => undefined);
    await proxy.close();
    throw e;
  }
  const context = made;
  const startHost = hostOf(opts.startUrl);
  const allowed = new Set([...(opts.navHosts ?? []).map((h) => h.toLowerCase()), ...(startHost ? [startHost] : [])]);
  let armed = true;
  let violation: string | undefined;
  const stop = (page: Page, host: string) => {
    if (violation) return;
    violation = `the checkout page went to ${host} before the card was submitted; stopped`;
    opts.log?.(`checkout browser: ${violation}`);
    void page.close().catch(() => undefined);
  };
  const offsite = (raw: string) => {
    const h = hostOf(raw);
    return h !== undefined && !allowed.has(h) ? h : undefined;
  };

  // Before submission: a top-level navigation off the vetted hosts is refused before it is sent...
  await context.route("**/*", (route) => {
    const r = route.request();
    if (armed && r.isNavigationRequest() && r.frame().parentFrame() === null) {
      const h = offsite(r.url());
      if (h) {
        const page = r.frame().page();
        stop(page, h);
        return route.abort("blockedbyclient");
      }
    }
    return route.fallback();
  });
  // ...and one that lands there anyway (a redirect hop, which route() does not see) stops the page.
  const watch = (page: Page) => page.on("framenavigated", (frame) => {
    if (!armed || frame !== page.mainFrame()) return;
    const h = offsite(frame.url());
    if (h) stop(page, h);
  });
  context.on("page", watch);

  return {
    context,
    submitted: () => {
      armed = false;
    },
    get violation() {
      return violation;
    },
    assertVetted: (page: Page) => {
      if (page.isClosed()) throw new Error(violation ?? "the checkout page was closed");
      if (!armed) return;
      const url = page.mainFrame().url();
      const h = hostOf(url);
      if (h === undefined || !allowed.has(h)) {
        stop(page, h ?? "a non-web page");
        throw new Error(violation);
      }
    },
    refused,
    proxyUrl: proxy.url,
    close: async () => {
      await context.close().catch(() => undefined);
      await proxy.close();
    },
  };
}

/**
 * A filler's result, unless the guard stopped the page before submission: then it is an error naming where the page
 * tried to go, whatever the filler made of the closed page.
 */
export function guarded(guard: GuardedContext, r: FillResult): FillResult {
  return guard.violation && !r.submitted ? { outcome: "error", submitted: false, detail: guard.violation } : r;
}
