# breakfast-backend

Proxy Node.js + Express entre tablet y la API REST de Ulysses PMS.

## Requisitos

- Node.js 18+ (usa `fetch` nativo)

## Instalación

```bash
npm install
cp .env.example .env
# edita .env con tus credenciales reales
```

## Arranque

```bash
npm start       # producción
npm run dev     # con --watch
```

Servidor en `http://localhost:3000`.

## Endpoint

`GET /breakfast-list?date=YYYY-MM-DD`

Respuesta:

```json
{
  "date": "2026-04-24",
  "totals": { "adults": 0, "juniors": 0, "children": 0, "infants": 0 },
  "guests": [
    {
      "reservationId": "",
      "roomNumber": "",
      "lastName": "",
      "firstName": "",
      "vipLevel": 0,
      "pax": 0,
      "boardCode": "",
      "checkIn": "",
      "checkOut": "",
      "remarks": ""
    }
  ]
}
```

- Caché en memoria de 4 min por fecha.
- CORS abierto (`*`).
- Si Ulysses falla → `502` con `{ error, detail }`.

## Variables de entorno

Ver `.env.example`.
