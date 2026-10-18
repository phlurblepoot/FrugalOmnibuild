# Mail — Server Setup Runbook

The in-app mail client connects each user's own mailbox: **Google Workspace**,
**Microsoft 365**, or any **IMAP/SMTP** host. Google and Microsoft use OAuth,
which needs a one-time app registration by an admin (you). Generic IMAP needs
nothing on the server.

The same steps are shown inside the app at **Settings → Mail → Server setup
guide** (admin only) with the exact redirect URIs for this deployment and
copy buttons. The server also answers `GET /api/mail/setup-info` (admin) with
the same values, which is the quickest way to confirm what a deployment
actually resolved.

> **Where this stands (2026-08-30):** the server side is complete — accounts,
> OAuth, sync, push, sending. The **Settings → Mail** screens referenced below
> ship with the mail client UI; until then the same information is available
> from `GET /api/mail/setup-info` and `GET /api/mail/providers`.

---

## 1. Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `APP_PUBLIC_URL` | OAuth, Microsoft push | The HTTPS origin users reach the app on, e.g. `https://takeoff.example.com`. No trailing slash (a trailing one is trimmed). Redirect URIs and the Graph webhook URL are built from it. Unset, the Connect buttons answer **503** naming this variable, and Microsoft accounts poll instead of receiving push. |
| `MAIL_SECRET_KEY` | optional | 32 bytes as hex (64 chars) or base64. Encrypts stored refresh tokens / IMAP passwords (AES‑256‑GCM). **If unset, the server generates `data/mail.key` (mode 0600) on first use** — back that file up with the data directory. Losing the key only forces users to reconnect their accounts. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google | From the Google Cloud OAuth client (§2). |
| `MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` | Microsoft | From the Entra app registration (§3). |
| `GOOGLE_PUBSUB_TOPIC` | Google (optional) | Full topic name, `projects/<project>/topics/<topic>`. Turns on Gmail real-time push (§2.1). Unset, Gmail polls — which is the only difference. |
| `MS_OAUTH_TENANT` | Microsoft (optional) | Your tenant id, or `common` (default). Use the tenant id for a single-tenant registration. |
| `MAIL_FAKE_PROVIDER=1` | dev / E2E only | Every account uses an in-memory fake provider. Never set in production. |

Testing and production each need their **own** OAuth clients (the redirect URI
is host-specific).

---

## 2. Google Workspace

1. Google Cloud Console → create/select a project → **APIs & Services → Library → enable "Gmail API"**.
2. **OAuth consent screen** → User type **Internal** (Workspace only). Internal skips Google's restricted-scope verification. *Personal @gmail.com users cannot use an Internal app; supporting them requires External + verification and is not supported by default.*
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `${APP_PUBLIC_URL}/api/mail/oauth/google/callback`
   - One client per environment (testing, production).
4. Copy the client id/secret into `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Scopes requested by the app (nothing to configure, listed for the consent screen):
   `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.send`, `openid`, `email`.

Sync: Gmail history polling (every 30 s while a user has the Mail tab open,
otherwise every 5 min). That is enough on its own — the push below is optional.

### 2.1 Real-time push (optional)

With a Cloud Pub/Sub topic configured, Gmail publishes a notification the moment
a mailbox changes and new mail lands in the app within a second or two instead
of up to 30 s. **Polling is not replaced** — it keeps running underneath, so a
broken or misconfigured topic costs latency and nothing else.

1. Google Cloud Console → **Pub/Sub → Topics → Create topic** (same project as the OAuth client).
2. On the topic → **Permissions → Grant access**: principal `gmail-api-push@system.gserviceaccount.com`, role **Pub/Sub Publisher**. *(Skipping this is the usual cause of a `403 … User not authorized to perform this action` in the server log.)*
3. On the topic → **Create subscription** → delivery type **Push**, endpoint URL = the **Gmail push endpoint** shown in **Settings → Mail → Server setup guide** (or `google.pubsub.webhookUrl` from `GET /api/mail/setup-info`). Copy it exactly: it ends in `?token=…`, and that token is what authenticates the push.
4. Set `GOOGLE_PUBSUB_TOPIC=projects/<project>/topics/<topic>` and restart.

The endpoint's token is a shared secret held in the `settings` table
(`mail.googlePushSecret`, which `/api/settings` withholds). It is only ever
shown by the admin-only setup route, because Pub/Sub delivers Gmail's own
payload and has nowhere in the body to carry a secret — unlike Graph, which
echoes `clientState` back to us. Treat the URL like a password; anyone holding
it can make the server re-check a mailbox, and nothing more. (It rides in the
query string because Pub/Sub offers no other place to put it, so a reverse proxy
in front of the app will record it in access logs — worth a thought if those
logs are shipped somewhere.)

Each mailbox's `watch` lasts about seven days and every sync tick renews it once
less than 24 hours are left, so there is nothing to schedule. Removing or
disabling an account hands its watch back — unless the same address is still
connected by another account, in which case the watch stays (Gmail's `stop` is
scoped to the mailbox, not to one connection) and the remaining accounts
re-assert it on their next tick. Push notifications
are believed only as far as "re-sync this mailbox": the address in the payload
is matched against accounts already connected, the `historyId` in it is ignored
(the poll owns that watermark), and nothing from the body is stored. The route
takes the same **256 KB** body cap and **600 requests/min per IP** limit as the
Graph webhook.

---

## 3. Microsoft 365

1. Entra admin center → **App registrations → New registration**.
   - Supported account types: *Accounts in this organizational directory only* (single tenant) unless users on other tenants/personal accounts must connect.
   - Redirect URI (Web): `${APP_PUBLIC_URL}/api/mail/oauth/microsoft/callback`
2. **API permissions → Add → Microsoft Graph → Delegated**: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`. Click **Grant admin consent** so users are not prompted.
3. **Certificates & secrets → New client secret** → copy the value (shown once).
4. Set `MS_OAUTH_CLIENT_ID` (Application (client) ID), `MS_OAUTH_CLIENT_SECRET`, and `MS_OAUTH_TENANT` (Directory (tenant) ID, or `common`).

