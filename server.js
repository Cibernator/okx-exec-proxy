import express from "express";
import axios from "axios";
import crypto from "crypto";

const {
  OKX_API_KEY,
  OKX_API_SECRET,
  OKX_API_PASSPHRASE,
  OKX_PAPER = "0",
  PORT = 8000
} = process.env;

const OKX_BASE = "https://www.okx.com";
const app = express();
app.use(express.json());

// ---------------- Utils ----------------
async function okxTimestampIso() {
  // Hora oficial de OKX para evitar skew
  const r = await axios.get(`${OKX_BASE}/api/v5/public/time`);
  const ms = Number(r.data?.data?.[0]?.ts || Date.now());
  return new Date(ms).toISOString();
}

function okxSign({ timestamp, method, requestPath, body = "" }) {
  if (!OKX_API_SECRET) throw new Error("Missing OKX_API_SECRET");
  const prehash = `${timestamp}${method}${requestPath}${body}`;
  return crypto.createHmac("sha256", OKX_API_SECRET).update(prehash).digest("base64");
}

async function okxReq(method, path, bodyObj) {
  // Validaciones tempranas para errores claros
  if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_API_PASSPHRASE) {
    throw new Error("Missing OKX credentials (OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE)");
  }

  const ts = await okxTimestampIso();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";

  const headers = {
    "OK-ACCESS-KEY": OKX_API_KEY,
    "OK-ACCESS-SIGN": okxSign({ timestamp: ts, method, requestPath: path, body: bodyStr }),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": OKX_API_PASSPHRASE,
    "Content-Type": "application/json"
  };
  if (OKX_PAPER === "1") headers["x-simulated-trading"] = "1";

  const url = `${OKX_BASE}${path}`;
  try {
    const res = await axios({ method, url, headers, data: bodyStr || undefined, timeout: 15000 });
    return res.data;
  } catch (err) {
    // Log detallado para depurar rápido
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("OKX HTTP ERROR →", {
      method, path, status, data, message: err.message
    });
    throw err;
  }
}

// ---------------- Endpoints ----------------
app.get("/ping", (_req, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

// Diagnóstico rápido de entorno (NO expone valores)
app.get("/debug/env", (_req, res) => {
  res.json({
    hasKey: !!OKX_API_KEY,
    hasSecret: !!OKX_API_SECRET,
    hasPassphrase: !!OKX_API_PASSPHRASE,
    paper: OKX_PAPER
  });
});

// 1) positions (futuros/swap)
app.post("/positions", async (req, res, next) => {
  try {
    if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_API_PASSPHRASE) {
      return res.status(500).json({
        ok: false,
        error: "Missing OKX credentials (OKX_API_KEY/SECRET/PASSPHRASE)"
      });
    }
    const { instId } = req.body;
    if (!instId) return res.status(400).json({ ok: false, error: "instId is required" });

    const path = `/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    const data = await okxReq("GET", path);

    const arr = Array.isArray(data?.data) ? data.data : [];
    const netSz = arr.reduce((sum, p) => sum + Number(p.pos || "0"), 0);

    res.json({ ok: true, instId, open: Math.abs(netSz) > 0, netPosSz: netSz, raw: data });
  } catch (err) {
    console.error("positions error:", err?.response?.data || err.message);
    next(err);
  }
});

// 2) order (abrir posición con leverage y TP/SL opcional)
app.post("/order", async (req, res, next) => {
  try {
    if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_API_PASSPHRASE) {
      return res.status(500).json({
        ok: false,
        error: "Missing OKX credentials (OKX_API_KEY/SECRET/PASSPHRASE)"
      });
    }

    const {
      instId, side, sz,
      ordType = "market",
      tdMode = "cross",
      px,
      leverage,
      tpTriggerPx, tpOrdPx,
      slTriggerPx, slOrdPx,
      posSide // recuerda: en NET mode no se envía
    } = req.body;

    if (!instId || !side || !sz) {
      return res.status(400).json({ ok: false, error: "instId, side, sz are required" });
    }

    // --- Intentar setear leverage: SOFT-FAIL ---
    let leverageNote = null;
    if (leverage) {
      try {
        await okxReq("POST", "/api/v5/account/set-leverage", {
          instId,
          lever: String(leverage),
          mgnMode: tdMode
        });
      } catch (e) {
        // No detengas la orden si falla set-leverage
        const status = e?.response?.status;
        const data = e?.response?.data;
        console.error("set-leverage failed (soft):", { status, data });
        leverageNote = { note: "set-leverage failed; proceeding without changing leverage", status, data };
      }
    }

    const body = {
      instId,
      side,                    // "buy" | "sell"
      ordType,                 // "market" | "limit" | ...
      tdMode,                  // "cross" | "isolated"
      sz: String(sz),
      ...(px ? { px: String(px) } : {}),
      // En NET mode NO incluir posSide
      ...(posSide ? { posSide } : {}),
      ...(tpTriggerPx ? { tpTriggerPx: String(tpTriggerPx) } : {}),
      ...(tpOrdPx ? { tpOrdPx: String(tpOrdPx) } : {}),
      ...(slTriggerPx ? { slTriggerPx: String(slTriggerPx) } : {}),
      ...(slOrdPx ? { slOrdPx: String(slOrdPx) } : {})
    };

    const data = await okxReq("POST", "/api/v5/trade/order", body);
    res.json({ ok: true, request: body, response: data, leverageNote });
  } catch (err) {
    console.error("order error:", err?.response?.data || err.message);
    next(err);
  }
});


// Error handler
app.use((err, _req, res, _next) => {
  res.status(500).json({ ok: false, error: err?.response?.data || err.message });
});

app.listen(PORT, () => console.log(`okx-exec-proxy running on :${PORT}`));

// === Diagnóstico de cuenta ===
// 1) Configuración de cuenta (posMode, etc.)
app.get("/account/config", async (_req, res, next) => {
  try {
    const data = await okxReq("GET", "/api/v5/account/config");
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// 2) Balance (USDT en cuenta de contratos)
app.get("/account/balance", async (_req, res, next) => {
  try {
    const data = await okxReq("GET", "/api/v5/account/balance?ccy=USDT");
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});
