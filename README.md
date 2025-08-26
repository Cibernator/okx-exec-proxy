# okx-exec-proxy (v3)

Proxy para operar Futuros/Swap en OKX desde Make/Render.
Incluye:
- `POST /positions`  → revisa si hay posición abierta (usa `instType=SWAP`)
- `POST /order`      → abre posición (market/limit) con leverage y TP/SL opcional
- `POST /close`      → cierra posición abierta del instrumento (usa `trade/close-position`)
- `POST /amend-tpsl` → coloca/modifica TP/SL sobre la posición (usa `trade/tpsl`)
- `GET  /account/config` → ver `posMode` (net/long_short), etc.
- `GET  /account/balance?ccy=USDT` → ver balance de contratos

## Ejemplos

### Abrir orden (NET mode, sin `posSide`)
```
POST /order
{
  "instId": "BTC-USDT-SWAP",
  "side": "buy",
  "sz": "186",
  "tdMode": "cross",
  "ordType": "market",
  "leverage": "3",
  "tpTriggerPx": "110440",
  "tpOrdPx": "-1",
  "slTriggerPx": "109780",
  "slOrdPx": "-1"
}
```

### Cerrar posición (NET mode)
```
POST /close
{ "instId": "BTC-USDT-SWAP", "tdMode": "cross" }
```

### Colocar/Modificar TP/SL
```
POST /amend-tpsl
{
  "instId": "BTC-USDT-SWAP",
  "tdMode": "cross",
  "tpTriggerPx": "110440",
  "tpOrdPx": "-1",
  "slTriggerPx": "109780",
  "slOrdPx": "-1"
}
```
