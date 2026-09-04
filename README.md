# CertifyFlow

CertifyFlow is a TypeScript React foundation for a secure bulk-certificate workflow. This first implementation delivers Phase 1 of the requested sequence: a polished dashboard, campaign creation, and validated PNG/JPG template upload with immediate preview.

## Run locally

Install dependencies with pnpm, then start the app:

```powershell
pnpm install
pnpm run dev
```

The project uses pnpm because the local npm executable is not functional in this environment.

## Live setup

1. Create a Supabase project and run [`db/schema.sql`](./db/schema.sql) in its SQL Editor.
2. In Supabase Authentication, enable your preferred sign-in providers and add your deployed URL to the Redirect URLs list.
3. Create a **private** Storage bucket named `certificate-files`; never make certificate files public.
4. In Google Cloud, enable Gmail API, create a Web OAuth client, and set its authorized redirect URI to `https://YOUR-API-DOMAIN/api/gmail/callback`.
5. Copy `.env.example` to `.env`, add the real values, and generate fresh `TOKEN_ENCRYPTION_KEY` and `OAUTH_STATE_SECRET` values. Do not commit `.env`.
6. Run the frontend with `pnpm dev` and the API with `pnpm server`. In production deploy them behind the same HTTPS domain or configure the API's CORS policy explicitly.

The Gmail flow requests only `gmail.send`, plus basic identity scopes for the connected address. It uses a signed short-lived OAuth state value and AES-256-GCM encrypted refresh token storage. Every data endpoint validates the Supabase session and scopes database reads/writes to the authenticated user.

## Production architecture

Keep the UI and a modular API together in one application. Use PostgreSQL for durable state, private object storage for template/certificate files, and a database-backed worker or managed queue for generation and email delivery. The browser must never hold Google OAuth secrets or Gmail refresh tokens.

[`db/schema.sql`](./db/schema.sql) defines the core relational model, including ownership, per-campaign email uniqueness, per-recipient certificates, and idempotent email jobs. Every API query must scope campaign, recipient, template, and certificate access through the authenticated `user_id`.

## Next implementation steps

1. Add server-side authentication (password hashes plus Google sign-in) and session cookies.
2. Add authenticated campaign/template upload API routes using private object storage and server-side image inspection.
3. Build the template editor, followed by recipient import and exact preview rendering.
4. Add workers for certificate generation and Gmail OAuth-backed idempotent delivery.

Do not use the client-side file validation as a security boundary; validate type, signature, size, and ownership again on the server.
