# Security policy

## Reporting a vulnerability

Do not open a public issue containing credentials, tokens, private logs, or exploit details.
Use GitHub's private vulnerability reporting for this repository when available.

## Deployment boundary

CodexUI exposes control of a Codex process and its host filesystem. Protect every remotely
reachable deployment with Cloudflare Access or an equivalent authenticated gateway. Do not
expose port 5999 directly to the internet.

The built-in CodexUI password is not an independent security boundary behind a local reverse
proxy: proxy traffic arrives from loopback, which the current authentication middleware treats
as local. Restrict direct LAN or private-overlay access to trusted clients and do not rely only
on the printed password for a public tunnel.

## Secret handling

- Never commit a populated `.env` file, OAuth token, API key, private key, or Codex `auth.json`.
- Keep runtime secrets in a user-owned env file outside the repository with mode `600`.
- Keep managed credentials such as Codex and Google OAuth tokens in their native per-user stores.
- Review `.env.example` and `deployment/` changes carefully to ensure they contain placeholders only.
