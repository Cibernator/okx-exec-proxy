# okx-exec-proxy

Proxy mínimo para operar Futuros/Swap en OKX desde Make/n8n o cualquier cliente HTTP.
Incluye:
- `/positions`  → revisa si hay posición abierta (usa `instType=SWAP`)
- `/order`      → abre posición con leverage y TP/SL opcional

## Variables de entorno
- `OKX_API_KEY`
- `OKX_API_SECRET`
- `OKX_API_PASSPHRASE`
- `OKX_PAPER` (1 = Paper trading, 0 = real)
- `PORT`

## Ejemplos

### Ping
```
GET /ping
```

### Check posiciones
```
POST /positions
{ "instId": "BTC-USDT-SWAP" }
```

### Abrir orden de prueba (market, cross, con TP/SL a mercado)
```
POST /order
{
  "instId": "BTC-USDT-SWAP",
  "side": "buy",
  "sz": "1",
  "tdMode": "cross",
  "ordType": "market",
  "leverage": "10",
  "tpTriggerPx": "63000",
  "tpOrdPx": "-1",
  "slTriggerPx": "59000",
  "slOrdPx": "-1"
}
```
