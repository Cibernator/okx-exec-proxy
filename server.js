// server.js (con logs y normalización de body)
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

// --- Captura raw para debug y parseo robusto ---
app.use(express.text({ type: ["text/*"], limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

// Middleware: normaliza body si vino como string con JSON
app.use((req, _res, next) => {
  try {
    // Solo para métodos con body
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      // Si Content-Type dice JSON pero body es string, intenta parsear
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (typeof req.body === "string") {
        const looksJson =
          ct.includes("application/json") ||
          (req.body.trim().startsWith("{") && req.body.trim().endsWith("}"));
        if (looksJson) {
          try {
            const parsed = JSON.parse(req.body);
            req.body = parsed;
            req._bodyWasString = true;
          } catch (e) {
            // Deja el string tal cual; el handler devolverá error útil
            req._jsonParseError = String(e.message || e);
          }
        }
      }
    }
  } catch (e) {
    req._normalizerError = String(e.message || e);
  }
  next();
});

// Logger compacto de cada request entrante
app.use((req, _res, next) => {
  const ct = req.headers["content-type"];
  console.log("▶︎ INCOMING",
    JSON.stringify({
      method: req.method,
      url: req.url,
      contentType: ct,
      bodyType: typeof req.body,
      bodyWasString: !!req._bodyWasString,
      jsonParseError: req._jsonParseError || null
    })
  );
  // Log del body (recortado a 8k para no saturar logs)
  try {
    const toPrint =
      typeof req.body === "string" ? req.body :
      typeof req.body === "object" ? JSON.stringify(req.body) : String(req.body);
    console.log("   body:", toPrint.slice(0, 8000));
  } catch {}
  next();
});

// ---------------- Utils ----------------
async function okxTimestampIso() {
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
  const cfg = { method, url, headers, data: bodyStr || undefined, timeout: 15000 };

  console.log("→ OKX REQ", JSON.stringify({ method, path, body: bodyObj || null }).slice(0, 8000));
  try {
    const res = await axios(cfg);
    console.log("← OKX RES", JSON.stringify(res.data).slice(0, 8000));
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("⛔ OKX ERROR", JSON.stringify({ status, data, message: err.message }).slice(0, 8000));
    throw err;
  }
}

// ---------------- Endpoints ----------------
app.get("/ping", (_req, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

// Diagnóstico
app.get("/account/config", async (_req, res, next) => {
  try { const data = await okxReq("GET", "/api/v5/account/config"); res.json(data); }
  catch (e) { next(e); }
});
app.get("/account/balance", async (req, res, next) => {
  try {
    const ccy = req.query.ccy || "USDT";
    const data = await okxReq("GET", `/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}`);
    res.json(data);
  } catch (e) { next(e); }
});

// 1) positions (futuros/swap)
app.post("/positions", async (req, res, next) => {
  try {
    const { instId } = req.body;
    if (!instId) return res.status(400).json({ ok: false, error: "instId is required", received: req.body });
    const path = `/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    const data = await okxReq("GET", path);
    const arr = Array.isArray(data?.data) ? data.data : [];
    const netSz = arr.reduce((sum, p) => sum + Number(p.pos || "0"), 0);
    res.json({ ok: true, instId, open: Math.abs(netSz) > 0, netPosSz: netSz, raw: data });
  } catch (err) { next(err); }
});

// 2) order (abrir posición con leverage y TP/SL opcional)
app.post("/order", async (req, res, next) => {
  try {
    const {
      instId, side, sz,
      ordType = "market",
      tdMode = "cross",
      px,
      leverage,
      tpTriggerPx, tpOrdPx,
      slTriggerPx, slOrdPx,
      posSide
    } = req.body || {};

    if (!instId || !side || !sz) {
      return res.status(400).json({ ok: false, error: "instId, side, sz are required", received: req.body });
    }

    // Soft-fail leverage
    let leverageNote = null;
    if (leverage) {
      try {
        await okxReq("POST", "/api/v5/account/set-leverage", {
          instId, lever: String(leverage), mgnMode: tdMode
        });
      } catch (e) {
        const status = e?.response?.status;
        const data = e?.response?.data;
        console.error("set-leverage failed (soft):", { status, data });
        leverageNote = { note: "set-leverage failed; proceeding without changing leverage", status, data };
      }
    }

    const body = {
      instId,
      side,
      ordType,
      tdMode,
      sz: String(sz),
      ...(px ? { px: String(px) } : {}),
      ...(posSide ? { posSide } : {}), // en NET no se envía
      ...(tpTriggerPx ? { tpTriggerPx: String(tpTriggerPx) } : {}),
      ...(tpOrdPx ? { tpOrdPx: String(tpOrdPx) } : {}),
      ...(slTriggerPx ? { slTriggerPx: String(slTriggerPx) } : {}),
      ...(slOrdPx ? { slOrdPx: String(slOrdPx) } : {})
    };

    const data = await okxReq("POST", "/api/v5/trade/order", body);
    res.json({ ok: true, request: body, response: data, leverageNote });
  } catch (err) { next(err); }
});

// 3) close (cerrar posición abierta del instrumento)
app.post("/close", async (req, res, next) => {
  try {
    const { instId, tdMode = "cross", posSide } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId is required", received: req.body });

    const body = { instId, mgnMode: tdMode, ...(posSide ? { posSide } : {}) };
    const data = await okxReq("POST", "/api/v5/trade/close-position", body);
    res.json({ ok: true, request: body, response: data });
  } catch (err) { next(err); }
});

// 4) amend-tpsl (set o modificar TP/SL sobre la posición)
app.post("/amend-tpsl", async (req, res, next) => {
  try {
    const { instId, tdMode = "cross", tpTriggerPx, tpOrdPx, slTriggerPx, slOrdPx, posSide } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: "instId is required", received: req.body });
    if (!tpTriggerPx && !slTriggerPx) {
      return res.status(400).json({ ok: false, error: "Provide at least one of tpTriggerPx or slTriggerPx", received: req.body });
    }

    const body = {
      instId,
      mgnMode: tdMode,
      ...(posSide ? { posSide } : {}), // en NET no se envía
      ...(tpTriggerPx ? { tpTriggerPx: String(tpTriggerPx) } : {}),
      ...(tpOrdPx ? { tpOrdPx: String(tpOrdPx) } : {}),
      ...(slTriggerPx ? { slTriggerPx: String(slTriggerPx) } : {}),
      ...(slOrdPx ? { slOrdPx: String(slOrdPx) } : {})
    };

    const data = await okxReq("POST", "/api/v5/trade/tpsl", body);
    res.json({ ok: true, request: body, response: data });
  } catch (err) { next(err); }
});

// Error handler con eco del body para depuración
app.use((err, req, res, _next) => {
  const payload = {
    ok: false,
    error: err?.response?.data || err.message,
    received: req?.body ?? null
  };
  console.error("✖ Handler error:", JSON.stringify(payload).slice(0, 8000));
  res.status(500).json(payload);
});

app.listen(PORT, () => console.log(`okx-exec-proxy running on :${PORT}`));
