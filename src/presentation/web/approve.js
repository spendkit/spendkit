// Owner approval of one spend intent (/app/approve/<spendId>), signed with the owner's passkey (WebAuthn).
// The agent writes the intent's context: it is only ever put on the page as text (textContent), never as HTML.
// Auth: the dashboard's owner token (localStorage), or a developer-issued session passed as #session=... (kept only
// in memory, and stripped from the address bar at once, as on /connect).
(() => {
  "use strict";

  const TOKEN_KEY = "agentCardsUserToken";
  const hash = /(?:^#|&)session=([^&]+)/.exec(location.hash);
  const token = hash ? decodeURIComponent(hash[1]) : localStorage.getItem(TOKEN_KEY);
  if (hash) history.replaceState(null, "", location.pathname + location.search);
  const spendId = decodeURIComponent(location.pathname.split("/").pop() || "");
  const view = document.getElementById("view");

  const usd = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  /** Builds an element. Children are nodes or strings (strings become text nodes, never markup). */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  function show(...nodes) { view.replaceChildren(...nodes); }
  function toast(text, kind) {
    const m = document.getElementById("msg");
    m.textContent = text; m.className = "show " + (kind || "");
    clearTimeout(toast.t); toast.t = setTimeout(() => (m.className = ""), 5000);
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { authorization: "Bearer " + token, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch { throw new Error("Couldn't reach the server. Check your connection and try again."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(typeof data.error === "string" && data.error ? data.error : "Something went wrong. Please try again."); e.status = res.status; throw e; }
    return data;
  }

  // ---------- WebAuthn JSON <-> binary (uses the browser's own parsers where it has them) ----------
  const fromB64u = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; };
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const PKC = window.PublicKeyCredential;

  function creationOptions(o) {
    if (PKC?.parseCreationOptionsFromJSON) return PKC.parseCreationOptionsFromJSON(o);
    return { ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })) };
  }
  function requestOptions(o) {
    if (PKC?.parseRequestOptionsFromJSON) return PKC.parseRequestOptionsFromJSON(o);
    return { ...o, challenge: fromB64u(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })) };
  }
  function credentialJSON(c) {
    if (typeof c.toJSON === "function") return c.toJSON();
    const r = c.response, out = { id: c.id, rawId: toB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults?.() || {}, response: { clientDataJSON: toB64u(r.clientDataJSON) } };
    if (r.attestationObject) { out.response.attestationObject = toB64u(r.attestationObject); out.response.transports = r.getTransports?.() || []; }
    if (r.authenticatorData) { out.response.authenticatorData = toB64u(r.authenticatorData); out.response.signature = toB64u(r.signature); if (r.userHandle) out.response.userHandle = toB64u(r.userHandle); }
    return out;
  }
  function passkeyError(e) {
    if (e && e.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out. Nothing was decided.";
    if (e && e.name === "InvalidStateError") return "This device already has a passkey for Spendkit.";
    return e?.message || "The passkey step failed.";
  }

  // ---------- screens ----------
  function signedOut() {
    show(el("h1", null, "Sign in to approve"),
      el("p", { class: "muted" }, "Open your Spendkit dashboard in this browser first, then come back to this link."),
      el("p", null, el("a", { class: "btn primary", href: "/app" }, "Open the dashboard")));
  }

  function failed(message) {
    show(el("h1", null, "Payment approval"), el("div", { class: "state bad" }, message), el("p", null, el("a", { href: "/app" }, "Back to the dashboard")));
  }

  function details(i) {
    // What binds the card payment comes first: the most it may charge, which merchant, MCC, uses and expiry. These are
    // the fields your passkey signs. The agent's own words (merchant name, reason) are shown below them, marked as such.
    const usual = i.amountCents < i.maxAmountCents ? `The agent expects ${usd(i.amountCents)}; the rest covers tips or exchange-rate changes.` : null;
    const uses = i.usesAllowed === 1 ? "One payment" : `Up to ${i.usesAllowed} payments`;
    return el("section", { class: "card flat" },
      el("div", { class: "muted small" }, `${i.agentName} wants to pay up to`),
      el("div", { class: "amount" }, usd(i.maxAmountCents), usual && el("small", null, usual)),
      el("dl", { class: "kv" },
        el("dt", null, "Card pays merchants matching"), el("dd", null, i.merchantMatch ? el("code", null, i.merchantMatch) : "(any name)"),
        i.merchantAcceptorId && el("dt", null, "Merchant ID"), i.merchantAcceptorId && el("dd", null, el("code", null, i.merchantAcceptorId)),
        el("dt", null, "Merchant category"), el("dd", null, i.mcc ? el("code", null, i.mcc) : "Any the agent is allowed"),
        el("dt", null, "Uses"), el("dd", null, uses),
        el("dt", null, "Expires"), el("dd", null, el("time", { datetime: i.expiresAt }, when(i.expiresAt)), " ", el("span", { class: "muted", id: "left" })),
      ),
      el("div", { class: "ctx-label" }, el("span", null, "How the agent describes it"), el("span", null, "written by the agent")),
      el("dl", { class: "kv" }, el("dt", null, "Merchant"), el("dd", null, i.merchant), el("dt", null, "Agent"), el("dd", null, i.agentName)),
      el("div", { class: "ctx" }, i.context || "(no reason given)"),
    );
  }

  function decided(i) {
    const d = i.decision?.decision || (i.approval === "approved" ? "approved" : null);
    if (d === "approved") return el("div", { class: "state ok" }, el("b", null, "Approved. "), "The agent can now complete this payment until it expires.");
    if (d === "denied") return el("div", { class: "state bad" }, el("b", null, "Denied. "), "The money held for it has gone back to the agent's balance.");
    if (i.status === "expired") return el("div", { class: "state" }, "This request expired before anyone decided. Nothing was paid.");
    if (i.approval === "none") return el("div", { class: "state" }, "This payment did not need your approval.");
    return el("div", { class: "state" }, `This request is no longer waiting for a decision (${i.status}).`);
  }

  let timer = null;
  function countdown(expiresAt, onExpire) {
    clearInterval(timer);
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      const left = document.getElementById("left");
      if (ms <= 0) { clearInterval(timer); onExpire(); return; }
      const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
      if (left) left.textContent = m >= 60 ? `(in ${Math.floor(m / 60)} h ${m % 60} min)` : `(in ${m}:${String(s).padStart(2, "0")})`;
    };
    tick(); timer = setInterval(tick, 1000);
  }

  async function render() {
    if (!token) return signedOut();
    let intent, keys;
    try {
      [intent, keys] = await Promise.all([api("GET", `/api/me/intents/${encodeURIComponent(spendId)}`), api("GET", "/api/me/passkeys")]);
    } catch (e) {
      if (e.status === 401) return signedOut();
      return failed(e.status === 404 ? "We couldn't find this payment request on your account." : e.message);
    }
    const waiting = intent.approval === "pending" && intent.status === "processing" && !intent.decision && new Date(intent.expiresAt) > new Date();
    if (!waiting) { clearInterval(timer); return show(el("h1", null, "Payment approval"), details(intent), decided(intent)); }

    const body = [el("h1", null, "Approve this payment?"), details(intent)];
    if (!PKC || !navigator.credentials) {
      body.push(el("div", { class: "state bad" }, "This browser can't use passkeys. Open this link on a phone or computer that supports them."));
    } else if (!keys.hasPasskey) {
      const setup = el("button", { class: "accent", type: "button", onclick: () => enrol(setup) }, "Set up a passkey");
      body.push(el("section", { class: "card flat" },
        el("h3", null, "First, set up a passkey"),
        el("p", { class: "note" }, "Approvals are signed with a passkey on this device (Face ID, Touch ID, Windows Hello or a security key). You set it up once."),
        setup));
    } else {
      const approve = el("button", { class: "accent", type: "button", onclick: () => decide("approve", [approve, deny]) }, "Approve with passkey");
      const deny = el("button", { class: "deny", type: "button", onclick: () => decide("deny", [approve, deny]) }, "Deny");
      body.push(el("div", { class: "actions" }, deny, approve),
        el("p", { class: "note" }, "Your passkey signs these exact details: the most the card may pay, the merchant it must match, the category, the number of uses and the expiry, along with what the agent wrote. We keep the signature as a record."));
    }
    show(...body);
    countdown(intent.expiresAt, render);
  }

  async function enrol(btn) {
    btn.disabled = true;
    try {
      const options = await api("POST", "/api/me/passkeys/options");
      const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
      await api("POST", "/api/me/passkeys", { credential: credentialJSON(cred) });
      toast("Passkey set up.", "ok");
      await render();
    } catch (e) {
      btn.disabled = false;
      toast(passkeyError(e), "bad");
    }
  }

  async function decide(decision, buttons) {
    buttons.forEach((b) => (b.disabled = true));
    try {
      const { options } = await api("POST", `/api/me/intents/${encodeURIComponent(spendId)}/${decision}/options`);
      const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
      await api("POST", `/api/me/intents/${encodeURIComponent(spendId)}/${decision}`, { credential: credentialJSON(cred) });
      toast(decision === "approve" ? "Approved." : "Denied.", decision === "approve" ? "ok" : "");
    } catch (e) {
      toast(passkeyError(e), "bad");
    }
    await render();
  }

  render();
})();
