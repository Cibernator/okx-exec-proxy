# okx-exec-proxy

Proxy mínimo para operar con la API de OKX desde Make, Render o cualquier orquestador.

## Variables de entorno
- OKX_API_KEY
- OKX_API_SECRET
- OKX_API_PASSPHRASE
- OKX_PAPER (1 = Paper trading, 0 = real)
- PORT

## Endpoints

### GET /ping
Prueba de vida.

### POST /positions
Confirma si hay posición abierta (Futuros/Swap).

**Body**
```json
{ "instId": "BTC-USDT-SWAP" }
```

**Respuesta**
```json
{
  "ok": true,
  "instId": "BTC-USDT-SWAP",
  "open": false,
  "netPosSz": 0,
  "raw": { "...respuesta OKX..." }
}
```
