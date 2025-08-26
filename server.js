
// okx-exec-proxy v0.3.0
import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "256kb" }));

const API_KEY = process.env.OKX_API_KEY || "";
const SECRET_KEY = process.env.OKX_SECRET_KEY || "";
const PASSPHRASE = process.env.OKX_PASSPHRASE || "";
const PAPER = process.env.PAPER === "1" ? "1" : "0";

const okx = axios.create({
  baseURL: "https://www.okx.com",
  timeout: 15000,
});

function isoNow() {
  return new Date().toISOString();
}

function sign({ ts, method, path, body = "" }) {
  const prehash = `${ts}${method}${path}${body}`;
  const hmac = crypto.createHmac("sha256", SECRET_KEY);
  hmac.update(prehash);
  return hmac.digest("base64");
}

function headers({ ts, method, path, body }) {
  return {
    "OK-ACCESS-KEY": API_KEY,
    "OK-ACCESS-SIGN": sign({ ts, method, path, body }),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": PASSPHRASE,
    "x-simulated-trading": PAPER,
    "Content-Type": "application/json",
  };
}

async function okxGet(path) {
  const ts = isoNow();
  return okx.get(path, { headers: headers({ ts, method: "GET", path, body: "" })});
}

async function okxPost(path, payload = {}) {
  const ts = isoNow();
  const body = JSON.stringify(payload);
  return okx.post(path, payload, { headers: headers({ ts, method: "POST", path, body })});
}

// Helpers
function parseNetPos(data = []) {
  // Aggregate net position (net mode)
  let net = 0;
  let first = null;
  for (const p of data) {
    if (p.pos && p.instId) {
      first ??= p;
      net += Number(p.pos || 0);
    }
  }
  return {
    open: net !== 0,
    netPosSz: net,
    sample: first || null
  };
}

// ------- Endpoints --------
app.get("/ping", (_, res) => {
  res.json({ ok: true, service: "okx-exec-proxy" });
});

app.get("/debug/env", (_, res) => {
  res.json({
    ok: true,
    hasKey: !!API_KEY,
    hasSecret: !!SECRET_KEY,
    hasPassphrase: !!PASSPHRASE,
    paper: PAPER
  });
});

// Check positions (expects {instId})
app.post("/positions", async (req, res) => {
  try {
    const { instId, instType = "SWAP" } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId required" });
    const path = `/api/v5/account/positions?instType=${instType}&instId=${encodeURIComponent(instId)}`;
    const r = await okxGet(path);
    const parsed = parseNetPos(r.data?.data || []);
    res.json({ ok: true, instId, ...parsed, raw: r.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Place order (supports leverage and TP/SL passthrough)
// Body: { instId, side, ordType="market", tdMode="cross", sz, lever?, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx? }
app.post("/order", async (req, res) => {
  try {
    const {
      instId, side, ordType = "market", tdMode = "cross", sz,
      lever, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, posSide
    } = req.body || {};

    if (!instId || !side || !ordType || !tdMode) {
      return res.status(400).json({ ok: false, error: "instId, side, ordType, tdMode required" });
    }

    // Optional leverage set first
    let leverageNote = null;
    if (lever) {
      const levPayload = { instId, lever: String(lever), mgnMode: tdMode };
      try {
        const lev = await okxPost("/api/v5/account/set-leverage", levPayload);
        leverageNote = lev.data;
      } catch (e) {
        leverageNote = { warn: "set-leverage failed", reason: e?.response?.data || e.message };
      }
    }

    // Build order
    const ord = { instId, side, ordType, tdMode, sz: String(sz || "1") };
    if (posSide) ord.posSide = posSide; // for isolated two-way
    if (tpTriggerPx) ord.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx) ord.tpOrdPx = String(tpOrdPx);
    if (slTriggerPx) ord.slTriggerPx = String(slTriggerPx);
    if (slOrdPx) ord.slOrdPx = String(slOrdPx);

    const r = await okxPost("/api/v5/trade/order", ord);
    res.json({ ok: true, request: ord, response: r.data, leverageNote });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// Close position (market, reduce-only or closePosition flag)
// Body: { instId, tdMode="cross", side?, sz?, all? }
app.post("/close", async (req, res) => {
  try {
    const { instId, tdMode = "cross", all, sz, posSide } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId required" });

    // Inspect current pos to decide side if not provided
    let side = req.body?.side;
    let size = sz;

    if (!side || !size || all) {
      const pos = await okxGet(`/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`);
      const rows = pos.data?.data || [];
      const net = parseNetPos(rows);
      if (!net.open) return res.json({ ok: true, msg: "No open position" });
      size = String(Math.abs(net.netPosSz));
      side = net.netPosSz > 0 ? "sell" : "buy"; // opposite to flatten
    }

    const ord = {
      instId,
      tdMode,
      side,
      ordType: "market",
      reduceOnly: "true",
    };
    if (!all && size) ord.sz = String(size);
    if (posSide) ord.posSide = posSide;

    const r = await okxPost("/api/v5/trade/order", ord);
    res.json({ ok: true, request: ord, response: r.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// Balance (query ?ccy=USDT)
app.get("/balance", async (req, res) => {
  try {
    const ccy = (req.query.ccy || "USDT").toString();
    const r = await okxGet(`/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}`);
    res.json({ ok: true, ccy, data: r.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// Best-effort amend TP/SL for an open position:
// Body: { instId, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx? }
app.post("/amend-tpsl", async (req, res) => {
  const { instId, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx } = req.body || {};
  if (!instId) return res.status(400).json({ ok: false, error: "instId required" });

  try {
    // 1) Try to cancel pending advance algos for this instId
    let cancelNote = null;
    try {
      const pend = await okxGet(`/api/v5/trade/orders-algo-pending?instType=SWAP&instId=${encodeURIComponent(instId)}`);
      const toCancel = (pend.data?.data || [])
        .filter(x => ["take_profit","stop_loss","conditional","trigger"].includes((x.algoType||"").toLowerCase()))
        .map(x => ({ algoId: x.algoId, instId }));
      if (toCancel.length) {
        cancelNote = await okxPost("/api/v5/trade/cancel-advance-algo-orders", toCancel);
      }
    } catch (e) {
      cancelNote = { warn: "cancel advance algos failed", reason: e?.response?.data || e.message };
    }

    // 2) Place new TP/SL as "order-algo" (if provided)
    let placeNote = null;
    if (tpTriggerPx || slTriggerPx) {
      const payload = {
        instId,
        tdMode: "cross",
        // set either/both; use -1 for market fill
        ...(tpTriggerPx ? { tpTriggerPx: String(tpTriggerPx) } : {}),
        ...(tpOrdPx ? { tpOrdPx: String(tpOrdPx) } : {}),
        ...(slTriggerPx ? { slTriggerPx: String(slTriggerPx) } : {}),
        ...(slOrdPx ? { slOrdPx: String(slOrdPx) } : {}),
      };
      // OKX accepts TP/SL fields on normal /trade/order only when creating a new order.
      // For an "amend", best-effort is via /trade/order-algo (conditional).
      try {
        placeNote = await okxPost("/api/v5/trade/order-algo", [{ ...payload, ordType: "conditional" }]);
      } catch (e) {
        placeNote = { warn: "order-algo failed", reason: e?.response?.data || e.message, tried: payload };
      }
    }

    res.json({ ok: true, instId, cancelNote, placeNote });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`okx-exec-proxy running on :${PORT}`);
  console.log(`Your service is live`);
});