Push: the server subscribes to Graph change notifications at
`${APP_PUBLIC_URL}/api/mail/ms/webhook` (must be reachable from the internet
over HTTPS). Microsoft validates the URL with a plain-text handshake when the
subscription is created; the subscription itself lasts two days and every sync
tick renews it once less than 12 hours are left. If `APP_PUBLIC_URL` is unset,
Microsoft accounts fall back to delta polling every 5 min.

That webhook is one of the two routes in the app that accept an unauthenticated
POST body (the other is the optional Gmail push endpoint, §2.1). It has to be
(Microsoft has no token of ours to send), so it is narrow by construction: a notification is believed only far enough to say
"re-sync account X" — the `clientState` secret must match, the subscription id
must already belong to an account, and nothing from the payload is stored. The
route also caps the body at **256 KB** and rate-limits itself to **600
requests/min per IP** (a throttled burst is logged once a minute). If a reverse proxy sits in front, let this path through
unbuffered and do not strip the query string (the validation handshake arrives
as `?validationToken=…`).

---

## 4. Generic IMAP / SMTP

Nothing to configure on the server. Users add these themselves in
**Settings → Mail → Add IMAP account**: IMAP
host/port/SSL, SMTP host/port (STARTTLS or SSL), username, password (an *app
password* for providers that require one). "Test & save" verifies both.

Accounts migrated from the old per-user SMTP settings appear in status
**Needs review** with the IMAP host pre-filled from the SMTP host. Nothing
sends from a `needs_review` account; until the Mail settings screen ships they
are corrected and activated through the API (`PATCH /api/mail/accounts/:id`
then `POST /api/mail/accounts/:id/test`).

Push: a persistent IMAP IDLE connection on INBOX; other folders every 5 min.

---

## 4.1 Google Drive backups

Settings → Backup can push the same snapshots Backups writes locally to a
"FrugalOmnibuild Backups" folder (or "Frugal Takeoff Backups" on older installs) in Google Drive, incrementally. This reuses
the Google OAuth client from §2 (Drive access only — no Gmail scopes are
requested for it), so it needs one more thing in the same Cloud project:

1. Google Cloud Console → **APIs & Services → Library → enable "Google Drive API"**
   (same project as the Gmail OAuth client in §2).
