# README screenshots: the demo company

This folder builds the made-up company behind the screenshots in the main
README, and takes those screenshots into docs/screenshots/. It is **separate from the e2e suite**:
its own Playwright config, its own port and data folder, and none of its files
match the e2e suite's `*.spec.ts` pattern, so `npm run test:e2e` never sees it.

## Commands

```bash
npm run demo:seed     # build, start on an EMPTY folder, fill the demo company, stop
npm run screenshots   # the same, then run every *.shots.ts spec
npm run demo:serve    # browse the seeded demo by hand on http://localhost:3100
```

`demo:serve` needs a finished `demo:seed` run (it never wipes the data) and a
build in `dist/`. Sign in as `dana.whitfield`; the password is `DEMO_PASSWORD` in
`demo-data.ts`. It is a throwaway local demo, not a real credential.

While working on the seed, `DEMO_SKIP_BUILD=1 npm run demo:seed` reuses the
existing `dist/` and finishes in seconds.

## How it runs

`playwright.readme.config.ts` starts the production server the way the e2e suite
does (`NODE_ENV=production`, `MAIL_FAKE_PROVIDER=1`), with `STORAGE_PATH`
pointing at `.demo-data/` (gitignored) and port 3100. `prepare.mjs` empties that
folder and builds first, so every run starts from a fresh database.

Two Playwright projects:

- `seed` runs `seed.setup.ts`, which calls `seedDemoCompany()` in `demo-data.ts`.
  Everything goes through the app's REST API; nothing writes to the database
  directly. It ends by writing `.demo-data/manifest.json` (ids of the projects,
  pay apps, lien releases, mail threads and so on) for the screenshot specs.
- `shots` runs every `*.shots.ts` file after `seed` has finished.

## Files

- `demo-data.ts`: the seed. People, settings, customers, projects, the plan set
  with takeoffs, proposals, billing, lien releases, documents, daily reports,
  RFIs, issues, punch items, tasks and mail.
- `demo-assets.ts`: files drawn from scratch: the two-sheet plan PDF and its
  thumbnails, the logo, site photos, simple document PDFs and a spreadsheet.
- `seed.setup.ts`, `prepare.mjs`, `serve.mjs`: the runners described above.
- `shot.ts`: shared helpers: sign in (session and theme preferences), settle the page, save a palette-compressed PNG.
- `desktop.shots.ts` (1440x900, light), `dark.shots.ts` (dashboard, takeoff canvas, mail) and `phone.shots.ts` (390x844, dashboard and a daily report): one test per screen, writing `docs/screenshots/<name>.png`. Adding a screen means adding a test that calls `open()` and `shoot()`.

## Rules for the demo content

Only made-up names: "Cedar Point Plastering" in "Riverton", people such as
`dana.whitfield`, customers such as "Harbor View Builders", addresses like
123 Example St, `example.com` emails, 555 phone numbers. Never real business or
personal details. Dates are relative to the day the seed runs.

## Known limits

- The fake mail provider cannot hold a draft: `saveDraft` keeps it in memory and
  it never reaches the Drafts folder. A draft shot has to be made in the
  composer during the screenshot run.
- Activity feeds and notifications are stamped with the time the seed ran
  ("just now"); the screenshot specs should hide relative times.
