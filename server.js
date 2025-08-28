// okx-exec-proxy v3 — server.js
// Ligero proxy para OKX (v5). Listo para Render/Node 18+.

import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// === ENV (acepta varios nombres por compatibilidad) ===
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

// --- Cliente HTTP OKX ---
const okx = axios.create({ baseURL: BASE_URL, timeout: 15000 });

// --- Utils firma OKX ---
const isoNow = () => new Date().toISOString();

function sign({ ts, method, path, body = "" }) {
  const prehash = `${ts}${method}${path}${body}`;
  return crypto.createHmac("sha256", SECRET_KEY).update(prehash).digest("base64");
}

function buildHeaders({ ts, method, path, body }) {
  return {
    "OK-ACCESS-KEY": API_KEY,
    "OK-ACCESS-SIGN": sign({ ts, method, path, body }),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": PASSPHRASE,
    "x-simulated-trading": PAPER, // "1" paper, "0" real
    "Content-Type": "application/json",
  };
}

async function okxGet(path) {
  const ts = isoNow();
  return okx.get(path, { headers: buildHeaders({ ts, method: "GET", path, body: "" }) });
}

async function okxPost(path, payload = {}) {
  const ts = isoNow();
  const body = JSON.stringify(payload);
  return okx.post(path, payload, { headers: buildHeaders({ ts, method: "POST", path, body }) });
}

// --- Helpers ---
function parseNetPos(rows = []) {
  let net = 0;
  let sample = null;
  for (const p of rows) {
    if (p && p.instId) {
      if (!sample) sample = p;
      net += Number(p.pos || 0);
    }
  }
  return { open: net !== 0, netPosSz: net, sample };
}

// --- Endpoints ---

app.get("/ping", (_, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

app.get("/debug/env", (_, res) =>
  res.json({
    ok: true,
    baseURL: BASE_URL,
    hasKey: Boolean(API_KEY),
    hasSecret: Boolean(SECRET_KEY),
    hasPassphrase: Boolean(PASSPHRASE),
    paper: PAPER,
  })
);

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

    // (1) set leverage (opcional, best-effort)
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

    // (2) place order
    const ord = { instId, side, ordType, tdMode, sz: String(sz ?? "1") };
    if (posSide) ord.posSide = posSide;
    if (tpTriggerPx) ord.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx)     ord.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx) ord.slTriggerPx = String(slTriggerPx);
    if (slOrdPx)     ord.slOrdPx     = String(slOrdPx);

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

    // Si no especifica lado/tamaño o pide all, inferimos desde la posición neta:
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

// POST /amend-tpsl
// Body: { instId, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx?, cancelExisting?: true }
app.post("/amend-tpsl", async (req, res) => {
  try {
    const { instId, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, cancelExisting } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId required" });

    // 1) Cancelar TP/SL existentes (advance algo) si se pide:
    if (cancelExisting) {
      const listPath = `/api/v5/trade/orders-algo-pending?instId=${encodeURIComponent(instId)}&ordType=conditional`;
      const list = await okxGet(listPath);
      const ids = (list.data?.data || [])
        .filter(a => a.instId === instId && (a.tpTriggerPx || a.slTriggerPx))
        .map(a => a.algoId);

      if (ids.length) {
        const payload = ids.map(algoId => ({ algoId, instId }));
        await okxPost("/api/v5/trade/cancel-algos", payload);
      }
    }

    // 2) Crear nuevos TP/SL (solo si llega alguno):
    const algo = {
      instId,
      ordType: "conditional",
      reduceOnly: "true",
    };
    if (tpTriggerPx) algo.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx)     algo.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx) algo.slTriggerPx = String(slTriggerPx);
    if (slOrdPx)     algo.slOrdPx     = String(slOrdPx);

    if (!algo.tpTriggerPx && !algo.slTriggerPx) {
      return res.json({ ok: true, msg: "Sin cambios (no se enviaron nuevos TP/SL)" });
    }

    // Nota: este endpoint acepta array de algos
    const place = await okxPost("/api/v5/trade/order-algo", [algo]);

    res.json({
      ok: true,
      request: { instId, cancelExisting, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx },
      response: place.data,
    });
  } catch (err) {
    console.error("amend-tpsl error:", err?.response?.data || err?.message || err);
    res
      .status(err?.response?.status || 500)
      .json({ ok: false, error: err.message, detail: err?.response?.data || "amend-tpsl failed" });
  }
});

// --- Start ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`okx-exec-proxy running on :${PORT}`);
  console.log(
    `env: baseURL=${BASE_URL} paper=${PAPER} key=${API_KEY ? "✓" : "×"} pass=${PASSPHRASE ? "✓" : "×"}`
  );
  console.log("Your service is live");
});
