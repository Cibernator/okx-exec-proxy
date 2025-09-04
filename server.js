// server.js
// OKX Exec Proxy v3 — Endpoints: /ping, /debug/env, /positions, /order, /close, /balance, /amend-tpsl

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

/* ===== Env ===== */
const {
  OKX_API_KEY,
  OKX_API_SECRET,
  OKX_API_PASSPHRASE,
  OKX_API_BASEURL = 'https://www.okx.com',
  NODE_ENV = 'production',
  PORT = 10000,
} = process.env;

/* ===== Axios signed client (OKX v5) ===== */
function isoTs() {
  // OKX requires RFC3339/ISO8601 in UTC with milliseconds, e.g. 2024-01-01T00:00:00.000Z
  return new Date().toISOString();
}

function signMessage(ts, method, requestPath, body = '') {
  const prehash = ts + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', OKX_API_SECRET).update(prehash).digest('base64');
}

async function okxRequest(method, path, { params = undefined, data = undefined } = {}) {
  const urlObj = new URL(OKX_API_BASEURL);
  // Build requestPath + query (OKX includes query string in signature)
  let requestPath = path;
  let query = '';
  if (method.toUpperCase() === 'GET' && params && Object.keys(params).length) {
    const qs = new URLSearchParams(params);
    query = `?${qs.toString()}`;
    requestPath = `${path}${query}`;
  }

  const ts = isoTs();
  const bodyStr =
    method.toUpperCase() === 'GET'
      ? ''
      : (data ? JSON.stringify(data) : '');

  const headers = {
    'OK-ACCESS-KEY': OKX_API_KEY,
    'OK-ACCESS-SIGN': signMessage(ts, method, requestPath, bodyStr),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': OKX_API_PASSPHRASE,
    'Content-Type': 'application/json',
  };

  const instance = axios.create({
    baseURL: OKX_API_BASEURL,
    timeout: 15_000,
    headers,
  });

  const resp = await instance.request({
    url: requestPath, // requestPath (not just path) so GET includes query in URL
    method,
    data: method.toUpperCase() === 'GET' ? undefined : (data || {}),
  });

  return resp.data;
}

const okxGet = (path, params) => okxRequest('GET', path, { params });
const okxPost = (path, data) => okxRequest('POST', path, { data });

/* ===== Helpers de negocio ===== */
async function readNetPosition(instId) {
  const r = await okxGet('/api/v5/account/positions', { instType: 'SWAP', instId });
  const rows = r?.data || [];
  // OKX devuelve array; sumamos pos (string) para netear
  const net = rows.reduce((acc, x) => acc + Number(x.pos || 0), 0);
  return {
    rows,
    netSz: net,
    tdMode: rows[0]?.mgnMode || 'cross',
  };
}

function oppositeSideFromNet(netSz) {
  // para cerrar/TP-SL: si estás long (>0), el TP/SL debe ser side "sell"; si short (<0), "buy"
  return netSz > 0 ? 'sell' : 'buy';
}

function asStrOrNull(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

/* ===== Endpoints ===== */

// 1) Salud
app.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: isoTs() });
});

// 2) Debug env (enmascarado)
app.get('/debug/env', (_req, res) => {
  res.json({
    ok: true,
    env: {
      baseURL: OKX_API_BASEURL,
      node: NODE_ENV,
      hasKey: !!OKX_API_KEY,
      hasSecret: !!OKX_API_SECRET,
      hasPassphrase: !!OKX_API_PASSPHRASE,
    },
  });
});

// 3) Positions
// body: { instId: "BTC-USDT-SWAP" }
app.post('/positions', async (req, res) => {
  try {
    const { instId } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: 'instId requerido' });
    const data = await okxGet('/api/v5/account/positions', { instType: 'SWAP', instId });
    res.json({ ok: true, instId, data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, detail: err?.response?.data });
  }
});

// 4) Order (abrir y opcional TP/SL + leverage)
// body: { instId, side, sz, tdMode="cross", ordType="market", leverage?, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx? }
app.post('/order', async (req, res) => {
  try {
    const {
      instId, side, sz,
      tdMode = 'cross',
      ordType = 'market',
      leverage,
      tpTriggerPx, tpOrdPx,
      slTriggerPx, slOrdPx,
    } = req.body || {};

    if (!instId || !side || !sz) {
      return res.status(400).json({ ok: false, error: 'instId, side y sz son obligatorios' });
    }

    // Set leverage (opcional)
    if (leverage) {
      await okxPost('/api/v5/account/set-leverage', {
        instId,
        lever: String(leverage),
        mgnMode: tdMode,
        posSide: 'net',
      });
    }

    // Abrimos orden
    const orderPayload = {
      instId,
      tdMode,
      side,
      ordType,
      sz: String(sz),
      reduceOnly: 'false',
    };
    const placed = await okxPost('/api/v5/trade/order', orderPayload);

    // TP/SL opcional (advance algo)
    let tpsl = null;
    const hasTP = tpTriggerPx !== undefined || tpOrdPx !== undefined;
    const hasSL = slTriggerPx !== undefined || slOrdPx !== undefined;
    if (hasTP || hasSL) {
      const reverseSide = side === 'buy' ? 'sell' : 'buy';
      const algo = {
        instId,
        tdMode,
        side: reverseSide,
        sz: String(sz),
        ordType: 'conditional',
        reduceOnly: 'true',
      };
      if (tpTriggerPx !== undefined) algo.tpTriggerPx = String(tpTriggerPx);
      if (tpOrdPx !== undefined)     algo.tpOrdPx     = String(tpOrdPx);
      if (slTriggerPx !== undefined) algo.slTriggerPx = String(slTriggerPx);
      if (slOrdPx !== undefined)     algo.slOrdPx     = String(slOrdPx);

      // OKX exige ARRAY
      tpsl = await okxPost('/api/v5/trade/order-algo', [algo]);
    }

    res.json({ ok: true, request: req.body, response: { placed, tpsl } });
  } catch (err) {
    res.status(err?.response?.status || 500).json({
      ok: false, error: err?.message, detail: err?.response?.data,
    });
  }
});

