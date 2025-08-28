// okx-exec-proxy v3 — server.js (Render + OKX v5) — FULL
import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// === ENV (nombres compatibles) ===
const API_KEY =
  process.env.OKX_API_KEY || process.env.OKX_APIKEY || process.env.OKX_KEY || "";

const SECRET_KEY =
  process.env.OKX_SECRET_KEY || process.env.OKX_API_SECRET || process.env.OKX_SECRET || "";

const PASSPHRASE =
  process.env.OKX_PASSPHRASE || process.env.OKX_API_PASSPHRASE || "";

const PAPER = process.env.PAPER === "1" ? "1" : "0";
const BASE_URL = (process.env.OKX_API_BASEURL || "https://www.okx.com").trim();

// === Cliente OKX ===
const okx = axios.create({ baseURL: BASE_URL, timeout: 15000 });

// === Firma/headers ===
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
    "x-simulated-trading": PAPER,     // "1"=paper, "0"=real
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

// === Helpers ===
function parseNetPos(data = []) {
  let net = 0;
  let sample = null;
  for (const p of data) {
    if (!sample && p.instId) sample = p;
    net += Number(p.pos || 0);
  }
  return { open: net !== 0, netPosSz: net, sample };
}
function oppositeSide(sz) {
  return Number(sz) > 0 ? "sell" : "buy";
}

// ================== Endpoints ==================
app.get("/ping", (_, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

app.get("/debug/env", (_, res) => {
  res.json({
    ok: true,
    baseURL: BASE_URL,
    hasKey: !!API_KEY,
    hasSecret: !!SECRET_KEY,
    hasPassphrase: !!PASSPHRASE,
    paper: PAPER,
  });
});

// POST /positions { instId, instType="SWAP" }
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

// POST /order  (abre posición y admite tp/sl inline)
app.post("/order", async (req, res) => {
  try {
    const {
      instId, side, ordType = "market", tdMode = "cross", sz,
      lever, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, posSide
    } = req.body || {};

    if (!instId || !side || !ordType || !tdMode)
      return res.status(400).json({ ok: false, error: "instId, side, ordType, tdMode required" });

    // Leverage opcional
    let leverageNote = null;
    if (lever) {
      try {
        const lev = await okxPost("/api/v5/account/set-leverage", { instId, lever: String(lever), mgnMode: tdMode });
        leverageNote = lev.data;
      } catch (e) {
        leverageNote = { warn: "set-leverage failed", reason: e?.response?.data || e.message };
      }
    }

    const ord = { instId, side, ordType, tdMode, sz: String(sz ?? "1") };
    if (posSide) ord.posSide = posSide;
    if (tpTriggerPx) ord.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx)     ord.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx) ord.slTriggerPx = String(slTriggerPx);
    if (slOrdPx)     ord.slOrdPx     = String(slOrdPx);

    const r = await okxPost("/api/v5/trade/order", ord);
    res.json({ ok: true, request: ord, response: r.data, leverageNote });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err.message, detail: err?.response?.data });
  }
});

// POST /close { instId, tdMode="cross", side?, sz?, all?, posSide? }
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
      side = oppositeSide(net.netPosSz); // opuesto para cerrar
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

// POST /amend-tpsl
// Body: { instId, tdMode="cross", cancelExisting=true|false, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx?, sz?, side?, posSide? }
app.post("/amend-tpsl", async (req, res) => {
  try {
    const {
      instId,
      tdMode = "cross",
      cancelExisting = false,
      tpTriggerPx, tpOrdPx,
      slTriggerPx, slOrdPx,
      sz, side, posSide
    } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId required" });

    // 0) Si no viene ni TP ni SL nuevo, no hacemos nada
    if (!tpTriggerPx && !slTriggerPx)
      return res.status(400).json({ ok: false, error: "tpTriggerPx o slTriggerPx requerido" });

    // 1) Si piden cancelar TP/SL existentes (algos "conditional")
    let cancelled = [];
    if (cancelExisting) {
      const list = await okxGet(`/api/v5/trade/orders-algo-pending?instId=${encodeURIComponent(instId)}&ordType=conditional`);
      const ids = (list.data?.data || [])
        .filter(a => a.instId === instId && (a.tpTriggerPx || a.slTriggerPx))
        .map(a => a.algoId);
      if (ids.length) {
        const payload = ids.map(id => ({ algoId: id, instId }));
        const c = await okxPost("/api/v5/trade/cancel-algos", payload);
        cancelled = c.data;
      }
    }

    // 2) Determinar side/sz si no vienen: usar la posición neta actual
    let useSide = side;
    let useSz = sz;
    if (!useSide || !useSz) {
      const pos = await okxGet(`/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`);
      const net = parseNetPos(pos.data?.data || []);
      if (!net.open) return res.status(400).json({ ok: false, error: "No hay posición abierta para calcular side/sz" });
      useSide = useSide || oppositeSide(net.netPosSz);   // cerrar la posición cuando se dispare
      useSz   = useSz   || String(Math.abs(net.netPosSz));
    }

    // 3) Crear el NUEVO TP/SL como "conditional" (array de 1)
    const algo = {
      instId,
      tdMode,
      ordType: "conditional",
      side: useSide,
      sz: String(useSz),
      reduceOnly: "true",
    };
    if (posSide)     algo.posSide     = posSide;
    if (tpTriggerPx) algo.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx)     algo.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx) algo.slTriggerPx = String(slTriggerPx);
    if (slOrdPx)     algo.slOrdPx     = String(slOrdPx);

    const placed = await okxPost("/api/v5/trade/order-algo", [algo]);

    res.json({
      ok: true,
      cancelled,
      placed: placed.data,
      request: { instId, tdMode, side: useSide, sz: useSz, tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, posSide }
    });
  } catch (err) {
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: err?.message || "amend-tpsl failed",
      detail: err?.response?.data
    });
  }
});

// === Start ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`okx-exec-proxy running on :${PORT}`);
  console.log(`env baseURL=${BASE_URL} paper=${PAPER} key=${API_KEY ? "✓" : "×"} pass=${PASSPHRASE ? "✓" : "×"}`);
  console.log("Your service is live");
});
