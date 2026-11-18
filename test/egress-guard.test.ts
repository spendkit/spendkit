import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { CHECKOUT_BROWSER_ARGS, launchCheckoutBrowser, openGuardedContext, stripHopByHop, type GuardedContext } from "../src/adapters/checkoutFillers/egressGuard.js";

// A checkout page (the vetted start host, a local test shop) tries every way it can think of to make the server's
// browser reach an internal service. The internal service counts what reaches it: it must stay at zero.

const skip = process.env.SKIP_BROWSER === "1";
let shop: http.Server, internal: http.Server;
let SHOP = "", INTERNAL_PORT = 0;
const internalHits: string[] = [];
let browser: import("playwright-core").Browser;

const page = (body: string) => `<!doctype html><html><body><h1>shop</h1>${body}</body></html>`;

before(async () => {
  if (skip) return;
  internal = http.createServer((req, res) => {
    internalHits.push(req.url ?? "");
    res.end("secret");
  });
  internal.on("upgrade", (req, sock: net.Socket) => {
    internalHits.push(`ws ${req.url}`);
    sock.destroy();
  });
  await new Promise<void>((ok) => internal.listen(0, "127.0.0.1", ok));
  INTERNAL_PORT = (internal.address() as AddressInfo).port;
  const I = `127.0.0.1:${INTERNAL_PORT}`;

  shop = http.createServer((req, res) => {
    const send = (html: string) => res.writeHead(200, { "content-type": "text/html" }).end(html);
    switch (req.url) {
      case "/ok": return send(page(""));
      case "/redirect-internal": return res.writeHead(302, { location: `http://${I}/via-redirect` }).end();
      case "/redirect-chain": return res.writeHead(302, { location: "/redirect-internal" }).end();
      case "/subresources": return send(page(`
        <img src="http://${I}/img">
        <iframe src="http://${I}/frame"></iframe>
        <script>
          const go = (u) => fetch(u, { mode: "no-cors" }).catch(() => {});
          go("http://${I}/fetch");
          go("http://localhost:${INTERNAL_PORT}/localhost");
          go("http://[::1]:${INTERNAL_PORT}/v6");
          go("http://rebind.test:${INTERNAL_PORT}/odd-port");
          go("http://rebind.test/rebind");
          go("https://rebind.test/rebind-tls");
          try { new WebSocket("ws://${I}/ws"); } catch {}
          try { new WebSocket("wss://rebind.test/wss"); } catch {}
          go("/redirect-internal");
          setTimeout(() => (document.title = "done"), 1500);
        </script>`));
      case "/rtc": return send(page(`<iframe srcdoc="<p>in</p>"></iframe>`));
      case "/hop": return res.writeHead(200, { "content-type": "text/plain", connection: "x-private", "x-private": "1", "x-public": "1" }).end("hop");
      case "/leave": return send(page(`<script>location.href = "http://elsewhere.test/collect";</script>`));
      case "/leave-allowed": return send(page(`<script>location.href = "http://second.test/next";</script>`));
      default: return res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => shop.listen(0, "127.0.0.1", ok));
  SHOP = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;
  browser = await (await import("playwright-core")).chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((ok) => shop?.close(ok));
  await new Promise((ok) => internal?.close(ok));
});

const resolved: string[] = [];
/** DNS for the test: the made-up names all answer with this machine, the way a rebinding attacker's would. */
const resolve = async (h: string) => {
  resolved.push(h);
  if (net.isIP(h)) return [h];
  if (h === "localhost" || h.endsWith(".test")) return ["127.0.0.1"];
  throw new Error("NXDOMAIN");
};

async function open(path: string, navHosts?: string[]): Promise<{ g: GuardedContext; p: import("playwright-core").Page }> {
  const g = await openGuardedContext(browser, { startUrl: `${SHOP}${path}`, resolve, ...(navHosts ? { navHosts } : {}) });
  const p = await g.context.newPage();
  return { g, p };
}

test("guard: the vetted local start host itself loads", { skip }, async () => {
  const { g, p } = await open("/ok");
  try {
    await p.goto(`${SHOP}/ok`);
    assert.equal(await p.textContent("h1"), "shop");
    assert.equal(g.violation, undefined);
  } finally {
    await g.close();
  }
});

test("guard: a redirect from the vetted page to an internal address is refused, also two hops in", { skip }, async () => {
  const before = internalHits.length;
  for (const path of ["/redirect-internal", "/redirect-chain"]) {
    const { g, p } = await open(path);
    try {
      await p.goto(`${SHOP}${path}`).catch(() => undefined);
      assert.ok(g.refused.some((r) => r.startsWith(`127.0.0.1:${INTERNAL_PORT}`)), `refused: ${g.refused.join(", ")}`);
    } finally {
      await g.close();
    }
  }
  assert.deepEqual(internalHits.slice(before), [], "nothing reached the internal service");
});

test("guard: subresources, fetches, frames, websockets, other names for this machine and a rebinding name are all refused", { skip }, async () => {
  const before = internalHits.length;
  const { g, p } = await open("/subresources");
  try {
    await p.goto(`${SHOP}/subresources`);
    await p.waitForFunction(() => document.title === "done", undefined, { timeout: 10_000 });
    const why = g.refused.join(", ");
    for (const want of [`127.0.0.1:${INTERNAL_PORT} (port)`, `localhost:${INTERNAL_PORT}`, `::1:${INTERNAL_PORT}`, `rebind.test:${INTERNAL_PORT} (port)`, "rebind.test:80 (private address)", "rebind.test:443 (private address)"]) {
      assert.ok(g.refused.some((r) => r.startsWith(want)), `${want} not refused; refused: ${why}`);
    }
    assert.equal(g.violation, undefined, "subresources are not top-level navigations");
  } finally {
    await g.close();
  }
  assert.deepEqual(internalHits.slice(before), [], "nothing reached the internal service");
});

test("guard: before submission the page cannot leave the vetted hosts; the request is never sent", { skip }, async () => {
  resolved.length = 0;
  const { g, p } = await open("/leave");
  try {
    await p.goto(`${SHOP}/leave`).catch(() => undefined);
    for (let i = 0; i < 50 && !g.violation; i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(g.violation ?? "", /elsewhere\.test.*before the card was submitted/);
    assert.ok(p.isClosed(), "the page was stopped");
    assert.ok(!resolved.includes("elsewhere.test"), "the browser never even looked the host up");
  } finally {
    await g.close();
  }
});

test("guard: a host on the swap's list may be navigated to (still fenced from the network); after submission any host may", { skip }, async () => {
  const listed = await open("/leave-allowed", ["second.test"]);
  try {
    await listed.p.goto(`${SHOP}/leave-allowed`).catch(() => undefined);
    for (let i = 0; i < 30 && !listed.g.refused.some((r) => r.startsWith("second.test")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(listed.g.violation, undefined);
    assert.ok(listed.g.refused.some((r) => r.startsWith("second.test:80 (private address)")), listed.g.refused.join(", "));
  } finally {
    await listed.g.close();
  }

  const paid = await open("/ok");
  try {
    await paid.p.goto(`${SHOP}/ok`);
    paid.g.submitted();
    await paid.p.evaluate(() => (location.href = "http://elsewhere.test/thanks")).catch(() => undefined);
    for (let i = 0; i < 30 && !paid.g.refused.some((r) => r.startsWith("elsewhere.test")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(paid.g.violation, undefined, "after the pay button, the merchant's success page may be anywhere public");
    assert.ok(paid.g.refused.some((r) => r.startsWith("elsewhere.test:80 (private address)")), "but still not this machine");
  } finally {
    await paid.g.close();
  }
});

test("guard: no WebRTC in the page or its frames, so nothing can go around the proxy over UDP", { skip }, async () => {
  const { g, p } = await open("/rtc");
  try {
    await p.goto(`${SHOP}/rtc`);
    const probe = () => {
      const w = window as unknown as Record<string, unknown>;
      let made = "no";
      try {
        new (w.RTCPeerConnection as new () => unknown)();
        made = "yes";
      } catch {}
      return { rtc: typeof w.RTCPeerConnection, webkit: typeof w.webkitRTCPeerConnection, made };
    };
    assert.deepEqual(await p.evaluate(probe), { rtc: "undefined", webkit: "undefined", made: "no" });
    const frame = p.frames().find((f) => f !== p.mainFrame());
    assert.ok(frame, "the iframe loaded");
    assert.deepEqual(await frame.evaluate(probe), { rtc: "undefined", webkit: "undefined", made: "no" });
    // The page cannot put it back.
    assert.equal(await p.evaluate(() => {
      try {
        (window as unknown as Record<string, unknown>).RTCPeerConnection = function () {};
      } catch {}
      return typeof (window as unknown as Record<string, unknown>).RTCPeerConnection;
    }), "undefined");
  } finally {
    await g.close();
  }
});

test("guard: a browser the fillers launch themselves carries the WebRTC flags and still works behind the fence", { skip }, async () => {
  assert.ok(CHECKOUT_BROWSER_ARGS.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  const own = await launchCheckoutBrowser(true);
  try {
    const g = await openGuardedContext(own, { startUrl: `${SHOP}/rtc`, resolve });
    try {
      const p = await g.context.newPage();
      await p.goto(`${SHOP}/rtc`);
      assert.equal(await p.textContent("h1"), "shop");
      assert.equal(await p.evaluate(() => typeof (window as unknown as Record<string, unknown>).RTCPeerConnection), "undefined");
    } finally {
      await g.close();
    }
  } finally {
    await own.close();
  }
});

test("guard: the proxy answers 407 to anyone without this context's credential, plain http and CONNECT alike", { skip }, async () => {
  const before = internalHits.length;
  const { g } = await open("/ok");
  try {
    const { hostname, port } = new URL(g.proxyUrl);
    const raw = (head: string) => new Promise<string>((ok, fail) => {
      const s = net.connect(Number(port), hostname, () => s.write(head));
      let got = "";
      s.on("data", (d) => (got += d));
      s.on("end", () => ok(got));
      s.on("close", () => ok(got));
      s.on("error", fail);
      s.setTimeout(5_000, () => s.destroy());
    });
    const plain = await raw(`GET ${SHOP}/ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(plain, /^HTTP\/1\.1 407/);
    assert.match(plain, /proxy-authenticate: Basic/i);
    const wrong = await raw(`CONNECT ${new URL(SHOP).host} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("a:b").toString("base64")}\r\n\r\n`);
    assert.match(wrong, /^HTTP\/1\.1 407/);
    assert.match(wrong, /Proxy-Authenticate: Basic/);
    // The browser itself got through (it answered the challenge): the earlier tests load pages over http and CONNECT.
  } finally {
    await g.close();
  }
  assert.deepEqual(internalHits.slice(before), []);
});

test("guard: assertVetted throws before a card is typed on a page off the vetted hosts, and not after submission", { skip }, async () => {
  const { g, p } = await open("/ok");
  try {
    await p.goto(`${SHOP}/ok`);
    g.assertVetted(p);
    // A top-level page the route handler cannot see (no web host at all).
    await p.goto("data:text/html,<input>").catch(() => undefined);
    assert.throws(() => g.assertVetted(p), /before the card was submitted/);
    assert.ok(g.violation);
  } finally {
    await g.close();
  }
  const paid = await open("/ok");
  try {
    await paid.p.goto(`${SHOP}/ok`);
    paid.g.submitted();
    await paid.p.goto("data:text/html,<p>thanks</p>").catch(() => undefined);
    paid.g.assertVetted(paid.p);
    assert.equal(paid.g.violation, undefined);
  } finally {
    await paid.g.close();
  }
});

test("guard: hop-by-hop headers are not passed along, including those the Connection header names", { skip }, async () => {
  assert.deepEqual(
    stripHopByHop({ connection: "close, X-Secret", "keep-alive": "5", te: "trailers", "transfer-encoding": "chunked", upgrade: "h2c", trailer: "x", "proxy-authorization": "Basic x", "proxy-connection": "keep-alive", "x-secret": "1", accept: "*/*" }),
    { accept: "*/*" },
  );
  const { g, p } = await open("/ok");
  try {
    await p.goto(`${SHOP}/ok`);
    const h = await p.evaluate(async () => {
      const r = await fetch("/hop");
      return { priv: r.headers.get("x-private"), pub: r.headers.get("x-public"), body: await r.text() };
    });
    assert.deepEqual(h, { priv: null, pub: "1", body: "hop" });
  } finally {
    await g.close();
  }
});
