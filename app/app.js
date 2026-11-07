// Settle - a client for DeliverableEscrow, an escrow whose release condition is
// written in plain words and paid out in basis points.
//
// Same machinery as any GenLayer client: reads are `gen_call` simulations
// (no wallet needed), writes are signed transactions that travel through
// proposing / committing / revealing before they are accepted. The panel in the
// bottom right reports those stages, and the revert text when consensus says no.

import { createClient, chains } from "./vendor/genlayer.js";

const ENDPOINT = "https://studio.genlayer.com/api";
const CHAIN_ID_HEX = "0xf22f"; // 61999, Studionet
const ZERO = "0x0000000000000000000000000000000000000000";

const $ = (id) => document.getElementById(id);

// The field order of the Escrow struct, so a decoded array can be mapped even
// when the RPC hands back positional values.
const ESCROW_FIELDS = [
  "client", "provider", "amount", "criteria", "deadline", "status",
  "deliverable", "verdict", "payout_bps", "reasoning", "judged_at",
  "escalated", "client_evidence", "final_verdict", "final_bps", "settled_at",
];

const state = {
  address: new URLSearchParams(location.search).get("address") || $("addressInput").value.trim(),
  account: null,
  escrows: [],
  busy: false,
  credit: 0n,
};

const reader = createClient({ chain: chains.studionet, endpoint: ENDPOINT });
let wallet = null;

/* ------------------------------------------------------------------ helpers */

const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "");
const isZero = (a) => !a || String(a).toLowerCase() === ZERO;

/** wei -> "0.05 GEN", without floating point drift. */
function fmtGen(wei) {
  const v = BigInt(wei ?? 0);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (frac ? `${whole}.${frac.slice(0, 4)}` : `${whole}`) + " GEN";
}

/** "0.05" -> 50000000000000000n, digit-exact. */
function parseGen(text) {
  const clean = String(text).trim();
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") {
    throw new Error("amount must be a decimal number of GEN");
  }
  const [w, f = ""] = clean.split(".");
  return BigInt(w || "0") * 10n ** 18n + BigInt((f + "000000000000000000").slice(0, 18));
}

function normaliseEscrow(raw) {
  let obj = raw;
  if (Array.isArray(raw)) {
    obj = {};
    ESCROW_FIELDS.forEach((name, i) => (obj[name] = raw[i]));
  }
  if (obj && typeof obj === "object" && obj.status === undefined && Array.isArray(obj.__values)) {
    obj = {};
    ESCROW_FIELDS.forEach((name, i) => (obj[name] = raw.__values[i]));
  }
  return {
    client: String(obj.client ?? ""),
    provider: String(obj.provider ?? ""),
    amount: BigInt(obj.amount ?? 0),
    criteria: String(obj.criteria ?? ""),
    deadline: Number(obj.deadline ?? 0),
    status: String(obj.status ?? ""),
    deliverable: String(obj.deliverable ?? ""),
    verdict: String(obj.verdict ?? ""),
    payoutBps: Number(obj.payout_bps ?? 0),
    reasoning: String(obj.reasoning ?? ""),
    judgedAt: Number(obj.judged_at ?? 0),
    escalated: Boolean(obj.escalated ?? false),
    clientEvidence: String(obj.client_evidence ?? ""),
    finalVerdict: String(obj.final_verdict ?? ""),
    finalBps: Number(obj.final_bps ?? 0),
    settledAt: Number(obj.settled_at ?? 0),
  };
}

