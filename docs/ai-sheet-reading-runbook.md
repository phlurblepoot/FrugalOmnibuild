# AI sheet reading with Claude

When you upload a plan set, Claude can read each page and fill in its sheet
number (e.g. `A-201`) and title (e.g. `Second Floor Plan`). On a revised set it
also says which existing sheet each new page replaces. You can also draw a box
on one page and have Claude read just that box for every page.

Without Claude the app works as before: page names come from the PDF's own
text and from OCR. Nothing about uploading depends on Claude, so if Claude is
not connected, is out of usage, or fails, the upload still finishes and the
pages keep the names they already had.

## What is sent to Anthropic

Nothing is sent until someone clicks **AI Scan** on the naming screen, or picks
the **AI read** engine in the extract tool. Then, for each page:

- the whole sheet as an image (1568 pixels on the long side, which is the most
  Claude looks at);
- the same sheet in four quarters, each at that size, so small print is twice
  as sharp wherever it is on the sheet and whichever way it is turned. Always
  full-size images, rendered from the stored PDF; never the small previews;
- for PDF pages, the page's largest text (sheet numbers, titles, drawing labels)
  with where each sits and which way it is turned;
- the text the PDF already holds for that page, if any;
- what Claude learned from the earlier pages of the same set: short notes on
  where this set keeps its sheet number and title, and the sheets read so far.

Claude reads the whole page to understand its layout, so it does not assume
where the title block is. When a sheet has no printed title (two elevations on
a page, each with its own label, say), Claude names the sheet from what is
drawn on it, e.g. "Exterior Elevations". The first page of a scan is read on
its own; the rest follow the set's layout, except a sheet that differs, such
as a cover.

For the extract tool's **AI read**, only the box you drew is sent.

Claude is called with no tools: it can only look and answer. Requests go one
at a time, so a 200-page set does not trip rate limits.

## Connect Claude (admin)

Open **Settings → User Preferences → AI Sheet Reading**. Choose one way to
connect.

### A. Your Claude subscription (Pro or Max), for your own private install

1. On any computer with [Claude Code](https://code.claude.com/docs) installed,
   run:

   ```bash
   claude setup-token
   ```

   Sign in with your Claude account in the browser it opens. It prints a token
   that starts with `sk-ant-`. The token lasts a year.

   No other computer? Run the same thing on the server; the image includes
   Claude Code:

   ```bash
   docker exec -it <container> claude setup-token
   ```

2. Choose **Claude subscription (Pro or Max)**, paste the token, and click
   **Connect**.
3. Click **Test connection**. It should say *Claude answered*.

Reading counts against your plan's usage limits, like using Claude yourself.
When you hit the limit, AI Scan says so, and the pages keep their names until
you try again later.

This is for your own private install. If the app is ever shared more widely,
use an API key (B) instead: Disconnect, paste the key, and nothing else
changes.

### B. An API key

Use this for anything shared more widely.


1. Create a key at [platform.claude.com](https://platform.claude.com/settings/keys).
2. Choose **API key**, paste it, click **Connect**, then **Test connection**.

Each sheet is billed to that account, roughly:

| Model | About |
|---|---|
| Opus 5.5 (default) | 7¢ a sheet |
| Sonnet 5.5 | 3.5¢ a sheet |
| Haiku 5.5 | 0.2¢ a sheet |

### C. Sign the server in (optional)

Instead of pasting anything, you can sign Claude Code in on the server itself:

```bash
docker exec -it <container> claude login
```

The sign-in is saved in the data folder (`/app/data/claude`, set by
`CLAUDE_CONFIG_DIR` in the image), so it survives image updates. Settings shows
it as *Signed in on the server*. To undo it, run
`docker exec -it <container> claude logout`.

A `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` variable on the container
works too, and shows as *Set on the container*. A token or key pasted in
Settings always wins over both.

## Pick the model

**Model** in the same card: **Opus 5.5** reads small print best and is the
default; **Sonnet 5.5** is cheaper; **Haiku 5.5** is fastest and cheapest. The
change applies to the next page read.

## Usage

The **Usage** part of the same card (admins only) shows:

- **Your plan's limits**, with a subscription: how much of the 5-hour limit and
  of the weekly limit is used, and when each resets. Anthropic reports these
  with every call, so they are as of the last page scan or Test connection
  (Refresh re-reads what was last reported; it does not call Claude). They
  cover your whole Claude account: claude.ai, Claude Code and this app.
  Anthropic does not say how much each app used, so under each limit the card
  shows what this app's page scans used in that same window: pages and tokens.
- **Page scans** today, in the last 7 days, this month and all time: pages,
  tokens, and their value at API prices. With an API key that is roughly what
  you are billed; with a subscription it is only a yardstick, as the plan is
  not billed per page.

The totals are kept in `claude-usage.json` in the data folder.

## Where the secret is kept

The pasted token or key is encrypted with the same key as mail passwords
(`mail.key` in the data folder, or `MAIL_SECRET_KEY`) and stored in
`claude-ai.json` in the data folder. It is never sent back to the browser:
Settings shows only *Connected* and the last 4 characters. Only admins can see
or change the connection.

If `mail.key` is lost or replaced, Claude shows as not connected; paste the
token or key again.

**Disconnect** deletes the saved token or key. It does not cancel the token
itself: to do that, revoke it in your Claude account (for a subscription
token) or delete the key at platform.claude.com.

## When something goes wrong

The naming screen says why a read failed, and so does the AI card in Settings
(*Last AI read failed: …*). The pages keep their names; use **Extract**
(text/OCR) for them.

| Message | What to do |
|---|---|
| Claude sign-in failed | The token or key was revoked or has expired. Make a new one and connect again. |
| Claude usage or rate limit reached | Wait and try again. On a subscription, the plan's limit resets after a few hours. |
| The Anthropic account has a billing problem | Add credit at platform.claude.com (API key only). |
| This Claude model is not available to this account | Pick another model. |
| Claude took too long to answer | Try again. `AI_TIMEOUT_MS` (default 120000) sets the limit per page. |

The container log shows each call's raw answer (`[ai] read-sheet raw: …`) and
the reason for each failure (`[ai] claude call failed (…)`).

## Moving from the GPU (`:cuda`) image

Up to 4.7 the app read sheets with a local model on an NVIDIA GPU, in a
separate `:cuda` image. That image is retired.

1. In Unraid, edit the container. Change **Repository** from
   `ghcr.io/phlurblepoot/frugalomnibuild:cuda` to `…:testing` (or from
   `…:cuda-stable` to `…:main`).
2. Remove the `/models` path, `--gpus all` under Extra Parameters, and the
   `NVIDIA_VISIBLE_DEVICES` variable. The old `AI_*` variables (`AI_MODEL_HF`,
   `AI_GPU_LAYERS` and so on) do nothing now and can go too.
3. Apply, then connect Claude in Settings as above.

The downloaded model files in the old `/models` folder are no longer used; you
can delete them.