2. **Credentials** → the same OAuth client from §2 → **Authorized redirect URIs** → add both:
   - `https://<host>/api/backup/drive/callback` (Settings → Backup → Connect Google Drive)
   - `https://<host>/api/setup/restore/drive/callback` (the fresh-install `/restore` screen's Drive tab)

No new environment variables — `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
from §1 cover this too. Without the Drive API enabled or the redirect URIs
added, "Connect Google Drive" on either screen fails with Google's own
`redirect_uri_mismatch` or `access_denied` error text.

The same steps, with this deployment's own redirect URIs and copy buttons, are
in **Settings → Backup → Setup guide**. Two things the steps above do not say:

- **Backing up to a personal @gmail.com Drive** needs the consent screen's user
  type set to **External** (an Internal app only admits Workspace accounts),
  and then **Publish app** so it reads *In production*. An External app left in
  *Testing* has its refresh tokens revoked after 7 days, so Drive backups stop
  and the Backup tab asks for a reconnect every week. `drive.file` is a
  non-sensitive scope, so publishing needs no Google review.
- **Keep the OAuth client.** `drive.file` only shows the app the files it
  created, and Google ties that to the client's Cloud project. A rebuilt server
  must use the same client id/secret (and `APP_PUBLIC_URL`) or the restore
  screen's Drive tab will not see the old snapshots.

Local and Drive backups are scheduled separately (Settings → Backup →
Schedule & retention).

---

## 5. Backups and the key file

`npm run backup` copies the whole data directory verbatim, so `app.db`,
`files/` and `mail.key` all travel together. A restore must bring `mail.key` along — without it,
stored mail credentials are unreadable and every user must reconnect (no
other data is lost).

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connect Google / Microsoft buttons disabled | The provider's env vars are not set on this server (see §1). `GET /api/mail/providers` shows which are configured. |
| Connect returns to Settings with an error | `APP_PUBLIC_URL` missing or not matching the registered redirect URI; or the OAuth client id/secret is wrong. The error text names the OAuth error code. |
| "No refresh token returned" (Google) | The user had previously consented without offline access. Remove the app under Google Account → Security → Third‑party access, then connect again. |
| Account shows **Reconnect needed** (`auth_error`) | The refresh token/password was revoked or rotated. Press Reconnect (OAuth) or Edit → re-enter password (IMAP). |
| Microsoft push never arrives | `APP_PUBLIC_URL` not reachable from the internet, or a proxy strips the validation handshake / the `?validationToken=` query. The server logs subscription failures; polling still works, so the only symptom is latency. |
| Webhook returns 413 or 429 | The body cap (256 KB) or the per-IP rate limit (600/min) fired. Real Graph batches are far under both — check what else is POSTing to that path. |
| `Gmail watch failed … 403 … User not authorized` in the log | The Pub/Sub topic has not granted `gmail-api-push@system.gserviceaccount.com` the **Publisher** role (§2.1 step 2). The mailbox is fine and keeps polling. After a failure the server stands that mailbox down for 10 minutes before retrying and logs at most one line a minute, so fix the grant and expect push within ~10 min (or restart). |
| Gmail push never arrives | Check the subscription's endpoint URL against the one in **Settings → Mail** — a missing or edited `?token=` answers **403** (Pub/Sub reports it as a delivery failure), and a topic name that does not match `GOOGLE_PUBSUB_TOPIC` means nothing is ever published. The server logs the watch renewal; polling still works, so the only symptom is latency. |
| Gmail "history expired" in the log | Normal after long downtime; Gmail drops history ids it no longer holds and the account re-backfills automatically. |
| Sync stuck for one folder (IMAP) | A folder that LISTs but refuses SELECT is skipped with a warning; others continue. |
| A message's body says "still being filed" (Microsoft) | Sent copy not yet in Sent Items; it appears within the next sync. |

---

## 7. What is stored on the server

- Envelope index only (from/to/subject/date/flags/attachment names) for the
  last 180 days (extendable per account with "Load older").
- No message bodies, no attachment bytes — fetched from the provider on open.
  An attachment is stored only when a user explicitly saves it to Documents.
- Credentials sealed with the key above; never returned by any API.

---

## 8. Development & tests

Set `MAIL_FAKE_PROVIDER=1` to run the app against an in-memory fake mail
provider instead of real IMAP/OAuth — no external accounts, tokens, or
network calls needed. Every account created while the flag is set uses it
(there is no per-account choice), which is why it is a dev/E2E-only switch
and must **never** be set in production.

With the flag on, two extra routes exist purely to drive the fake provider
from tests:

- `POST /api/mail/_test/seed` — create or reuse the caller's fake mail
  account and seed it with threads (proper References/In-Reply-To chains, so
  they thread the same way real mail does).
- `POST /api/mail/_test/inject` — inject an inbound message onto an existing
  thread (or chain it off a specific message), broadcast the same way a real
  inbound message would be.

Both are registered only when `MAIL_FAKE_PROVIDER=1` at server start (a 404
otherwise) and require auth like any other mail route. The Playwright suite
(`e2e/mail.spec.ts`, `e2e/mail-item-send.spec.ts`,
`e2e/mail-rfi-reply.spec.ts`, helpers in `e2e/fixtures/mail.ts`) runs the dev
server with the flag set (`playwright.config.ts`'s `webServer`) and uses
these routes to seed an inbox, exercise reply/forward/attachment-save, send
from a project item into a thread, and drive the RFI pending-reply banner
through inject → accept.

---

## 9. What's next

Phase 1 (accounts, sync, send/receive UI, RFI email-reply capture) and Phase 2
(linking a thread to a project/customer/item, converting a thread into a
Task/RFI/Issue, opening a linked thread from any user, a "Reply" indicator on
every sent-document type, and the per-project Mail tab) are both complete.
Deliberately out of scope, per the Phase 2 spec's own non-goals:

- **Auto-linking by sender address** — a thread only gets linked to an item
  when someone does it explicitly (the "+ Link" picker, sending from that
  item, or Create-from-thread), never inferred from who it's with.
- **Reply capture on non-RFI items** — invoices, change orders, issues,
  proposals, daily reports, and pay applications only ever get the
  display-only "Reply" chip; the accept/dismiss-into-the-record flow (an
  inbound reply becoming the item's actual answer) stays RFI-only.
- **Attachment auto-copy on conversion** — creating a Task/RFI/Issue from a
  thread does not carry that thread's attachments onto the new item.
- **Repairing attachments stacked before the save/overwrite fix** — copies
  that piled up as extra document versions before that bug was fixed are not
  retroactively cleaned up; the bytes stay as version rows, and removing them
  is a manual job if wanted.
