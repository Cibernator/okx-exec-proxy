import express from "express";
import axios from "axios";
import crypto from "crypto";

const {
  OKX_API_KEY,
  OKX_API_SECRET,
  OKX_API_PASSPHRASE,
  OKX_PAPER = "0", // "1" = Paper trading
  PORT = 8000
} = process.env;

const OKX_BASE = "https://www.okx.com";
const app = express();
app.use(express.json());

// ------------- Utilidades OKX -------------
async function okxTimestampIso() {
  // Hora oficial de OKX → evita desfases de timestamp
  const r = await axios.get(`${OKX_BASE}/api/v5/public/time`);
  const ms = Number(r.data?.data?.[0]?.ts || Date.now());
  return new Date(ms).toISOString();
}

function okxSign({ timestamp, method, requestPath, body = "" }) {
  const prehash = `${timestamp}${method}${requestPath}${body}`;
  return crypto.createHmac("sha256", OKX_API_SECRET).update(prehash).digest("base64");
}

async function okxReq(method, path, bodyObj) {
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
  const res = await axios(cfg);
  return res.data;
}

// ------------- Endpoints mínimos -------------
// Ping
app.get("/ping", (_req, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

// 1) ¿Hay posición abierta? (Futuros/SWAP)
app.post("/positions", async (req, res, next) => {
  try {
    const { instId } = req.body; // p.ej. "BTC-USDT-SWAP"
    if (!instId) return res.status(400).json({ ok: false, error: "instId is required" });

    // account/positions devuelve posiciones de Futuros/Swap si instId es SWAP/FUTURES
    const path = `/api/v5/account/positions?instId=${encodeURIComponent(instId)}`;
    const data = await okxReq("GET", path);

    const pos = (data?.data || [])[0];
    const posSz = pos ? Number(pos.pos || "0") : 0;

    // En cuentas con modo long/short, pueden venir dos entradas; sumamos neto:
    let netSz = 0;
    if (Array.isArray(data?.data) && data.data.length > 0) {
      netSz = data.data.reduce((sum, p) => sum + Number(p.pos || "0"), 0);
    } else {
      netSz = posSz;
    }

    res.json({
      ok: true,
      instId,
      open: Math.abs(netSz) > 0,
      netPosSz: netSz,
      raw: data
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    next(err);
  }
});

// (quedan listos para cuando avances)
// /order           → abrir orden (con TP/SL opcional)
// /amend-tpsl      → modificar TP/SL
// /cancel-order    → cancelar orden pendiente
// /close-positions → cerrar posición por mercado

app.use((err, _req, res, _next) => {
  res.status(500).json({ ok: false, error: err?.response?.data || err.message });
});

app.listen(PORT, () => console.log(`okx-exec-proxy running on :${PORT}`));
