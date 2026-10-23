# Patients Flow mail API

Small Express service for the website contact form and newsletter sign-ups. It sends messages through the ZeptoMail transactional email API; the API key stays on the server.

## Requirements

- Node.js 20 or newer
- A ZeptoMail agent API key and a verified sender address

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `ZEPTOMAIL_API_KEY` in `.env` to the API key for the configured ZeptoMail agent. The sender address must be verified in ZeptoMail. Keep `.env` private and do not commit it.

The ZeptoMail send endpoint uses the agent-specific API key for authentication; it does not require a separate agent-alias field in the message request.

## Run

```powershell
npm run dev
```

The API listens on `http://localhost:4000` by default. Set `NEXT_PUBLIC_API_URL` in the frontend to the deployed API origin and update `FRONTEND_ORIGINS` to the exact frontend origins.

## Endpoints

- `GET /health` — service health check.
- `POST /api/contact` — validates and emails a contact enquiry to `CONTACT_INBOX`, then sends an acknowledgement to the visitor. The phone number must be E.164 (for example, `+447123456789`), and the visitor's address is configured as Reply-To for the inbox message.
- `POST /api/newsletter` — requires `{ "email": "...", "consent": true }`, emails the inbox about the signup, then sends a confirmation to the subscriber. This endpoint does not retain a subscriber list.

Both submission endpoints have per-IP rate limits and input validation. The newsletter form and its consent are shown in the shared footer on all frontend pages.

## Troubleshooting email delivery

When ZeptoMail rejects a send, the backend logs the HTTP status, safe provider error fields, and a request ID. Authorization details and submitted contact information are redacted; clients still receive a generic error response. Use the `X-Request-Id` response header to match a failed request to its backend log entry.

## Test

```powershell
npm test
```
