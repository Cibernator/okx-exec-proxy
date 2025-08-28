// okx-exec-proxy v3 — server.js (compat vars + baseURL de .env)
// Fuente original del usuario adaptada para Render y OKX (v5)

import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// === Variables de entorno (compatibilidad con distintos nombres) ===
const API_KEY =
  process.env.OKX_API_KEY ||
  process.env.OKX_APIKEY ||
  process.env.OKX_KEY ||
  "";

const SECRET_KEY =
  process.env.OKX_SECRET_KEY ||
  process.env.OKX_API_SECRET ||   // <- Render screenshot
  process.env.OKX_SECRET ||
  "";

const PASSPHRASE =
  process.env.OKX_PASSPHRASE ||
  process.env.OKX_API_PASSPHRASE || // <- Render screenshot
  "";

const PAPER = process.env.PAPER === "1" ? "1" : "0";

const BASE_URL =
  process.env.OKX_API_BASEURL?.trim() || "https://www.okx.com";

// Cliente OKX
const okx = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
});

// Utils
const isoNow = () => new Date().toISOString();

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
    "x-simulated-trading": PAPER, // "1" = paper, "0" = real
    "Content-Type": "application/json",
  };
}

async function okxGet(path) {
  const ts = isoNow();
  return okx.get(path, { headers: headers({ ts, method: "GET", path, body: "" }) });
}

async function okxPost(path, payload = {}) {
  const ts = isoNow();
  const body = JSON.stringify(payload);
  return okx.post(path, payload, { headers: headers({ ts, method: "POST", path, body }) });
}

// Helpers
function parseNetPos(data = []) {
  let net = 0;
  let first = null;
  for (const p of data) {
    if (p.pos && p.instId) {
      if (!first) first = p;
      net += Number(p.pos || 0);
    }
  }
  return { open: net !== 0, netPosSz: net, sample: first || null };
}

// -------- Endpoints --------
app.get("/ping", (_, res) => {
  res.json({ ok: true, service: "okx-exec-proxy" });
});

app.get("/debug/env", (_, res) => {
  res.json({
    ok: true,
    baseURL: BASE_URL,
    hasKey: Boolean(API_KEY),
    hasSecret: Boolean(SECRET_KEY),
    hasPassphrase: Boolean(PASSPHRASE),
    paper: PAPER,
  });
});

// POST /positions  { instId, instType="SWAP" }
app.post("/positions", async (req, res) => {
  try {
    const { instId, instType = "SWAP" } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId required" });

    const path = `/api/v5/account/positions?instType=${instType}&instId=${encodeURIComponent(instId)}`;
    const r = await okxGet(path);
    const parsed = parseNetPos(r.data?.data || []);
    res.json({ ok: true, instId, ...parsed, raw: r.data });
  } catch (err) {
    res
      .status(err?.response?.status || 500)
      .json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// POST /order
// Body: { instId, side, ordType="market", tdMode="cross", sz, lever?, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx?, posSide? }
app.post("/order", async (req, res) => {
  try {
    const {
      instId, side, ordType = "market", tdMode = "cross", sz,
      lever, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, posSide
    } = req.body || {};

    if (!instId || !side || !ordType || !tdMode)
      return res.status(400).json({ ok: false, error: "instId, side, ordType, tdMode required" });

    // 1) leverage (opcional)
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

    // 2) orden
    const ord = { instId, side, ordType, tdMode, sz: String(sz ?? "1") };
    if (posSide) ord.posSide = posSide;
    if (tpTriggerPx) ord.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx) ord.tpOrdPx = String(tpOrdPx);
    if (slTriggerPx) ord.slTriggerPx = String(slTriggerPx);
    if (slOrdPx) ord.slOrdPx = String(slOrdPx);

    const r = await okxPost("/api/v5/trade/order", ord);
    res.json({ ok: true, request: ord, response: r.data, leverageNote });
  } catch (err) {
    res
      .status(err?.response?.status || 500)
      .json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// POST /close  { instId, tdMode="cross", side?, sz?, all?, posSide? }
app.post("/close", async (req, res) => {
  try {
    const { instId, tdMode = "cross", all, sz, posSide } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId required" });

    let side = req.body?.side;
    let size = sz;

    if (!side || !size || all) {
      const pos = await okxGet(`/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`);
      const rows = pos.data?.data || [];
      const net = parseNetPos(rows);
      if (!net.open) return res.json({ ok: true, msg: "No open position" });
      size = String(Math.abs(net.netPosSz));
      side = net.netPosSz > 0 ? "sell" : "buy"; // opuesto para cerrar
    }

    const ord = { instId, tdMode, side, ordType: "market", reduceOnly: "true" };
    if (!all && size) ord.sz = String(size);
    if (posSide) ord.posSide = posSide;

    const r = await okxPost("/api/v5/trade/order", ord);
    res.json({ ok: true, request: ord, response: r.data });
  } catch (err) {
    res
      .status(err?.response?.status || 500)
      .json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// GET /balance?ccy=USDT
app.get("/balance", async (req, res) => {
  try {
    const ccy = (req.query.ccy || "USDT").toString();
    const r = await okxGet(`/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}`);
    res.json({ ok: true, ccy, data: r.data });
  } catch (err) {
    res
      .status(err?.response?.status || 500)
      .json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// --- AMEND TP/SL: cancela los existentes y crea nuevos ---
app.post('/amend-tpsl', async (req, res) => {
  try {
    const { instId, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, cancelExisting } = req.body || {};
    if (!instId) return res.status(400).json({ ok:false, error:'instId requerido' });

    // 1) Si piden cancelar los existentes, listarlos y cancelarlos
    if (cancelExisting) {
      // Trae algos pendientes (TP/SL se listan aquí con ordType=conditional)
      const list = await okxGET('/api/v5/trade/orders-algo-pending', { instId, ordType: 'conditional' });
      const ids = (list.data || [])
        .filter(a => a.instId === instId && (a.tpTriggerPx || a.slTriggerPx))
        .map(a => a.algoId);

      if (ids.length) {
        const payload = ids.map(id => ({ algoId: id, instId }));
        await okxPOST('/api/v5/trade/cancel-algos', payload);
      }
    }

    // 2) Construir nuevo TP/SL (solo los campos que envíen)
    const algoPayload = {
      instId,
      ordType: 'conditional',
      // reduceOnly para que no abra nuevas posiciones
      reduceOnly: 'true'
    };
    if (tpTriggerPx) algoPayload.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx)     algoPayload.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx) algoPayload.slTriggerPx = String(slTriggerPx);
    if (slOrdPx)     algoPayload.slOrdPx     = String(slOrdPx);

    // Si no se manda nada nuevo, responder sin crear
    if (!algoPayload.tpTriggerPx && !algoPayload.slTriggerPx) {
      return res.json({ ok:true, msg:'Sin cambios (no se enviaron nuevos TP/SL)' });
    }

    const place = await okxPOST('/api/v5/trade/order-algo', [algoPayload]);

    return res.json({
      ok: true,
      request: { instId, cancelExisting, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx },
      response: place
    });
  } catch (err) {
    console.error('amend-tpsl error:', err?.response?.data || err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.response?.data || err?.message || 'amend-tpsl failed'
    });
  }
});


// Arranque
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`okx-exec-proxy running on :${PORT}`);
  console.log(`env: baseURL=${BASE_URL} paper=${PAPER} key=${API_KEY ? "✓" : "×"} pass=${PASSPHRASE ? "✓" : "×"}`);
  console.log(`Your service is live`);
});
