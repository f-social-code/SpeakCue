# Optional LOOK_UP spoken cue trial

This build adds the OpenAI Agents SDK Realtime voice path for LOOK_UP only.
The local Coach Agent still decides every cue. Astra post-presentation coaching
is unchanged. PAUSE and SLOW_DOWN remain visual only; QUIET never speaks.
Spoken cues default to Off on every page load. No voice bundle, credential
request or voice connection is needed while Off.

## Start on this laptop

The generated browser bundle is included, so normal startup needs no npm step.
In PowerShell, enter these commands separately:

```powershell
Set-Location 'C:\Users\fmwag\OneDrive - Murdoch University\000_SpeakCue'
$speakCuePython = "$env:LOCALAPPDATA\SpeakCue\.venv\Scripts\python.exe"
# Only if OPENAI_API_KEY is not already set in this terminal:
$speakCueSecret = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $speakCueSecret).Password
Remove-Variable speakCueSecret
& $speakCuePython -B -u -m server
```

Stop the previous SpeakCue server first if it is still using port 8000. Wait
for the localhost startup message, then open http://127.0.0.1:8000 in Chrome.
Keep the existing Astra model configuration. Voice uses `gpt-realtime-2.1`
and `marin`, independently of `OPENAI_MODEL`.

## Short live acceptance test (still pending)

1. Prefer earphones initially. Leave Chrome using the laptop microphone.
2. Choose Spoken cues On, then Start. Check “Spoken cues ready — LOOK UP only.”
3. Face the camera and speak with natural pauses for 20 seconds. Then turn
   away for at least six seconds. Avoid continuous speech that could trigger
   the higher-priority PAUSE cue.
4. LOOK UP must appear immediately. Keep looking away while it is relevant;
   listen for exactly “Look up.” Read the Last LOOK UP delay below the control.
5. Select Off or Stop. There must be no remaining or delayed voice. Stop still
   shows the measured profile and runs the existing Astra review.

The delay is measured from the approved cue timestamp to Web Audio playback
start, with the browser's output-device latency estimate displayed separately.
It is not a measurement of when sound physically reached your ears. There is
no 1.5-second rejection rule. A response is discarded when LOOK_UP expires
after its existing three seconds, is withdrawn by camera evidence, or the
session/voice is stopped. Active playback is stopped at that same boundary.
Do not extend visual cue timing to make a slow response pass.

Record the actual phrase, displayed delay, audible delay impression, browser,
audio output device, and whether playback was cut off or discarded. No live
delay or account entitlement has been verified by the automated tests.

### Remaining acceptance checks

- Repeat a known short presentation with voice Off and On, first with earphones
  and then laptop speakers. Also remain silent during a cue. Compare the original
  transcript, word counts, pace, pauses and longest speaking stretch around the
  cue. Record any contamination. Do not remove words or exclude audio samples.
- Look back before the response finishes: no later speech should play.
- Stop/Off during connection, generation and playback. Start again: no old cue.
- Check cooldown: another cue requires the existing 30-second cooldown plus
  fresh persistence. There is no test button that bypasses Coach rules.
- Check a voice failure while the text coach continues. Off then On explicitly
  retries; the token route limits issuance to once per ten seconds.
- Check keyboard access, a narrow window, and screen-reader announcements.

## Credentials and privacy

The existing localhost Python server provides POST `/api/voice-token`. It
requires matching local Host and Origin headers, application/json and an empty
object. It rejects presentation text, audio, model overrides and oversized
bodies. A separate lock and ten-second issuance interval protect the route
without taking Astra's review lock.

The server uses the existing Python SDK with the environment API key, a
ten-second timeout and no automatic retries. It requests a 60-second Realtime
client secret and returns only `value` and `expires_at`, with Cache-Control:
no-store. The key remains on the server; the credential stays in browser memory.
There are no credential logs or browser storage. Secret expiry limits new
connections, not the lifetime of an already established connection. Stop/Off
therefore closes the connection explicitly. The secret is not an immutable
three-phrase permission boundary.

The JavaScript SDK uses an explicit WebSocket transport. The voice adapter does
not capture, receive or send microphone samples. Its outgoing socket permits
only session.update, response.create and response.cancel; input_audio_buffer
messages and conversation-item creation are blocked. Each approved response
has `conversation: "none"`, only the approved phrase as input, and session/cue
identifiers. No transcript, camera data or measurements enter the voice path.
Input transcription and turn detection are null, tracing is disabled, and
there are no tools or handoffs. Connection does not request speech.

Audio is buffered in memory and its completed output transcript must match
“Look up.” before playback. Extra words, incomplete responses and oversized
audio are rejected. This is not proof of exact acoustic wording: model
instructions are not guaranteed, and generated transcripts are not independent
audio verification. Listen to the phrase in the live acceptance test.

