// server.js
// OKX Exec Proxy v3.1 — Endpoints: /ping, /debug/env, /positions, /order, /close, /balance, /amend-tpsl
// CommonJS version for Render

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

/* ===== Helpers firma OKX ===== */
const isoTs = () => new Date().toISOString();

function signMessage(ts, method, requestPath, body = '') {
  const prehash = ts + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', OKX_API_SECRET).update(prehash).digest('base64');
}

async function okxRequest(method, path, { params, data } = {}) {
  let requestPath = path;
  if (method.toUpperCase() === 'GET' && params && Object.keys(params).length) {
    const qs = new URLSearchParams(params).toString();
    requestPath = `${path}?${qs}`;
  }

  const ts = isoTs();
  const bodyStr = method.toUpperCase() === 'GET' ? '' : (data ? JSON.stringify(data) : '');

  const headers = {
    'OK-ACCESS-KEY': OKX_API_KEY,
    'OK-ACCESS-SIGN': signMessage(ts, method, requestPath, bodyStr),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': OKX_API_PASSPHRASE,
    'Content-Type': 'application/json',
  };

  const instance = axios.create({
    baseURL: OKX_API_BASEURL,
    timeout: 15000,
    headers,
  });

  const resp = await instance.request({
    url: requestPath,
    method,
    data: method.toUpperCase() === 'GET' ? undefined : (data || {}),
  });

  return resp.data;
}

const okxGet  = (path, params) => okxRequest('GET',  path, { params });
const okxPost = (path, data)   => okxRequest('POST', path, { data });

/* ===== Helpers negocio ===== */
async function readNetPosition(instId) {
  const r = await okxGet('/api/v5/account/positions', { instType: 'SWAP', instId });
  const rows = r?.data || [];
  const net = rows.reduce((acc, x) => acc + Number(x.pos || 0), 0);
  return { rows, netSz: net, tdMode: rows[0]?.mgnMode || 'cross' };
}
const oppositeSideFromNet = (netSz) => (netSz > 0 ? 'sell' : 'buy');

/* ===== Endpoints ===== */

// 1) Salud
app.get('/ping', (_req, res) => res.json({ ok: true, ts: isoTs() }));

// 2) Debug env
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

// 4) Order (abrir + TP/SL opcional)
app.post('/order', async (req, res) => {
  try {
    const {
      instId, side, sz,
      tdMode = 'cross',
      ordType = 'market',
      leverage,
      tpTriggerPx, tpOrdPx, tpTriggerPxType = 'last',
      slTriggerPx, slOrdPx, slTriggerPxType = 'last',
    } = req.body || {};

    if (!instId || !side || !sz) {
      return res.status(400).json({ ok: false, error: 'instId, side y sz son obligatorios' });
    }

    if (leverage) {
      await okxPost('/api/v5/account/set-leverage', {
        instId,
        lever: String(leverage),
        mgnMode: tdMode,
        posSide: 'net',
      });
    }

    const orderPayload = {
      instId,
      tdMode,
      side,
      ordType,
      sz: String(sz),
      reduceOnly: 'false',
    };
    const placed = await okxPost('/api/v5/trade/order', orderPayload);

    const hasTP = tpTriggerPx !== undefined || tpOrdPx !== undefined;
    const hasSL = slTriggerPx !== undefined || slOrdPx !== undefined;
    let tpsl = null;
    if (hasTP || hasSL) {
      const reverseSide = side === 'buy' ? 'sell' : 'buy';
      const ordTypeAlgo = (hasTP && hasSL) ? 'oco' : 'conditional';
      const algo = {
        instId,
        tdMode,
        side: reverseSide,
        ordType: ordTypeAlgo,
        sz: String(sz),
        reduceOnly: 'true',
        algoClOrdId: `tpsl_${Date.now()}`,
      };
      if (hasTP) {
        if (tpTriggerPx !== undefined) algo.tpTriggerPx = String(tpTriggerPx);
        if (tpOrdPx !== undefined)     algo.tpOrdPx     = String(tpOrdPx);
        algo.tpTriggerPxType = tpTriggerPxType;
      }
      if (hasSL) {
        if (slTriggerPx !== undefined) algo.slTriggerPx = String(slTriggerPx);
        if (slOrdPx !== undefined)     algo.slOrdPx     = String(slOrdPx);
        algo.slTriggerPxType = slTriggerPxType;
      }
      tpsl = await okxPost('/api/v5/trade/order-algo', algo);
    }

    res.json({ ok: true, request: req.body, response: { placed, tpsl } });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, detail: err?.response?.data });
  }
});