// 5) Close (market reduceOnly)
// body: { instId, all?:true | sz?:string, tdMode="cross" }
app.post('/close', async (req, res) => {
  try {
    const { instId, all, sz, tdMode = 'cross' } = req.body || {};
    if (!instId) return res.status(400).json({ ok: false, error: 'instId requerido' });

    const { netSz } = await readNetPosition(instId);
    if (netSz === 0) return res.status(400).json({ ok: false, error: 'No hay posición abierta' });

    const side = oppositeSideFromNet(netSz);
    const sizeToClose = all || !sz ? Math.abs(netSz) : Number(sz);
    if (!sizeToClose || sizeToClose <= 0) return res.status(400).json({ ok: false, error: 'sz inválido' });

    const payload = {
      instId,
      tdMode,
      side,
      ordType: 'market',
      sz: String(sizeToClose),
      reduceOnly: 'true',
    };
    const placed = await okxPost('/api/v5/trade/order', payload);
    res.json({ ok: true, request: payload, response: placed });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, detail: err?.response?.data });
  }
});

// 6) Balance (?ccy=USDT por defecto)
app.get('/balance', async (req, res) => {
  try {
    const ccy = req.query.ccy || 'USDT';
    const data = await okxGet('/api/v5/account/balance', { ccy });
    res.json({ ok: true, ccy, data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, detail: err?.response?.data });
  }
});

// 7) Amend TP/SL (cancela los actuales y crea nuevos)
// body: { instId, tdMode="cross", cancelExisting=true, tpTriggerPx?, tpOrdPx?, slTriggerPx?, slOrdPx?, triggerPxType? }
app.post('/amend-tpsl', async (req, res) => {
  try {
    const {
      instId,
      tdMode = 'cross',
      cancelExisting = true,
      tpTriggerPx, tpOrdPx,
      slTriggerPx, slOrdPx,
      triggerPxType, // "last" | "index" | "mark" (opcional)
    } = req.body || {};

    if (!instId) return res.status(400).json({ ok: false, error: 'instId requerido' });

    // 1) Posición actual
    const { netSz } = await readNetPosition(instId);
    if (netSz === 0) return res.status(400).json({ ok: false, error: 'No open position' });

    const side = oppositeSideFromNet(netSz);
    const sz = String(Math.abs(netSz));

    // 2) Cancelar existentes
    if (cancelExisting) {
      const list = await okxPost('/api/v5/trade/orders-algo-pending', {
        instType: 'SWAP',
        instId,
        ordType: 'conditional',
      });
      const pending = list?.data || [];
      const ids = pending.map(a => a.algoId).filter(Boolean);
      if (ids.length) {
        const cancelBody = ids.map(id => ({ algoId: id, instId }));
        await okxPost('/api/v5/trade/cancel-algos', cancelBody);
      }
    }

    // 3) Crear nuevo TP/SL si hay algo que crear
    const hasTP = tpTriggerPx !== undefined || tpOrdPx !== undefined;
    const hasSL = slTriggerPx !== undefined || slOrdPx !== undefined;

    if (!hasTP && !hasSL) {
      return res.json({ ok: true, msg: 'Sin cambios (no se especificó TP/SL)' });
    }

    const algo = {
      instId,
      tdMode,
      side,
      sz,
      ordType: 'conditional',
      reduceOnly: 'true',
    };
    if (triggerPxType) algo.triggerPxType = String(triggerPxType);

    if (tpTriggerPx !== undefined) algo.tpTriggerPx = String(tpTriggerPx);
    if (tpOrdPx !== undefined)     algo.tpOrdPx     = String(tpOrdPx);
    if (slTriggerPx !== undefined) algo.slTriggerPx = String(slTriggerPx);
    if (slOrdPx !== undefined)     algo.slOrdPx     = String(slOrdPx);

    const placed = await okxPost('/api/v5/trade/order-algo', [algo]);
    res.json({ ok: true, request: algo, response: placed });
  } catch (err) {
    // Log útil en Render
    console.error('amend-tpsl error:', err?.response?.data || err?.message);
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: 'amend-tpsl failed',
      detail: err?.response?.data || err?.message,
    });
  }
});

/* ===== Start ===== */
app.listen(PORT, () => {
  // Pequeño log para Render
  console.log('okx-exec-proxy running on :' + PORT);
  console.log('env: baseURL=', OKX_API_BASEURL, ' key~', OKX_API_KEY ? '✓' : '×', ' pass~', OKX_API_PASSPHRASE ? '✓' : '×');
});
