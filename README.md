# Pilot — AI Browser Copilot (Chrome/Edge extension)

## What's new in 1.4.6

**PDF/Excel exports for a "get me X" task are now just X — not a run
report about X.** When the goal was e.g. "get all contact us info of
bigmommy.site and save in pdf," the PDF still opened with "Pilot run
report," a restated Goal section, a Result section, and (further down) the
full click-by-click step transcript — several paragraphs of report
scaffolding around the two lines of actual contact info. When a run
produces structured data, both exports now contain just that: the PDF
opens with a short title drawn from the goal itself, then either a clean
label/value list (a single extracted item — a contact card, a profile) or
a table (multiple items — search results, a product list); the Excel
workbook is just a Data sheet. The Goal/Result headings and step transcript
are gone from this case — they only made sense for a general browsing task
that has no other content to show for itself, and still appear for that
case unchanged. If a run didn't finish cleanly, a one-line flag is added so
incomplete data is never mistaken for complete.

**Excel is now offered automatically alongside PDF (and vice versa) for
data-collection tasks.** Saying "...and save it in pdf" used to mean only
the PDF button appeared, even though the same collected data is equally
suited to a spreadsheet — Excel required separately saying "excel" (or
"spreadsheet"/"xlsx") in the goal. Now, once a run has produced structured
data, both **Download PDF** and **Download Excel** appear regardless of
which word the goal used — whichever format was actually named still
downloads automatically the moment the run finishes; the other is one
click away instead of hidden.

## What's new in 1.4.5

**Fixed: the PDF's "Extracted data" table was silently cutting off
content.** Each cell was single-line and truncated with an ellipsis to fit
its column — fine for a short value like a price, but a real problem for
anything longer: a full URL, a comma-separated list of form fields, an
address. The row was there, but the useful part of it was gone with no way
to recover it from the PDF itself. Cells now wrap onto multiple lines
instead (the row grows to fit whichever cell needs the most lines), and a
long unbroken value like a URL that's still wider than the column breaks
across lines by character instead of overflowing into the next column.
Nothing in the table gets dropped anymore; very long values are capped at 6
lines with a trailing "…" as a last resort rather than growing forever.

**Extracted data now sticks closer to what was actually asked for.** When
the goal was e.g. "find the contact info," the model would sometimes
extract everything it noticed on the page — the submit button's label, a
newsletter signup box, footer links — alongside the actual name/email,
cluttering the table with columns that weren't part of the request. The
extraction instruction is now explicit that the "data" fields should match
what the task asked for, not everything visible on the page.

## What's new in 1.4.4