The visible disclosure says “Spoken cues use an AI-generated voice.” Existing
privacy notes still apply: browser speech recognition may send microphone audio
to its own provider; camera/pause analysis remains local; Astra receives the
existing post-presentation text and measurements. Speaker audio can still be
picked up acoustically by the microphone. No transcript words are removed to
hide this. OpenAI service retention policies still apply to voice requests.

## Packages and rebuild

Direct runtime packages: `@openai/agents-realtime@0.18.0` and its Zod peer
dependency `zod@4.6.2`. Development-only `esbuild@0.28.2` bundles the SDK wrapper.
No Python package was added or upgraded. No framework or extra server was added.

```powershell
npm install --save-exact @openai/agents-realtime@0.18.0 zod@4.6.2
npm install --save-dev --save-exact esbuild@0.28.2
npm run build:voice
node --test tests/*.test.mjs
& "$env:LOCALAPPDATA\SpeakCue\.venv\Scripts\python.exe" -B -m unittest discover -s tests -p 'test_*.py' -q
```

This Codex environment had Node but no npm command. Installation used a
temporary npm 12.0.2 CLI under `%TEMP%\SpeakCue-npm-12.0.2`, with Node's
`--use-system-ca` to use Windows trusted certificates; TLS verification remained
enabled. That temporary CLI is not required to run SpeakCue. npm's audit
reported zero vulnerabilities at installation. npm blocked esbuild's postinstall
script; the separately installed Windows binary successfully built the bundle.

The optional minified SDK bundle is about 1.3 MB and loads only when voice
is enabled for a presentation. Chrome receives it gzip-compressed (about
340 KB). Only that response uses HTTP keep-alive: browser testing exposed
truncated large transfers when the local connection closed immediately.
Other responses retain their existing behaviour. A test decompresses the
download and compares every byte with the generated bundle. It uses actual
Agents SDK components, not the ordinary text-to-speech endpoint.

## Automated evidence

Before changes: 233 JavaScript tests passed. Python ran 51 tests with 50 passes
and one error: test_foreign_origin_is_rejected raised ConnectionResetError,
WinError 10054. This reproduces the existing intermittent HTTP issue.

After implementation: 265 JavaScript tests passed. The final Python run passed
all 65 tests, including 14 new tests. Earlier implementation runs reproduced
the same intermittent WinError 10054 in foreign-Origin and content-type rejection
tests (one error per run). The final passing run does not establish that this
existing issue is fixed. The existing HTTP test file and assertions were not
changed, and the issue remains open.

Tests cover Off, LOOK_UP-only mapping, immediate text, duplicate events, shared
cooldown and fresh persistence, cancellation, old sessions, unavailable SDK/API/
audio, transcript validation, buffering and a simulated 2.1-second playback
delay. A test using the installed SDK and a fake socket observed zero microphone
capture calls and only allowlisted outgoing messages. This establishes the code
path; it is not a live network capture or acoustic contamination test.

A headless Chrome check of the actual generated browser bundle passed with
synthetic camera/microphone observations and Realtime responses: default Off
made no voice request and loaded no SDK bundle; one approved LOOK_UP reached
Web Audio playback; Off preserved the text cue; Stop retained the profile;
there were zero microphone-capture calls, zero input-audio messages, zero
external requests and zero page errors. A 390-pixel window had no horizontal
overflow. Desktop and narrow screenshots were inspected. The temporary harness
is `%TEMP%\speakcue-voice-browser-check.mjs`; its test server used only fake
credentials. These checks do not establish live account access or real latency.

## Files and rollback

Modified: app/app.js, app/index.html, app/styles.css, server/__main__.py,
tests/app.test.mjs (existing assertions retained, plus voice tests).

Created: app/spoken-cues.mjs, voice/realtime-client.mjs,
app/vendor/spoken-cues-sdk.mjs, server/voice_credentials.py, package.json,
package-lock.json, .gitignore, tests/spoken-cues.test.mjs,
tests/realtime-client.test.mjs, tests/test_voice_credentials.py, this document.
node_modules contains generated installed dependencies and is ignored.

A full pre-change backup was saved at:
`C:\Users\fmwag\AppData\Local\Temp\SpeakCue-before-look-up-voice-ea1264a92d00473198fd2f6385c7faef`.
Selecting Off is the normal way to retain the text-only MVP; no rollback or npm
step is needed. Reload also returns to Off. A missing voice bundle or voice key
does not prevent text coaching. HANDOFF.md was deliberately not updated.

Adding PAUSE and SLOW_DOWN after the LOOK_UP live test passes is a small follow-up:
extend the phrase allowlist, the SDK request filter and server instructions,
then add phrase tests and repeat the acoustic/measurement checks. Connection,
credential, cancellation and playback code are shared. Do not enable them before
the LOOK_UP live acceptance result is recorded.