function countdown(deadlineSeconds) {
  if (!deadlineSeconds) return "—";
  const left = deadlineSeconds - Math.floor(Date.now() / 1000);
  if (left <= 0) return "closed";
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const pct = (bps) => `${(Number(bps ?? 0) / 100).toFixed(0)}%`;

/* --------------------------------------------------------------- tx panel */

function txReset(title) {
  $("txlogBody").innerHTML = "";
  $("txlog").classList.add("show");
  txStep(title, "active");
}

function txStep(text, kind = "active", hash) {
  const row = document.createElement("div");
  row.className = "tx-step " + kind;
  row.innerHTML = `<span class="dot"></span><span>${text}${
    hash ? ` <a class="tx-hash" href="https://explorer-studio.genlayer.com/transaction/${hash}" target="_blank" rel="noreferrer">${short(hash)}</a>` : ""
  }</span>`;
  $("txlogBody").appendChild(row);
  $("txlogBody").scrollTop = $("txlogBody").scrollHeight;
  return row;
}

function txDone(previous, text, kind) {
  if (previous) previous.className = "tx-step " + kind;
  txStep(text, kind);
}

/* ------------------------------------------------------------------ wallet */

async function ensureChain() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err?.code !== 4902 && !/Unrecognized chain/i.test(err?.message || "")) throw err;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: "GenLayer Studionet",
          nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
          rpcUrls: ["https://studio.genlayer.com/api"],
          blockExplorerUrls: ["https://explorer-studio.genlayer.com"],
        },
      ],
    });
  }
}

async function connect() {
  if (!window.ethereum) {
    alert("No wallet found. Install MetaMask (or any EIP-1193 wallet) to fund or deliver.");
    return;
  }
  await ensureChain();
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.account = account;
  wallet = createClient({
    chain: chains.studionet,
    endpoint: ENDPOINT,
    provider: window.ethereum,
    account,
  });
  $("connectBtn").textContent = short(account);
  $("connectBtn").classList.add("btn-accent");
  render();
}

/* ------------------------------------------------------------------- reads */

async function loadContract(address) {
  state.address = address;
  $("addressInput").value = address;
  $("explorerLink").href = `https://explorer-studio.genlayer.com/address/${address}`;
  await refresh();
}

async function refresh() {
  try {
    const countRaw = await reader.readContract({
      address: state.address,
      functionName: "escrow_count",
      args: [],
      jsonSafeReturn: true,
    });
    const count = Number(countRaw ?? 0);
    const escrows = [];
    for (let id = 0; id < count; id++) {
      try {
        const raw = await reader.readContract({
          address: state.address,
          functionName: "get_escrow",
          args: [BigInt(id)],
          jsonSafeReturn: true,
        });
        escrows.push({ id, ...normaliseEscrow(raw) });
      } catch {
        /* an unreadable escrow should not break the list */
      }
    }
    state.escrows = escrows.reverse();

    if (state.account) {
      try {
        const c = await reader.readContract({
          address: state.address,
          functionName: "get_credit",
          args: [state.account],
          jsonSafeReturn: true,
        });
        state.credit = BigInt(c ?? 0);
      } catch {
        state.credit = 0n;
      }
    }
    render();
  } catch (err) {
    $("escrowsList").innerHTML = `<p class="empty">Read failed: ${err.message}</p>`;
  }
}

/* ------------------------------------------------------------------ writes */

