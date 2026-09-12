# SpeakCue Handoff

## Current status

SpeakCue Laptop MVP is the active hackathon build for the 12 September 2026
Agents Everywhere Hackathon Singapore. This is the work-computer handoff for
continuing on the home laptop.

Completed implementation stages:

- Stage 1: microphone to transcript.
- Stage 2: estimated pace.
- Stage 3: stateful Coach Agent with SLOW DOWN.
- Stage 4: pause detection and PAUSE.
- Stage 5: filler word analysis.
- Stage 6: camera-facing analysis and LOOK UP.
- Stage 6B: sustained no-face can also trigger LOOK UP.
- Stage 7: deterministic Speaker Profile.
- Stage 7B: recognition coverage based data quality.
- Stage 7C: multiple measured improvement areas.
- Stage 8: GPT-6 Astra post-presentation architecture implemented.
- Stage 8B: Astra diagnostics implemented.

Stage 8 implementation is complete, but a successful real presentation review
is still an outstanding live acceptance test. Raspberry Pi and Audience Pulse
remain future work.

## What works

The presenter reports successful live tests of:

- Microphone transcription.
- Automatic speech-recognition recovery.
- Estimated pace.
- SLOW DOWN.
- PAUSE.
- LOOK UP.
- Shared cooldown and cue priority.
- Filler word analysis.
- Camera-facing analysis.
- Sustained no-face LOOK UP logic.
- Deterministic post-presentation Speaker Profile.
- Recognition coverage.
- Astra connectivity test.

Current Coach Agent priority, highest first:

1. PAUSE
2. LOOK UP
3. SLOW DOWN

Live coaching remains local and deterministic. All live cues share a 30-second
cooldown and display for about three seconds. Pace uses a 20-second rolling
window and warm-up; SLOW DOWN requires pace above 180 WPM for eight seconds.
PAUSE uses local microphone levels, a 0.6-second meaningful pause and a
25-second continuous-speaking threshold.

LOOK UP requires six seconds of fresh not-facing evidence, or a separate
six-second no-face episode with an active camera after warm-up. Unavailable
and stale camera data cannot trigger LOOK UP. Facing classifications and
no-face episodes are not combined to establish persistence. Camera-facing
percentage excludes no-face, unavailable and stale observations.

The measured profile shows at most two strengths and three improvements,
ranked by supported evidence: very fast pace, pauses, camera facing, fillers.
Recognition coverage measures availability, not transcription accuracy:
90% or more is reliable; 70% to below 90% is partial; below 70% is insufficient.

## Astra status

- OpenAI model: `gpt-6-astra` (configurable through `OPENAI_MODEL`; no fallback).
- The official OpenAI Python SDK is installed on the work computer.
- Current direct requirements: `openai==3.13.0` and `pydantic==2.13.5`.
- Astra structured connectivity test PASSED, as reported by the presenter
  in this handoff request.
- The API key was accepted and structured response validation passed.
- A real SpeakCue Astra post-presentation review has NOT yet been confirmed
  successful.

The earlier Codex-launched connectivity check found no key in its own
process environment. The presenter's later successful connectivity test
supersedes that result for the terminal in which it was run. Credentials in
one terminal are not automatically available to another terminal or an
already running server.

The presenter reports that the latest PowerShell screenshot showed the
server launch command still at the continuation prompt (`>>`). Therefore,
the latest failed browser Astra review must not be treated as proof that the
current Stage 8B server failed. A `>>` prompt is not confirmation that Python
has started. Wait for the SpeakCue localhost startup message.

The next task at home is to start the server correctly, run one real
presentation and inspect Stage 8B diagnostics if the review fails.

Stage 8B provides `python -B -m server.check_astra`, an explicit, tiny
Structured Outputs check with no presentation transcript. It makes at most
one API request. Automatic SDK retries are disabled for checks and reviews.
The review timeout is 90 seconds; browser waiting times out after 95 seconds.

Set `SPEAKCUE_DEVELOPMENT=1` before starting the server to show safe categories
in browser failures. Otherwise the browser uses the generic unavailable
message. The measured profile remains visible after an Astra failure.

Safe categories include missing/invalid key, quota/billing problem, rate
limit, model access denied, model not found, ambiguous model availability,
API access denied, malformed request, schema validation failure, timeout,
network failure and other API error. Do not inspect or share raw exceptions
or session request bodies.

## Tests passed

Latest verified full-suite results for the current Stage 8B implementation:

- JavaScript: **217 passed, 0 failed**.
- Python: **51 passed, 0 failed**.

These are the latest completed test runs from the preceding implementation
work, supported by the current Stage 8B test files. Earlier Stage 6B totals
were 215 JavaScript and 37 Python tests; those are superseded, not additional
tests. No test totals are inferred from the live connectivity check.

The suites use synthetic observations, mocked API responses and local HTTP
boundaries; they do not require real microphone/camera input or paid API calls.
After setting the home Python path below, run if needed:

```powershell
node --test tests/*.test.mjs
& $speakCuePython -B -m unittest discover -s tests -p 'test_*.py' -q
```

Node.js is needed for the JavaScript tests, not to serve the app.

## Browser status

Preferred hackathon browser: **Chrome**.

Chrome has been more stable in the presenter's live speech-recognition and
camera-coaching tests.

Edge:

- Produces better punctuation.
- Preserves more vocal fillers.
- Has shown unwanted automatic speech-recognition stops.

Firefox: the current SpeechRecognition path is unavailable.

These are observations from the tested browsers and devices, not guarantees
for every browser version. Recheck permissions and camera behaviour at home.

## Known issues

