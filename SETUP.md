# SETUP — getting YouTube API access (one time, ~10 minutes)

You need your own Google Cloud OAuth credentials. There is no way around this:
editing *your* videos requires *your* Google account to grant permission, and
Google does not allow a third party to do that on your behalf.

Everything below is done once. After that, sign-in is a single click.

---

## Read this first — two limits that surprise everyone

**1. The daily quota is 10,000 units, and each video edit costs 50.**
That is a hard ceiling of **200 video edits per day**, and rolling back also
costs 50 per video. Quota resets at **midnight Pacific Time**, not midnight
your time. Listing videos is cheap (about 2 units per 50 videos), so browsing
costs almost nothing — only writes are expensive.

The tool tracks this for you in the header and refuses to start a batch that
would not fit. If you need more, request a quota increase:
<https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas>

**2. While the app is in "Testing" mode, refresh tokens expire after 7 days.**
This is a Google policy for unverified apps, not a bug in this tool. In practice:
expect to click **Sign in with Google** again roughly once a week. Making it
permanent would require passing Google's app verification for restricted scopes
(a security assessment) — not worth it for personal use.

---

## Step 1 — Create a project

Go to <https://console.cloud.google.com/projectcreate>

Name it something like `yt-bulk-edits`. No billing account is needed — the
YouTube Data API v3 free quota does not require a card.

## Step 2 — Enable the YouTube Data API v3

Go to <https://console.cloud.google.com/apis/library/youtube.googleapis.com>

Make sure the project you just created is selected in the top bar, then press
**Enable**.

> If you skip this, every request fails with `403 accessNotConfigured`.

## Step 3 — Configure the OAuth consent screen

Go to <https://console.cloud.google.com/apis/credentials/consent>

- **User type:** External → Create
- **App name:** `yt-bulk-edits` (anything you like)
- **User support email / developer email:** your own address
- **Scopes:** you can skip this page — the tool requests the scope at sign-in time
- **Audience → Test users:** **add your own Google account.** ← do not skip this

Leave the publishing status as **Testing**.

> This is the single most common failure. If your account is not a Test user,
> sign-in comes back with `access_denied` and no useful explanation. The tool
> detects this and tells you, but adding yourself up front avoids the round trip.

## Step 4 — Create an OAuth client ID

Go to <https://console.cloud.google.com/apis/credentials> → **+ Create Credentials**
→ **OAuth client ID**.

Choose **Desktop app** as the application type. Name it `yt-bulk-edits`.

**Why Desktop app and not Web application:** Google automatically allows any
`http://localhost` / `http://127.0.0.1` redirect URI (any port, any path) for
Desktop clients. A *Web application* client instead requires you to register each
redirect URI exactly, which is more steps and more ways to get
`redirect_uri_mismatch`. Desktop app works for all three sign-in modes here.

After creating it, copy the **Client ID** and **Client secret**.

> If you would rather use a Web application client, register this redirect URI
> exactly: `http://localhost:8787/callback`

## Step 5 — Paste the credentials into the tool

1. Double-click **`Start-tool.bat`**. A console window opens and your browser
   goes to <http://localhost:8787>.
2. In section **1 · Connect**, tab **Local sign-in**, paste your Client ID and
   Client secret into the "Give the helper your OAuth client" box and press
   **Save to helper**.
3. Press **Sign in with Google**, approve, and you are done.

The helper writes `auth-config.json` and `tokens.json` next to itself and
refreshes your access token automatically from then on.

---

## Alternative A — no Google Cloud project at all (fastest, 2 minutes)

Use the **Paste access token** tab with Google's OAuth Playground, which lends
you its own pre-registered client:

1. Open <https://developers.google.com/oauthplayground/>
2. In *Step 1*, tick **Use your own OAuth credentials** — no, leave it unticked.
   Instead, in the scope box paste:
   `https://www.googleapis.com/auth/youtube`
   (or find "YouTube Data API v3" in the list and select the `.../auth/youtube` scope)
3. Click **Authorize APIs** and sign in with the account that owns the channel.
4. In *Step 2*, click **Exchange authorization code for tokens**.
5. Copy the **Access token** (not the refresh token) into the tool's
   *Paste access token* tab and press **Connect**.

Trade-off: the token expires in about an hour, and quota is charged against the
Playground's shared project, which can be stricter. Fine for a one-off batch of a
few dozen videos; use Step 1–5 for regular work.

## Alternative B — your own client, but no helper process

Use the **Own OAuth client (code)** tab. It runs the full authorization-code flow
with PKCE inside the page:

1. Paste your Client ID (secret optional for Desktop clients).
2. Leave the redirect URI as `http://localhost:64834/callback`.
3. Press **Start sign-in**, approve in the new tab.
4. That tab lands on a page that **fails to load** — this is expected, nothing is
   listening on port 64834. Copy the *entire URL* from the address bar.
5. Paste it into the tool and press **Exchange code for tokens**.

You get a refresh token, so the session survives page reloads without any
background process.

---

## Security notes

| What | Where it lives | How to remove it |
|---|---|---|
| Access + refresh token | `tokens.json` next to `auth-helper.ps1` (helper mode) | **Sign out** in the app, or delete the file |
| Access + refresh token | browser `localStorage` (paste-token / code modes) | **Sign out** in the app |
| Client ID + secret | `auth-config.json` next to the helper | delete the file |
| Your edit history | browser `localStorage` + the JSON backups you download | **Prune restored records**, or delete a batch |

- These files are **plaintext**. Do not commit this folder to a public repo or
  put it in a shared/synced drive without excluding `tokens.json` and
  `auth-config.json`.
- The helper binds to `localhost` only. It is not reachable from other machines.
- Your videos' metadata is sent only to `youtube.googleapis.com`. No other
  server sees your tokens.
- To revoke access completely: <https://myaccount.google.com/permissions>

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `access_denied` during sign-in | Your Google account is not a **Test user** (Step 3). Add it and retry. |
| `redirect_uri_mismatch` | You created a *Web application* client without registering the exact redirect URI. Either add it, or recreate the client as **Desktop app**. |
| `403 accessNotConfigured` | The YouTube Data API v3 is not enabled in that project (Step 2). |
| `403 quotaExceeded` | You hit 10,000 units for the day. Wait for the Pacific-midnight reset or request more quota. |
| Helper says "Port 8787 is already in use" | Another copy is running — just open <http://localhost:8787>. Or start with `-Port 8790` and set that URL in the app. |
| Page says "Helper not running" but the console window is open | The page probed before the helper finished starting. It now re-checks every few seconds by itself; or press **Check again now**. Also make sure the tab is `http://localhost:8787` and not a `file://` copy of `index.html` you opened earlier. |
| **"Sign in with Google" is greyed out** | **Expected until Step 4 is done.** The helper has no OAuth client yet, so there is nothing to sign in with. Paste your Client ID and Client secret into the box directly under the button and press **Save to helper** — the button unlocks immediately, no restart needed. |
| Sign-in unlocked but clicking it does nothing | The helper's console window was closed. `Start-tool.bat`'s black window must stay open for the whole session; the helper lives in it. |
| Token expired mid-batch (paste-token mode) | Get a new token from the Playground and press Connect, then re-run. Already-applied edits stay applied and remain restorable. |
| Sign-in worked last week but not now | Testing-mode refresh tokens expire after 7 days. Sign in again. |
| Edits fail with `forbidden` on some videos | You can only edit videos the authenticated account owns. Videos on a Brand Account channel need the sign-in to pick that channel's identity. |
