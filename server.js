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
  process.env.OKX_API_SECRET ||
  process.env.OKX_SECRET ||
  "";

const PASSPHRASE =
  process.env.OKX_PASSPHRASE ||
  process.env.OKX_API_PASSPHRASE ||
  "";

const PAPER = process.env.PAPER === "1" ? "1" : "0";
const BASE_URL = (process.env.OKX_API_BASEURL || "https://www.okx.com").trim();

// Axios cliente OKX
const okx = axios.create({ baseURL: BASE_URL, timeout: 15000 });

// Utils firma
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
function parseNetPos(rows = []) {
  let net = 0;
  let sample = null;
  for (const p of rows) {
    if (p.instId && p.pos !== undefined) {
      if (!sample) sample = p;
      net += Number(p.pos || 0);
    }
  }
  return { open: net !== 0, netPosSz: net, sample };
}

// -------- Endpoints --------
app.get("/ping", (_, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

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

    const r = await okxGet(`/api/v5/account/positions?instType=${instType}&instId=${encodeURIComponent(instId)}`);
    const parsed = parseNetPos(r.data?.data || []);
    res.json({ ok: true, instId, ...parsed, raw: r.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err.message, detail: err?.response?.data });
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

    // leverage opcional
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

    const ord = { instId, side, ordType, tdMode, sz: String(sz ?? "1") };
    if (posSide) ord.posSide = posSide;
    if (tpTriggerPx) ord.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx) ord.tpOrdPx = String(tpOrdPx);
    if (slTriggerPx) ord.slTriggerPx = String(slTriggerPx);
    if (slOrdPx) ord.slOrdPx = String(slOrdPx);

    const r = await okxPost("/api/v5/trade/order", ord);
    res.json({ ok: true, request: ord, response: r.data, leverageNote });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err.message, detail: err?.response?.data });
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
      const net = parseNetPos(pos.data?.data || []);
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
    res.status(err?.response?.status || 500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// GET /balance?ccy=USDT
app.get("/balance", async (req, res) => {
  try {
    const ccy = (req.query.ccy || "USDT").toString();
    const r = await okxGet(`/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}`);
    res.json({ ok: true, ccy, data: r.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// --- AMEND TP/SL: cancela los existentes y crea nuevos ---
app.post('/amend-tpsl', async (req, res) => {
  try {
    const {
      instId,
      tdMode = 'cross',        // <- requerido por OKX
      posSide,                 // opcional (net/long/short) si usas hedge
      cancelExisting = false,  // true = cancelar TP/SL activos antes de crear
      tpTriggerPx, tpOrdPx,
      slTriggerPx, slOrdPx
    } = req.body || {};

    if (!instId) {
      return res.status(400).json({ ok:false, error:'instId requerido' });
    }

    // 1) Cancelar TP/SL existentes (si se pide)
    let cancelled = [];
    if (cancelExisting) {
      const listPath = `/api/v5/trade/orders-algo-pending?instId=${encodeURIComponent(instId)}&ordType=conditional`;
      const pending = await okxGet(listPath);      // <- GET
      const rows = pending.data?.data || [];

      const ids = rows
        .filter(a => a.instId === instId && (a.tpTriggerPx || a.slTriggerPx))
        .map(a => a.algoId);

      if (ids.length) {
        // OKX exige un array de objetos {algoId, instId}
        const cancelPayload = ids.map(id => ({ algoId: id, instId }));
        const rCancel = await okxPost('/api/v5/trade/cancel-algos', cancelPayload);
        cancelled = rCancel.data?.data || [];
      }
    }

    // 2) Construir nuevo TP/SL sólo con lo que envíes
    const algo = {
      instId,
      ordType: 'conditional',
      tdMode,                  // requerido
      reduceOnly: 'true'       // para que NO abra posición nueva
    };
    if (posSide) algo.posSide = posSide;  // si usas hedge
    if (tpTriggerPx != null) algo.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx     != null) algo.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx != null) algo.slTriggerPx = String(slTriggerPx);
    if (slOrdPx     != null) algo.slOrdPx     = String(slOrdPx);

    // Si no llega ningún nuevo TP/SL, terminamos aquí
    if (!algo.tpTriggerPx && !algo.slTriggerPx) {
      return res.json({ ok:true, msg:'Sin cambios (no se enviaron nuevos TP/SL)', cancelled });
    }

    // IMPORTANTE: OKX requiere ARRAY de objetos
    const place = await okxPost('/api/v5/trade/order-algo', [algo]);

    return res.json({
      ok: true,
      cancelled,
      request: algo,
      response: place.data
    });
  } catch (err) {
    console.error('amend-tpsl error:', err?.response?.data || err?.message || err);
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: err?.message || 'amend-tpsl failed',
      detail: err?.response?.data || null
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