async function send({ fn, args, value = 0n, label }) {
  if (!wallet || !state.account) {
    alert("Connect a wallet first.");
    return;
  }
  state.busy = true;
  render();
  txReset(label);
  const signing = txStep("waiting for your signature", "active");

  let hash;
  try {
    hash = await wallet.writeContract({
      address: state.address,
      functionName: fn,
      args,
      value,
    });
  } catch (err) {
    txDone(signing, "rejected before sending: " + (err?.shortMessage || err?.message || err), "fail");
    state.busy = false;
    render();
    return;
  }

  txDone(signing, "submitted", "done");
  const pending = txStep("in consensus · submitted", "active", hash);
  const started = Date.now();

  // Poll until the transaction leaves the in-flight states. GenLayer writes are
  // not instant: they are proposed, committed, revealed, then accepted.
  let tx = null;
  let lastStatus = "";
  for (let i = 0; i < 240; i++) {
    try {
      tx = await reader.getTransaction({ hash });
      const status = String(tx?.status ?? "");
      if (status && status !== lastStatus) {
        lastStatus = status;
        if (status !== "ACCEPTED") {
          pending.querySelector("span:last-child").textContent =
            `in consensus · ${status.toLowerCase()} · ${Math.round((Date.now() - started) / 1000)}s`;
        }
      }
      if (["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(status)) {
        break;
      }
    } catch {
      /* transient RPC errors during polling are expected */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const ok = ["ACCEPTED", "FINALIZED"].includes(String(tx?.status ?? ""));
  if (ok) {
    txDone(pending, `accepted in ${Math.round((Date.now() - started) / 1000)}s`, "done");
  } else {
    const detail =
      tx?.consensus_data?.leader_receipt?.[0]?.error ||
      tx?.result_name ||
      tx?.status ||
      "no receipt";
    txDone(pending, "rejected: " + String(detail).slice(0, 220), "fail");
  }

  state.busy = false;
  await refresh();
}

/* ----------------------------------------------------------------- rendering */

function actionButtons(e) {
  const now = Math.floor(Date.now() / 1000);
  const mine = (a) => state.account && String(a).toLowerCase() === String(state.account).toLowerCase();
  const buttons = [];

  if (e.status === "FUNDED") {
    if (now <= e.deadline) {
      if (mine(e.provider)) {
        buttons.push({ label: "Submit deliverable", fn: "submit_deliverable", needsUrl: "Artifact URL (the page validators will read):" });
      }
    } else {
      buttons.push({ label: "Refund expired", fn: "refund_expired", args: [BigInt(e.id)] });
    }
  }
  if (e.status === "DELIVERED") {
    buttons.push({ label: "Judge (round 1)", fn: "judge", args: [BigInt(e.id)] });
  }
  if (e.status === "JUDGED") {
    const open = now <= e.judgedAt + 3600; // escalation window, from the deployment
    if (open && mine(e.client)) {
      buttons.push({ label: "Escalate with counter evidence", fn: "escalate", needsUrl: "Counter evidence URL:" });
    }
    if (!open) {
      buttons.push({ label: "Settle", fn: "settle", args: [BigInt(e.id)] });
    }
  }
  if (e.status === "DISPUTED") {
    buttons.push({ label: "Resolve dispute (round 2)", fn: "resolve_dispute", args: [BigInt(e.id)] });
  }
  return buttons;
}

function escrowCard(e) {
  const el = document.createElement("article");
  el.className = "claim";

  const role = !state.account
    ? ""
    : String(state.account).toLowerCase() === String(e.client).toLowerCase()
      ? " · you are the client"
      : String(state.account).toLowerCase() === String(e.provider).toLowerCase()
        ? " · you are the provider"
        : "";

  const active = !["SETTLED", "REFUNDED"].includes(e.status);
  const clock =
    e.status === "FUNDED" ? `deadline in <code>${countdown(e.deadline)}</code>`
    : e.status === "JUDGED" ? `escalation window <code>${countdown(e.judgedAt + 3600)}</code>`
    : "";

  const verdictBlock =
    e.status === "JUDGED" && e.verdict
      ? `<div class="verdict"><b>${e.verdict}</b> · payout ${pct(e.payoutBps)} · round 1
           ${e.reasoning ? `<div style="margin-top:4px;color:#5a5a62">${escapeHtml(e.reasoning)}</div>` : ""}
         </div>`
      : "";
  const finalBlock =
    ["SETTLED", "REFUNDED"].includes(e.status)
      ? e.status === "REFUNDED"
        ? `<div class="verdict"><b>REFUNDED</b> · the full amount went back to the client</div>`
        : `<div class="verdict"><b>${e.finalVerdict || "SETTLED"}</b> · provider ${pct(e.finalBps)} · client ${pct(10000 - e.finalBps)}
             ${e.reasoning ? `<div style="margin-top:4px;color:#5a5a62">${escapeHtml(e.reasoning)}</div>` : ""}
           </div>`
      : "";

  el.innerHTML = `
    <div class="claim-top">
      <span class="claim-id">#${e.id}</span>
      <span class="status ${e.status}">${e.status || "UNKNOWN"}</span>
      <span class="claim-meta">
        <span>amount <code>${fmtGen(e.amount)}</code></span>
        ${clock ? `<span>${clock}</span>` : ""}
        ${e.status === "SETTLED" ? `<span>provider share <code>${pct(e.finalBps)}</code></span>` : ""}
      </span>
    </div>
    <p class="claim-statement">${escapeHtml(e.criteria)}</p>
    <div class="claim-meta">
      <span>client <code>${short(e.client)}</code></span>
      <span>provider <code>${short(e.provider)}</code>${role}</span>
    </div>
    <p class="claim-evidence">
      ${e.deliverable ? `<a href="${escapeAttr(e.deliverable)}" target="_blank" rel="noreferrer">deliverable: ${hostOf(e.deliverable)}</a>` : ""}
      ${e.clientEvidence ? `<a href="${escapeAttr(e.clientEvidence)}" target="_blank" rel="noreferrer">counter evidence: ${hostOf(e.clientEvidence)}</a>` : ""}
    </p>
    ${verdictBlock}
    ${finalBlock}
    <div class="claim-actions"></div>
  `;

  const actions = el.querySelector(".claim-actions");
  for (const b of actionButtons(e)) {
    const btn = document.createElement("button");
    btn.className = "btn btn-sm" + (b.fn === "create_escrow" || b.needsUrl ? " btn-accent" : "");
    btn.textContent = b.label;
    btn.disabled = state.busy;
    btn.onclick = async () => {
      let args = b.args ?? [BigInt(e.id)];
      if (b.needsUrl) {
        const url = prompt(b.needsUrl);
        if (!url) return;
        args = [...args, url.trim()];
      }
      await send({ fn: b.fn, args, value: 0n, label: `${b.fn} #${e.id}` });
    };
    actions.appendChild(btn);
  }
  if (!actions.children.length && active) {
    actions.innerHTML = `<span class="claim-meta">no action available to you in this state</span>`;
  }
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u.slice(0, 24);
  }
}

function render() {
  const list = $("escrowsList");
  list.innerHTML = "";
  if (!state.escrows.length) {
    list.innerHTML = `<p class="empty">No escrows yet. Fund the first one - write criteria a stranger could judge.</p>`;
  }
  for (const e of state.escrows) list.appendChild(escrowCard(e));

  $("statEscrows").textContent = String(state.escrows.length);
  $("statActive").textContent = String(
    state.escrows.filter((e) => !["SETTLED", "REFUNDED"].includes(e.status)).length
  );
  const locked = state.escrows
    .filter((e) => !["SETTLED", "REFUNDED"].includes(e.status))
    .reduce((acc, e) => acc + e.amount, 0n);
  $("statLocked").textContent = fmtGen(locked);

  $("fundBtn").disabled = state.busy;

  const withdraw = $("withdrawBtn");
  if (withdraw) {
    const credit = state.credit ?? 0n;
    withdraw.hidden = credit === 0n;
    withdraw.textContent = `Withdraw ${fmtGen(credit)}`;
    withdraw.disabled = state.busy;
  }
}

/* -------------------------------------------------------------------- wiring */

$("connectBtn").onclick = () => connect().catch((e) => alert(e.message));
$("reloadBtn").onclick = () => loadContract($("addressInput").value.trim());
$("refreshBtn").onclick = () => refresh();
$("withdrawBtn").onclick = () => send({ fn: "withdraw", args: [], value: 0n, label: "withdraw" });
$("txlogClose").onclick = () => $("txlog").classList.remove("show");

$("composer").onsubmit = async (event) => {
  event.preventDefault();
  const provider = $("provider").value.trim();
  const criteria = $("criteria").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(provider)) return alert("Provider must be a 0x address.");
  if (!criteria) return alert("Write acceptance criteria - that text is the whole release condition.");
  if (provider.toLowerCase() === (state.account || "").toLowerCase()) {
    return alert("Client and provider must be different accounts.");
  }
  let value;
  try {
    value = parseGen($("amount").value);
  } catch (err) {
    return alert(err.message);
  }
  const days = Math.max(1, Math.floor(Number($("days").value) || 3));
  await send({
    fn: "create_escrow",
    args: [provider, criteria, BigInt(days * 86400)],
    value,
    label: "create_escrow",
  });
  $("criteria").value = "";
};

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", (accounts) => {
    state.account = accounts[0] || null;
    wallet = null;
    $("connectBtn").textContent = state.account ? short(state.account) : "Connect wallet";
    render();
  });
}

setInterval(() => {
  // Countdowns are cheap; re-render no more than once every 15 seconds.
  if (Date.now() - (render.last || 0) > 15000) {
    render.last = Date.now();
    render();
  }
}, 5000);

loadContract(state.address);
