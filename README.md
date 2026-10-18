# FrugalOmnibuild

FrugalOmnibuild is a self-hosted web app for construction contractors. It covers a job from the bid to the final lien release: plan takeoffs, proposals, project tracking, documents, billing and mail, in one place, on a server you run yourself.

It is one Node.js app with a SQLite database and a folder of files. A second container, ONLYOFFICE Docs, adds in-browser document editing. There is no subscription and no account with anyone else.

![The dashboard: items that need attention, money pulse, upcoming tasks and team activity](docs/screenshots/dashboard.png)

**Highlights**

- Measure areas, lengths and counts on PDF plans, price them, and turn them into a proposal.
- Track every project: documents, RFIs, issues, punch lists, tasks, daily reports and time.
- Bill the job: invoices, change orders, AIA G702/G703 pay applications with retainage, payments and Florida lien releases.
- Read and send mail from inside the app, and send any invoice, RFI or proposal straight from it.
- Work together live: presence, notifications, phone push and read-only share links.
- Back up to a second disk or to Google Drive, and restore onto a fresh install.

The app name shown in the sidebar, the browser tab and generated PDFs is a setting. New installs start as "FrugalOmnibuild".

## Contents

- [Features](#features)
  - [Estimating](#estimating)
  - [Project management](#project-management)
  - [Billing](#billing)
  - [Communication](#communication)
  - [Collaboration](#collaboration)
  - [Admin](#admin)
- [Setup](#setup)
  - [Requirements](#requirements)
  - [Running locally](#running-locally)
  - [Environment variables](#environment-variables)
  - [Docker](#docker)
  - [First-time setup](#first-time-setup)
  - [Guides](#guides)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Contributing](#contributing)

---

## Features

### Estimating

**Plan import.** Create a project and drop in PDF plan sets. Each page becomes a sheet; sheet numbers and titles come from the PDF's page labels, or from the text (or OCR) inside a box you draw on the title block, and you confirm them before saving. A new set marks matching sheets as revisions, and you can compare two revisions side by side or overlaid.

**Takeoff canvas.** Calibrate a page's scale from a known dimension (a page can have more than one scale region for details), then measure:

- **Area**, with cut-outs subtracted from it
- **Length**
- **Count**

Measurements group under named takeoffs with a colour, a price and a running total. One finger draws and two fingers pan and zoom on a phone or tablet.

![The takeoff canvas: room areas measured on a floor plan, with the takeoff list and totals on the right](docs/screenshots/takeoff-canvas.png)

**Proposals.** The Proposal tab builds a proposal from the takeoffs: pricing lines, inclusions and exclusions, a payment schedule, photos and PDF attachments, on your letterhead. Revising a sent proposal starts a new draft and keeps the old one. Accepting a proposal files the customer's signed copy and seeds the billing schedule of values from what was quoted.

![The proposal editor with pricing lines and options](docs/screenshots/proposal.png)

**Excel export.** Takeoffs export to an `.xlsx` workbook with the same columns and grouping as the Takeoffs tab.

### Project management

**Projects and stages.** A project is either Bidding or In Progress; archiving and marking a bid lost are separate actions. The Projects page lists them by stage, with a Recent / Favorites row at the top. Star a project to keep it there.

![The projects list with its Recent row](docs/screenshots/projects.png)

**Dashboard.** Cards you can rearrange: what needs your attention (overdue invoices, aging receivables, bids due soon), a money pulse, tasks on deck and team activity. Each project has its own overview with financial progress, open items and recent activity.

![A project overview](docs/screenshots/project-overview.png)

**Documents.** Every file in one list, across projects or per project: uploads, plans, proposals, invoices, pay apps, RFIs and photos, with thumbnails and version history. Older formats (.doc, .xls, .rtf, OpenDocument, Pages, Numbers, Keynote) convert to Office formats on upload. Select two or more PDFs to merge them into one, or add pages from one PDF into another at a chosen place.

![The Documents page](docs/screenshots/documents.png)

![Merging PDFs: the files in order, ready to combine](docs/screenshots/documents-merge.png)

**Document editor.** PDFs, Word files, spreadsheets and presentations open in ONLYOFFICE Docs inside the app. Several people can edit at once, with comments, @mentions, track changes and PDF form filling. Each editing session saves one new version. You can insert your saved signatures and company stamps, and start new documents from blanks or admin templates. Phones open documents read-only. Without ONLYOFFICE the rest of the app works; documents can still be previewed and downloaded.

![ONLYOFFICE Docs text editor](https://upload.wikimedia.org/wikipedia/commons/3/34/ONLYOFFICE_text_editor.png)

<sub>The ONLYOFFICE editor on its own, not inside FrugalOmnibuild. Screenshot: [ONLYOFFICE text editor.png](https://commons.wikimedia.org/wiki/File:ONLYOFFICE_text_editor.png) by Нина Горбунова, Wikimedia Commons, licensed under the [GNU GPL version 2 or later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html).</sub>

**Punch lists and checklists.** Each item has Before, In Progress and After photos, comments and a drag handle for reordering, and prints to PDF.

![A project punch list](docs/screenshots/punch.png)

**RFIs and issues.** RFIs are numbered per project, assigned, sent by email and answered; a reply to a sent RFI shows up as a pending answer to accept or dismiss. Issues track problems on site with their own numbers and status. Both can carry PDF attachments.

![A project's RFIs](docs/screenshots/rfis.png)

![A project's issues](docs/screenshots/issues.png)

**Tasks.** One task list across projects and customers, with assignees and due dates; assigning a task notifies the person.

![The task list](docs/screenshots/tasks.png)

**Daily reports.** One report per work day, with crew man-counts, field notes and issues. When the project has an address, the weather fills in from the actual hourly conditions for that day.

![The daily report editor](docs/screenshots/daily-report.png)

**Time and notes.** Crew members clock in and out against a project, and admins see the week's hours. Each project also has a notes board, and notes can be pinned to a plan page.

**Reports (admins).** Billing reports across every project, filtered by customer and project: open invoices with aging, payments received over any dates, change orders by status, and retainage held. Each downloads as Excel.

![The Reports page](docs/screenshots/reports.png)

### Billing

Billing is for admins only. Each project's Billing tab has:

- **Invoices**, numbered automatically, with PDF attachments. An invoice marks itself paid once its payments cover it.
- **Change orders**, with status, amount and schedule impact.
- **AIA pay applications**: a schedule of values, G702/G703 workbooks from your own template, retainage on work and stored materials, and a PDF to send.
- **Payments**, recorded against invoices and pay apps, with attachments.
- **Florida lien releases**: progress or final, conditional or unconditional, in the statute's wording, with a notary block. Your company's legal details fill in from Settings, and the app warns you before releasing more than has been paid.

![Invoices on a project's Billing tab](docs/screenshots/billing-invoices.png)

![A change order](docs/screenshots/billing-change-order.png)

![An AIA pay application in draft](docs/screenshots/billing-pay-app.png)

![Payments received](docs/screenshots/billing-payments.png)

![Lien releases on a project](docs/screenshots/billing-lien-releases.png)

![The lien release editor](docs/screenshots/lien-release.png)

![A lien release PDF with the notary block](docs/screenshots/lien-release-preview.png)

### Communication

**Mail.** Each person connects their own mailbox: Google Workspace or Gmail, Microsoft 365, or any IMAP/SMTP host. Threads, folders, search and drafts (with attachments) work as in a normal mail client. Remote images stay blocked until you load them, or trust a sender. Every project has a Mail tab with its own threads.

![A mail thread](docs/screenshots/mail-thread.png)

![A newsletter with its remote images blocked](docs/screenshots/mail-remote-images.png)

**Send from anywhere.** Proposals, invoices, pay apps, change orders, lien releases, RFIs, issues, daily reports and punch lists have a Send button that opens the composer with a fresh PDF attached and the recipients filled in. From a thread you can go the other way: create a task, RFI, issue, change order or invoice from it, or save its attachments into a project.

**Customers.** A customer list with contacts, separate recipients per role (general, accounting, estimating, project management), and tabs for their projects, billing and tasks.

### Collaboration

- **Live updates.** Changes show up for everyone without a reload, over Socket.io. The sidebar shows who is online, and you can follow another user's view.
- **Notifications.** A bell for @mentions, assigned tasks and RFIs, and RFI answers. Each person can also get them as phone or desktop push notifications, turned on per device.
- **Share links.** Share a document, several documents, a plan page or several pages with a read-only link that lasts 7, 30 or 90 days or never; stop sharing at any time. Recipients need no account.
- **Share to the app.** On Android, once the app is installed from the browser, share a PDF, photo or document from another app straight into a project.
- **Phone layout.** The app works on phones, including the dashboard and daily reports.

<p>
  <img src="docs/screenshots/dashboard-phone.png" alt="The dashboard on a phone" width="260">
  &nbsp;
  <img src="docs/screenshots/daily-report-phone.png" alt="A daily report on a phone" width="260">
</p>

### Admin

- **Users and roles.** Admins create users, reset passwords and set each user's role: Admin or User. Billing, proposals, reports and most settings are for admins.
- **Settings.** App name and logo, public address, company legal details, takeoff and document templates, the AIA workbook template, storage use, the document editor's connection checks, and an in-app changelog. Each person sets their own theme, signatures and phone notifications.
- **Backups.** Scheduled snapshots of the database and files to a second disk (`BACKUP_PATH`) and, optionally, to Google Drive, each with its own schedule and retention. A fresh install can restore from a backup file or from Drive at `/restore`.
- **Dark mode**, with a choice of accent colour.

![General Settings: branding and company legal details](docs/screenshots/settings.png)

![The dashboard in dark mode](docs/screenshots/dashboard-dark.png)

![The takeoff canvas in dark mode](docs/screenshots/takeoff-canvas-dark.png)

![Mail in dark mode](docs/screenshots/mail-dark.png)

---

## Setup

### Requirements

- **Node.js 22 or later** and a C/C++ toolchain, which `better-sqlite3` needs to build. On Windows and most Linux and macOS machines, `npm install` downloads a prebuilt binary and no toolchain is used.
- **Or Docker**, with Docker Compose for the app plus ONLYOFFICE.
- For document editing: ONLYOFFICE Docs on its own HTTPS address, with about 4 GB of RAM.

### Running locally

```bash
git clone https://github.com/phlurblepoot/FrugalOmnibuild.git
cd FrugalOmnibuild
npm install
npm run dev
```

The app runs at <http://localhost:3000>. `npm run dev` starts the Express server with Vite in development mode, so the front end reloads as you edit. Data goes to `./data` unless `STORAGE_PATH` says otherwise.

For a production build on the same machine:

```bash
npm run build                  # builds the front end into dist/
NODE_ENV=production npx tsx server.ts
```

The server runs TypeScript directly through `tsx`; there is no separate server build.

### Environment variables

The server reads a `.env` file in the working folder if there is one. Every variable is optional.

**Core**

| Variable | Default | What it does |
|---|---|---|
| `STORAGE_PATH` | `./data` | Folder for the SQLite database (`app.db`), uploaded files, versions, thumbnails and generated PDFs. |
| `PORT` | `3000` | Port the server listens on. |
| `NODE_ENV` | | `production` serves the built front end from `dist/`; anything else runs Vite in development mode. |
| `JWT_SECRET` | generated | Signs sign-in tokens. Unset, the server generates one on first start and keeps it in the database. |
| `APP_PUBLIC_URL` | | The HTTPS address people reach the app on, such as `https://app.example.com`. Mail sign-in (Google, Microsoft) and Google Drive backups build their links from it, and the document editor and push notifications fall back on it. |
| `BACKUP_PATH` | under `STORAGE_PATH` | Where backups are written. Point it at a second disk. |

`.env.example` still names `DATA_DIR` and `APP_URL`. The server reads neither: use `STORAGE_PATH` for the data folder and `APP_PUBLIC_URL` for the public address.

**Document editor (ONLYOFFICE)**

| Variable | What it does |
|---|---|
| `ONLYOFFICE_PUBLIC_URL` | The HTTPS address browsers load the editor from. Unset, the document editor reports "not configured". |
| `ONLYOFFICE_INTERNAL_URL` | How the app reaches ONLYOFFICE server to server. Defaults to `ONLYOFFICE_PUBLIC_URL`. |
| `APP_INTERNAL_URL` | How ONLYOFFICE reaches the app server to server. Defaults to `APP_PUBLIC_URL`. |
| `ONLYOFFICE_JWT_SECRET` | Shared secret; must equal `JWT_SECRET` on the ONLYOFFICE container. |

**Mail and Google Drive** (see [docs/mail-setup.md](docs/mail-setup.md))

| Variable | What it does |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google sign-in for Gmail accounts and Google Drive backups. |
| `GOOGLE_PUBSUB_TOPIC` | Turns on Gmail real-time push. Unset, Gmail polls. |
| `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET` | Microsoft 365 sign-in. |
| `MS_OAUTH_TENANT` | Tenant id for a single-tenant app registration. Defaults to `common`. |
| `MAIL_SECRET_KEY` | Encrypts stored mail credentials. Unset, the server generates `mail.key` in the data folder; back it up with the data. |
| `MAIL_FAKE_PROVIDER` | `1` swaps every mailbox for an in-memory fake. Tests only. |

**Phone notifications**

| Variable | What it does |
|---|---|
| `PUSH_CONTACT` | A `mailto:` address or `https:` URL that push services can contact. Defaults to `APP_PUBLIC_URL`. The server makes its own keys on first use. |

**AI sheet reading** (CUDA image only; see [docs/ai-sheet-reading-runbook.md](docs/ai-sheet-reading-runbook.md))

`AI_ENABLED`, `AI_MODEL_HF`, `AI_MODEL_PATH`, `AI_MMPROJ_PATH`, `AI_MODELS_DIR`, `LLAMA_CACHE`, `AI_LLAMA_SERVER_BIN`, `AI_HOST`, `AI_PORT`, `AI_GPU_LAYERS`, `AI_TIMEOUT_MS`, `AI_STARTUP_TIMEOUT_MS`. The standard image has no local model, so this feature is off there and sheet names come from page labels and OCR.

### Docker

Images are published to the GitHub Container Registry:

| Image | Built from |
|---|---|
| `ghcr.io/phlurblepoot/frugalomnibuild:main` | `main`, the stable branch |
| `ghcr.io/phlurblepoot/frugalomnibuild:testing` | `testing`, the integration branch |
| `ghcr.io/phlurblepoot/frugalomnibuild:cuda-stable` | `main`, with llama.cpp for AI sheet reading on an NVIDIA GPU |
| `ghcr.io/phlurblepoot/frugalomnibuild:cuda` | `testing`, the same GPU build |

The app alone:

```bash
docker run -d --name frugalomnibuild \
  -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/phlurblepoot/frugalomnibuild:main
```

The image sets `NODE_ENV=production`, `STORAGE_PATH=/app/data` and `PORT=3000`. Keep `/app/data` on a volume: it holds everything.

**With ONLYOFFICE.** `docker-compose.yml` runs the app and ONLYOFFICE Docs (Community Edition, pinned to a tested version) on one network. It builds the app from source; to use the published image instead, replace `build: .` under `app` with `image: ghcr.io/phlurblepoot/frugalomnibuild:main`.

```bash
# Once: the secret the two containers share
echo "ONLYOFFICE_JWT_SECRET=$(openssl rand -hex 32)" >> .env
# Then set ONLYOFFICE_PUBLIC_URL in docker-compose.yml to ONLYOFFICE's HTTPS address
docker compose up -d
```

ONLYOFFICE needs its own HTTPS address, because browsers load the editor from it. Behind a reverse proxy such as Cloudflare or Nginx Proxy Manager, the app trusts one proxy hop, so sign-in rate limits see each person's real address. [docs/onlyoffice-setup.md](docs/onlyoffice-setup.md) walks through the whole setup.

### First-time setup

1. Open the app. On its first start with no users, the server creates an admin account with user name `admin` and password `admin`.
2. Sign in, then change that password straight away under **Settings → User Preferences**.
3. In **Settings → General Settings**, set the app name and logo, the public host address used in share links, and your company's legal details.
4. Add your team under **Settings → User Management**.
5. Optional: connect ONLYOFFICE and check that **Settings → Document Editor** shows three green Working checks; connect mail under **Settings → Mail**; set up backups under **Settings → Backup**.

Moving an existing install to a new server? Start the new one empty, sign in as `admin`, and open `/restore` to restore a backup file or a Google Drive snapshot.

### Guides

- [docs/onlyoffice-setup.md](docs/onlyoffice-setup.md): ONLYOFFICE Docs, reverse proxy, connection checks, upgrades, and phone notifications.
- [docs/mail-setup.md](docs/mail-setup.md): Google, Microsoft 365 and IMAP mail.
- Backups: [Google Drive backups](docs/mail-setup.md#41-google-drive-backups) and [backups and the key file](docs/mail-setup.md#5-backups-and-the-key-file) in the mail guide, plus **Settings → Backup → Setup guide** in the app. `npm run backup` and `npm run restore` copy a whole data folder from the command line.
- [docs/ai-sheet-reading-runbook.md](docs/ai-sheet-reading-runbook.md): the GPU image and local AI sheet reading.

---

## Tech stack

- **Front end:** React 19, TypeScript, Vite 6, Tailwind CSS 4, React Router, Konva (the takeoff canvas), pdf.js and pdf-lib (reading and writing PDFs), jsPDF, TipTap (the mail composer), Tesseract.js (OCR), lucide-react and Motion.
- **Server:** Node.js 22+, Express 4, better-sqlite3, Socket.io, jsonwebtoken and bcryptjs, nodemailer and imapflow, web-push, sharp, ExcelJS and SheetJS.
- **Documents:** ONLYOFFICE Docs Community Edition as a second container.
- **Deploy:** Docker on `node:22-bookworm-slim`; a CUDA image adds llama.cpp.

## Project layout

```
server.ts        Server entry: database, auth, routes, Socket.io, Vite or dist/
server/          API routes and stores (billing, mail, backup, onlyoffice, realtime, ...)
src/             React front end: pages/, components/, cards/, utils/
public/          Service worker, icons, static files
e2e/             Playwright tests; e2e/readme/ builds the demo data and screenshots
scripts/         Backup, restore and migration command-line tools
docs/            Setup guides and the README screenshots
```

## Tests

```bash
npm run lint          # type-check with tsc --noEmit
npm test              # unit and component tests (Vitest, jsdom)
npm run test:e2e      # end-to-end tests (Playwright, Chromium)
npm run screenshots   # rebuild the demo company and every image in docs/screenshots/
```

Unit tests sit next to the code as `*.test.ts(x)`. The end-to-end suite builds the app and starts it on port 3000 with a throwaway data folder (`.e2e-data`) and the fake mail provider; install the browser once with `npx playwright install chromium`. The screenshot run uses a made-up company on port 3100 and its own `.demo-data` folder; see [e2e/readme/README.md](e2e/readme/README.md).

## Contributing

- `main` is the stable branch; `testing` is where changes land first. Open pull requests against `testing`.
- Run `npm run lint` and `npm test` before pushing, and `npm run test:e2e` for changes that touch a whole flow.
- A change people will notice gets a line in the in-app changelog (`src/pages/Settings.tsx`) and a version bump in `package.json`.
- Use made-up names, `example.com` addresses and the demo company in tests, fixtures and screenshots, never real people or businesses.
