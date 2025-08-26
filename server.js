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
  const res = await axios(cfg);
  return res.data;
}

// ---------------- Endpoints ----------------
app.get("/ping", (_req, res) => res.json({ ok: true, service: "okx-exec-proxy" }));

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

    res.json({
      ok: true,
      instId,
      open: Math.abs(netSz) > 0,
      netPosSz: netSz,
      raw: data
    });
  } catch (err) {
    console.error("positions error:", err?.response?.data || err.message);
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ ok: false, error: err?.response?.data || err.message });
});

app.listen(PORT, () => console.log(`okx-exec-proxy running on :${PORT}`));
