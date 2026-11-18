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
  /** What the proxy refused, for tests and logs. "host:port (reason)". */
  readonly refused: readonly string[];
  /** Closes the context and the proxy. */
  close(): Promise<void>;
}

const WEB_PORTS = new Set([80, 443]);
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

async function startProxy(check: (host: string, port: number) => Promise<string>, refused: string[], log?: (m: string) => void) {
  const refuse = (what: string, why: string) => {
    refused.push(`${what} (${why})`);
    log?.(`checkout browser: refused ${what} (${why})`);
  };
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  };

  const server = http.createServer(async (req, res) => {
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
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: u.host };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const up = http.request({ host: ip, port, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });

  server.on("connect", async (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    track(sock);
    sock.on("error", () => undefined);
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
    const up = net.connect(a.port, ip, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    track(up);
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
  const proxy = await startProxy(makeCheck(opts), refused, opts.log);
  let context: BrowserContext;
  try {
    // An empty bypass list, and Playwright adds <-loopback>, so localhost goes through the proxy too.
    context = await browser.newContext({ ...contextOptions, proxy: { server: proxy.url, bypass: "" } });
  } catch (e) {
    await proxy.close();
    throw e;
  }
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
    refused,
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
