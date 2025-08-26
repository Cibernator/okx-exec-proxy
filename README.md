
# okx-exec-proxy v3

Proxy ligero para ejecutar órdenes en **OKX** desde Make / Postman.
Implementa firma v5, soporta paper trading y adjunta TP/SL en la creación de órdenes.

## Endpoints

- `GET /ping`
- `GET /debug/env`
- `POST /positions`
- `POST /order` (abre y permite TP/SL + seteo de leverage opcional antes de la orden)
- `POST /close` (cierre market reduceOnly; si no envías `sz` o pones `all:true`, cierra todo)
- `GET /balance` (`?ccy=USDT` por defecto)
- `POST /amend-tpsl` (best-effort: cancela “advance algos” existentes y crea nuevos TP/SL)

## Variables de entorno

```env
OKX_API_KEY=
OKX_SECRET_KEY=
OKX_PASSPHRASE=
PAPER=1  # 1=demo, 0 o vacío=real
PORT=10000
```

## Deploy en Render
- Crear servicio **Web Service** -> conectar el repo o subir este ZIP.
- `Start command`: `node server.js`
- Añadir las variables de entorno.
- Si usas paper: `x-simulated-trading: 1` se envía automáticamente.

## Ejemplos

**/positions**
```json
{ "instId": "BTC-USDT-SWAP" }
```

**/order**
```json
{
  "instId": "BTC-USDT-SWAP",
  "side": "buy",
  "ordType": "market",
  "tdMode": "cross",
  "sz": "1",
  "lever": "3",
  "tpTriggerPx": "111540",
  "tpOrdPx": "-1",
  "slTriggerPx": "109780",
  "slOrdPx": "-1"
}
```

**/close**
```json
{ "instId": "BTC-USDT-SWAP", "all": true }
```

**/balance**
`GET /balance?ccy=USDT`

**/amend-tpsl**
```json
{
  "instId": "BTC-USDT-SWAP",
  "tpTriggerPx": "112000",
  "tpOrdPx": "-1",
  "slTriggerPx": "109000",
  "slOrdPx": "-1"
}
```