// 5) Close (market reduceOnly)
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

// 6) Balance
app.get('/balance', async (req, res) => {
  try {
    const ccy = req.query.ccy || 'USDT';
    const data = await okxGet('/api/v5/account/balance', { ccy });
    res.json({ ok: true, ccy, data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, detail: err?.response?.data });
  }
});

// 7) Amend TP/SL
app.post('/amend-tpsl', async (req, res) => {
  try {
    const {
      instId,
      tdMode = 'cross',
      cancelExisting = true,
      tpTriggerPx, tpOrdPx, tpTriggerPxType = 'last',
      slTriggerPx, slOrdPx, slTriggerPxType = 'last',
      algoId,
    } = req.body || {};

    if (!instId) return res.status(400).json({ ok: false, error: 'instId requerido' });

    const { netSz } = await readNetPosition(instId);
    if (netSz === 0) return res.status(400).json({ ok: false, error: 'No open position' });

    const side = oppositeSideFromNet(netSz);
    const sz = String(Math.abs(netSz));

    const hasTP = tpTriggerPx !== undefined || tpOrdPx !== undefined;
    const hasSL = slTriggerPx !== undefined || slOrdPx !== undefined;

    if (algoId) {
      const amendBody = {
        algoId,
        instId,
        ...(hasTP ? { newTpTriggerPx: String(tpTriggerPx ?? ''), newTpOrdPx: String(tpOrdPx ?? '') } : {}),
        ...(hasSL ? { newSlTriggerPx: String(slTriggerPx ?? ''), newSlOrdPx: String(slOrdPx ?? '') } : {}),
        ...(hasTP ? { newTpTriggerPxType: tpTriggerPxType } : {}),
        ...(hasSL ? { newSlTriggerPxType: slTriggerPxType } : {}),
      };
      const amended = await okxPost('/api/v5/trade/amend-algos', amendBody);
      return res.json({ ok: amended.code === '0', data: amended, mode: 'amend' });
    }

    if (cancelExisting) {
      const pendCond = await okxGet('/api/v5/trade/orders-algo-pending', { ordType: 'conditional', instId });
      const pendOco  = await okxGet('/api/v5/trade/orders-algo-pending', { ordType: 'oco', instId });
      const toCancel = [...(pendCond.data || []), ...(pendOco.data || [])]
        .map(o => ({ algoId: o.algoId, instId }))
        .filter(o => !!o.algoId);
      if (toCancel.length > 0) {
        await okxPost('/api/v5/trade/cancel-algos', toCancel);
      }
    }

    if (!hasTP && !hasSL) {
      return res.json({ ok: true, msg: 'Sin cambios (no se especificó TP/SL)' });
    }

    const ordTypeAlgo = (hasTP && hasSL) ? 'oco' : 'conditional';
    const place = {
      instId,
      tdMode,
      side,
      ordType: ordTypeAlgo,
      sz,
      reduceOnly: 'true',
      algoClOrdId: `tpsl_${Date.now()}`
    };
    if (hasTP) {
      if (tpTriggerPx !== undefined) place.tpTriggerPx = String(tpTriggerPx);
      if (tpOrdPx !== undefined)     place.tpOrdPx     = String(tpOrdPx);
      place.tpTriggerPxType = tpTriggerPxType;
    }
    if (hasSL) {
      if (slTriggerPx !== undefined) place.slTriggerPx = String(slTriggerPx);
      if (slOrdPx !== undefined)     place.slOrdPx     = String(slOrdPx);
      place.slTriggerPxType = slTriggerPxType;
    }

    const created = await okxPost('/api/v5/trade/order-algo', place);
    res.json({ ok: created.code === '0', request: place, data: created, mode: 'recreate' });
  } catch (err) {
    console.error('amend-tpsl error:', err?.response?.data || err?.message);
    res.status(err?.response?.status || 500).json({ ok: false, error: 'amend-tpsl failed', detail: err?.response?.data || err?.message });
  }
});

/* ===== Start ===== */
app.listen(PORT, () => {
  console.log('okx-exec-proxy running on :' + PORT);
});