**Fixed: OpenRouter's `effort: "low"` still wasn't enough for large
frontier-reasoning models.** 1.4.3 capped reasoning with
`reasoning: { effort: "low" }`, but "low" only *shrinks* the reasoning
budget — for a big reasoning-by-default model like the default free
provider (Nemotron 3 Ultra), that shrunken budget could still be most of a
step's reply, so runs kept failing with "kept replying with invalid JSON"
and a chain-of-thought preview. OpenRouter calls now send
`reasoning: { effort: "none", exclude: true }` instead, which fully turns
reasoning off on any model that supports disabling it, rather than just
capping it. A handful of models make reasoning mandatory and reject a
request that tries to turn it off (400, "reasoning is mandatory for this
endpoint") — those now automatically retry once with `effort: "low"`
instead of failing the step outright, so they degrade to the old behavior
rather than breaking.

If a run still fails this way after updating, it's worth trying a
different model in Settings → Providers — some models reason internally no
matter what the API is asked for.

## What's new in 1.4.3

**Fixed: OpenRouter's free "reasoning" models (e.g. Nemotron Ultra)
failing every step.** Some free models on OpenRouter think out loud at
length before answering — their reply is 100% chain-of-thought
("The user wants me to create an Excel file... looking at the
elements...") and it gets cut off by the token limit before ever reaching
the actual JSON action. Raising the reply budget on retry didn't help,
since the model just used the extra room to keep thinking. Two changes:
- OpenRouter calls now send `reasoning: { effort: "low", exclude: true }`
  — OpenRouter's own control for this — so the model spends less of its
  budget on reasoning and any reasoning text that does happen doesn't leak
  into the field Pilot parses as the answer.
- The retry logic now tells "reply got cut off mid-JSON" apart from
  "reply is a wall of reasoning prose that never got there" and responds
  differently: the first case gets a bigger budget next try (see 1.4.2);
  the second gets a sharper nudge ("stop reasoning, answer now") instead
  of a bigger budget, since a bigger budget was never the problem.

If a specific free model still struggles after this, it's worth trying a
non-reasoning model instead — Settings → Providers lets you swap the
model string for the same provider any time.

## What's new in 1.4.2

**Fixed: runs failing on a reply that got cut off mid-JSON.** A run could
fail after 3 tries with e.g. `{"type":"click","targetId":27` — a valid
start with no closing brace, most often seen on local (Ollama) models. The
parser only knew how to salvage stray prose *around* otherwise-complete
JSON; it now also repairs a reply that stops partway through (closes any
open string/`{`/`[`), which recovers this exact case. Each retry also asks
for a larger reply budget than the last, since this kind of cut-off often
just means the budget was a little too small for that one step. Also fixed
a real bug where Ollama's token budget was hardcoded to 500 and silently
ignored both Fast mode and the Settings value.

**Visible on-page cursor.** Pilot now shows a small pointer that visibly
glides to each element before clicking or typing, instead of acting
invisibly — including while a step is waiting for your Approve/Reject
decision in Confirm-steps mode, so you can see exactly what you're
approving before you decide, not just an outline that could be anywhere on
a busy page.

**Confirm-steps, clarified (not new — just easier to find):** the
approve/reject-per-step toggle in the top bar already existed — it's off
by default, so Pilot runs the whole task automatically end-to-end unless
you turn it on. Its tooltip now spells out exactly what "on" vs "off"
means, since this seems to have been easy to miss.

## What's new in 1.4.1

**Exports are now opt-in, driven by what you actually asked for.**
Previously the completion card always offered **Download PDF** /
**Download Excel**, whether or not the task had anything to do with a
file. Now the result just shows in the side panel's chat log by default,
and a file is only created when your goal itself says so — e.g. *"get
all info about this video and store in pdf"* or *"get all user info and
store in excel file"*. Say "pdf" and only the PDF is offered (and saved
automatically once the run finishes); say "excel"/"spreadsheet"/"xlsx"
and only the Excel file is; mention both and you get both. Ask for
neither and there's no download button at all — just the chat response.

## What's new in 1.4.0

**Fixed:** starting a new task while the previous one's steps were still on
screen used to silently overwrite them — a new run's "step 1" reused the
same DOM slot as the old run's "step 1", so the two step lists got mixed
together. Each run now starts from a clean log; anything from an earlier
run is still reviewable in the **History** tab.

**Download the result as PDF or Excel:** when a run finishes (done,
stopped, or failed), the completion card now offers **Download PDF** /
**Download Excel** buttons. Both include the goal, outcome, summary, step
count and time taken, plus the full step-by-step transcript. If the task
was about collecting a list of things (e.g. "find the top 5 laptops with
their prices"), the model can now hand back that list as structured
`data` in its finish action — it's included as a proper table in the PDF
and its own sheet in the Excel file, instead of just being buried in the
summary text.

**Better completion messages:** the side panel's result card is a proper
summary now — an icon + status ("Task complete" / "Stopped" / "Could not
finish"), step count and elapsed time, and the model's summary — instead
of a single line of text. Stopping a run (either by hitting **Stop** or by
rejecting a step in Confirm-steps mode) now always shows a clear "Stopped"
message; previously the two paths could produce inconsistent, occasionally
misleading results.

## What's new in 1.3.0

**Multiple API keys, with automatic failover:**
- Each cloud provider (OpenAI/Claude/Gemini/OpenRouter) can now hold a list
  of API keys instead of just one. Add them from Settings → Providers →
  **Add key** — an optional label (e.g. "personal", "backup") helps tell
  them apart later.
- When the key currently in use gets rate-limited, runs out of free-tier
  quota, or is rejected, Pilot automatically retries the same request on
  the next saved key — mid-run, with no manual swapping. A short note
  appears in the run log ("Switched to backup key for Gemini — previous
  key was rate-limited or out of quota.") so it's never a silent surprise.
- Rotation is "sticky": Pilot keeps using whichever key last worked and
  only moves off it when that key actually fails, so a temporary blip on
  key 1 doesn't cause pointless back-and-forth switching every step.
- A failed key isn't retried forever — it goes on a cooldown (or is marked
  invalid for outright-rejected keys) so future runs skip straight past it
  to a healthy one instead of wasting a request/timeout on it first.
  **Reset key status** in Settings clears that early once you know a daily
  quota has reset.
- **Test all keys** checks every saved key for a provider in one click;
  each key row also has its own **Test** button and a live status dot
  (ready / cooling down / invalid).

**Speed:**
- Every provider call (cloud or Ollama) now has a request timeout —
  previously a hung/slow request could stall a run indefinitely. On
  timeout, Pilot fails that attempt fast and rotates to the next key
  instead of sitting there.
- **Fast mode** (Settings → Run behavior) shortens the timeout further and
  trims the per-step reply budget for snappier runs on straightforward
  pages — off by default since a smaller budget can occasionally clip a
  longer "summary" on slower models.
- **Request timeout** is also directly configurable (5–60s) for people who
  know their provider/network needs more or less slack.

**Also new:**
- **Export / Import settings** (Settings → Backup) — saves every provider,
  key, and preference to a JSON file, e.g. before reinstalling or to carry
  your setup to another browser profile. Not encrypted — store it
  somewhere private, same as the keys themselves.
- The side panel's provider line now shows which key is active when more
  than one is saved, e.g. "Gemini · key 2/3 · gemini-2.0-flash".

Existing single-key setups keep working unchanged — the first time
Settings loads, a saved key is transparently treated as "key 1" of a list,
nothing to redo.

## What's new in 1.2.0

**Bug fixes:**
- **Provider status wasn't refreshing.** Picking a provider in Settings didn't
  update the side panel until you closed and reopened it. The panel now
  listens for storage changes and updates immediately. "Use this provider"
  also now saves the key/model fields first, so it can't activate a provider
  that was never actually saved.
- **Runs sometimes ended after one step with just "Done" and nothing else.**
  This happened when the model's reply wasn't valid JSON (truncated output,
  stray prose, or an empty response) — the agent silently faked a "finish"
  step instead of retrying. It now retries up to twice with a corrective
  prompt, uses a larger token budget so replies are less likely to get cut
  off, and — if it genuinely can't get a usable reply — shows a clearly
  red/failed step instead of a green "done" one, so it's obvious something
  went wrong instead of looking like normal success.

**New:**
- **Right-click menu** — "Open Pilot for this page" and, on selected text,
  "Ask Pilot about…" — opens the panel with your goal pre-filled.
- **Keyboard shortcut** — `Alt+Shift+P` by default, remappable at
  `chrome://extensions/shortcuts` like any other Chrome shortcut.
- **Toolbar badge** — shows the current step count while running, a green
  ✓ on success, a red `!` on failure — visible even with the panel closed.
- **Safety guardrails** — Pilot now refuses outright to act on
  banking/financial, crypto-exchange, adult-content, and piracy sites, the
  same "hard block" approach used by Claude in Chrome and Perplexity Comet
  (prompt injection on a page you're logged into is the main real-world risk
  for this category of tool). You can add your own sites to block from
  Settings → Safety.

---

An AI agent that reads the page you're on and acts on it — click, type,
scroll, navigate — one small step at a time, shown live in a side panel.
Works on any tab, with either a cloud provider (your own API key) or a fully
local model via **Ollama** — no key, no internet, nothing leaves your
machine.

**Production-oriented features:**
- **Confirm every step** — an optional safety mode that pauses before each
  click, type, or navigation and highlights the target element on the page,
  so nothing happens without your say-so. Toggle it from the side panel or
  Settings.
- **Run history** — the last 25 runs (goal, outcome, step count, timestamp)
  are saved locally and browsable from the History tab.
- **Configurable guardrails** — set the max steps per run and the pause
  between actions from Settings, instead of fixed constants.
- **API key testing** — verify a cloud provider's key with one click before
  you rely on it, no wasted run required.
- **Light/dark theme**, copy-to-clipboard transcripts, and toast
  notifications for a calmer day-to-day feel.

## Install (unpacked — works today, no store review needed)

1. Open `chrome://extensions` (or `edge://extensions` on Edge).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Click the Pilot icon in your toolbar to open the side panel. It stays
   open across tabs — no need to reopen it per page.

## Setting up a provider

Click the gear icon in the side panel (or right-click the extension icon →
**Options**).

### Cloud (OpenAI / Claude / Gemini / OpenRouter)
Paste your API key, confirm the model name, hit **Save**, then **Use this
provider**. Keys are stored in `chrome.storage.local` — sandboxed to this
extension, but not OS-keystore-encrypted, so only use a key you're
comfortable having on this device.

**Using more than one key (e.g. several free-tier accounts):** paste
another key into "Add key" — no need to remove the first one. Pilot tries
the currently-active key first and automatically falls through to the next
saved key if that one gets rate-limited or runs out of quota, so a run
keeps going instead of stopping the moment one key is exhausted. See
"What's new in 1.3.0" above for the details.

### Ollama (local, offline, $0 forever)
1. Install [Ollama](https://ollama.com) and pull a small model:
   ```
   ollama pull llama3.2:1b
   ```
2. Start the server (if it isn't already running as a background service):
   ```
   ollama serve
   ```
3. In Pilot's Settings, under **Ollama (local)**, click **Test connection**
   — it should list your pulled models. Pick one, **Save**, then **Use this
   provider**.

**If "Test connection" fails with a CORS-style error:** Ollama blocks
requests from origins it doesn't recognize by default. Restart it with:
```
OLLAMA_ORIGINS=chrome-extension://* ollama serve
```
(On Windows, set it as an environment variable first: `setx OLLAMA_ORIGINS "chrome-extension://*"`, then restart Ollama.)

**Picking a model for low-power machines:** 1–3B models (`llama3.2:1b`,
`qwen2.5:1.5b`) respond fastest and are the most forgiving on limited
RAM/CPU, at the cost of occasionally misreading a cluttered page. An 8B
model (`llama3.1:8b`) is noticeably more reliable if the machine can spare
the RAM (~6GB free recommended). Swap it any time — no need to reinstall
the extension.

## Why it stays fast even on a small local model

Every agent step sends the model a **compact list of the page's visible
interactive elements** (link text, button labels, input placeholders) —
never the raw HTML/DOM. This keeps the prompt small on purpose:

- Capped at 120 elements per page, 80 characters of label text each
  (`content.js`).
- The system prompt is one short paragraph with a strict JSON schema, so
  even a 1B model has a good shot at valid output every turn.
- Ollama calls use `format: "json"`, which constrains the model's output —
  the single biggest fix for small models wandering into prose instead of
  the action schema.
- If a small model still returns malformed JSON, the agent tries to salvage
  the first `{...}` block before giving up gracefully instead of crashing
  the run.

## How it works

1. You type a goal in the side panel and hit **Run**.
2. `background.js` asks `content.js` (injected in the active tab) for a
   snapshot of visible interactive elements.
3. That snapshot + your goal go to the selected provider, which replies
   with one JSON action.
4. `background.js` executes it (via `content.js` for click/type/scroll, or
   `chrome.tabs.update` for navigation) and repeats — capped at 12 steps —
   until the model says `finish`.
5. Every step streams into the side panel's log in real time.

## File map

```
manifest.json            – extension config (Manifest V3, side panel, permissions, commands)
background.js             – service worker: run/stop/approval loop, context menu, badge, history
content.js                 – injected into every page: DOM snapshot, action execution, highlight
lib/agent.js               – the step loop itself (prompt, parsing, retries, approval gate)
lib/providers.js           – all provider API calls, key rotation + testing (OpenAI/Anthropic/Gemini/OpenRouter/Ollama)
lib/guardrails.js          – built-in + user safety blocklist (banking/crypto/adult/piracy sites)
lib/storage.js             – chrome.storage.local wrapper (settings, prefs, keys, history)
lib/vendor/                 – vendored SheetJS + jsPDF (used only by sidepanel/export.js), MIT/Apache-2.0
sidepanel/                  – the panel UI: Run tab, History tab, approve/reject controls
sidepanel/export.js        – builds the "Download PDF" / "Download Excel" report for a finished run
sidepanel/format.js        – small text-formatting helpers shared by the panel UI and the exporter
options/                    – Settings page (behavior, safety, provider keys, Ollama setup)
icons/                      – toolbar icon
```

## Permissions, explained

- `activeTab` / `scripting` / `tabs` — read and act on the page you're
  currently viewing when you run the agent.
- `sidePanel` — the persistent panel UI.
- `contextMenus` — the right-click "Ask Pilot about…" entries.
- `storage` — save your provider settings locally, plus a short-lived
  session value used to hand a goal from the context menu to the panel.
- `host_permissions` for each cloud provider's API domain, plus
  `localhost`/`127.0.0.1` for Ollama. No other network access.

## Compatibility

Manifest V3, so it works unpacked in any current Chromium-based browser:
Chrome, Edge, Brave, Opera, Vivaldi. Not supported on Firefox (different
extension API) or on mobile browsers (extensions aren't supported there —
see the note in-chat about why a mobile-web version can't replicate this).