1. Chrome can omit vocal fillers such as um and uh from its transcript.
2. Edge captures fillers better but has stopped recognition unexpectedly.
3. Filler normalisation supports common variants, but transcription quality
   still limits what can be counted. Current aliases are umm to um and uhh
   to uh; erm and ah are also configured. Phrase fillers remain supported.
4. Camera-facing is not eye contact or audience attention. No emotion is inferred.
5. Camera coverage may be incomplete. Percentage describes valid facing
   classifications only. Sustained no-face cues may produce a separate note
   that the presenter was not visible to the camera.
6. Vision diagnostics are enabled for testing. Hide them before the hackathon
   demo by setting `SHOW_VISION_DIAGNOSTICS = false` in `app/app.js` later.
7. Session duration is still displayed in seconds. Change to minutes and
   seconds later, after successful Astra review.
8. Extend filler normalisation later for long variants such as ummmm and uhhh.
9. Astra real post-presentation review still needs one successful live test.

## How to run at home

Wait for OneDrive to finish syncing on the work computer and home laptop.
Ensure the project and `app/vendor/mediapipe/` assets are available locally,
not just online placeholders. The Python environment and key do not sync.

1. Open the synced `000_SpeakCue` folder as a Codex project.
2. Read `AGENTS.md`, `PROJECT_CONTEXT.md`, `README.md` and `HANDOFF.md` fully.
3. Open a normal PowerShell terminal in the synced project root (the folder
   containing `requirements.txt`). Create/use a home-local virtual environment
   outside OneDrive. Do not copy the work computer's environment path.
4. Install requirements into that environment only if needed. `openai` is the
   official API client; `pydantic` validates structured inputs and outputs.
   No Flask, FastAPI, dotenv or database is needed.

Run these setup commands in the project root on the home laptop:

```powershell
# Run only if this home-local virtual environment does not already exist:
python -m venv "$env:LOCALAPPDATA\SpeakCue\.venv"

$speakCuePython = "$env:LOCALAPPDATA\SpeakCue\.venv\Scripts\python.exe"
# Run if requirements are not already installed in that environment:
& $speakCuePython -m pip install -r requirements.txt
```

Python must already be installed and available as `python`. These paths are
resolved on the home laptop in normal PowerShell and are outside OneDrive.
Use this same terminal for the key, connectivity check and server.

5. Enter the key privately through a masked prompt. Do not put a literal key
   in a command, project file or chat.
6. Set the exact model and enable development diagnostics:

```powershell
$speakCueSecret = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $speakCueSecret).Password
Remove-Variable speakCueSecret
$env:OPENAI_MODEL = 'gpt-6-astra'
$env:SPEAKCUE_DEVELOPMENT = '1'
```

7. Run one connectivity check:

```powershell
& $speakCuePython -B -m server.check_astra
```

Expected final success line:

```text
Connectivity OK: gpt-6-astra; key accepted; structured response validated.
```

If it fails, stop and inspect only the safe category. Do not automatically
retry or switch models.

8. After successful connectivity, start the server with this single command:

```powershell
& $speakCuePython -B -u -m server
```

If PowerShell is already at `>>`, press Ctrl+C to cancel the unfinished
command, return to the normal prompt, then enter the single server command.
Wait for startup output confirming:

```text
OPENAI_API_KEY present: yes
OPENAI_MODEL: gpt-6-astra
SpeakCue: http://127.0.0.1:8000 — open in Chrome. Ctrl+C stops the server.
```

Keep that terminal open. If port 8000 is occupied, stop the earlier local
server first. Use the Stage 8B server above, not `python -m http.server`;
the plain static server does not provide the Astra endpoint.

9. Open http://127.0.0.1:8000 in Chrome and allow microphone/camera access.

After finishing, press Ctrl+C to stop the server, then clear the terminal's
key environment variable:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
```

## Next task

1. Start the Stage 8B server correctly on the home laptop using the startup
   process above.
2. Confirm Astra connectivity (one explicit check before the server launch).
3. Run one 60–90 second presentation with a clear opening, main point,
   transition and conclusion.
4. Stop once.
5. Confirm Astra Coach returns Coach summary, strengths, improvements,
   structure review, readable transcript and limitations where applicable.
   Empty supported-feedback lists or no limitations may be valid; do not
   manufacture content just to fill sections. Look for “Coaching review ready.”
6. If it fails, inspect only the safe Stage 8B diagnostic category. Preserve
   the measured profile and do not repeatedly make paid requests automatically.
7. Once Astra succeeds, do small polish: duration in minutes and seconds,
   longer um/uh filler variants, then hide vision diagnostics.
8. Prepare the hackathon demo and GitHub submission.

Verify Astra evidence numbers against the measured profile and compare the
spoken words in the original and readable transcripts. Measured facts remain
authoritative; `evidenceRefs` selects server-owned facts. Readable transcript
changes are limited to punctuation, capitalisation, paragraph breaks and
whitespace; server validation rejects changed word sequences. These safeguards
must remain in place when diagnosing a failure.

## Security

- Never store `OPENAI_API_KEY` in project files.
- Never commit API keys to GitHub.
- Supply the API key through an environment variable using a masked prompt.
- Never expose the API key in browser code or diagnostic logs.
- Keep virtual environments outside the OneDrive project.
- No raw audio, video or camera landmarks are sent to Astra.
- Astra receives transcript text, measured session data, cue counts and
  data-quality information only, with derived evidence/quality guidance.
- Live coaching remains local. Browser speech recognition may independently
  send audio to its provider; that is separate from Astra review.
- No database or saved session archive is implemented. API requests use
  `store=False`; this does not override OpenAI service retention policies.
- Never infer emotion, eye contact or audience attention from camera signals.
- Log only safe events, model name, transcript word count, validation result,
  allowlisted error category and HTTP status. Never log full session content.
