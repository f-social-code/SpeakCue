# SpeakCue

SpeakCue is an in-room AI presentation coach that observes a live presentation,
decides when a short coaching cue would help, and provides a contextual review
after the talk.

Built for the Agents Everywhere Hackathon, Singapore, 12 September 2026.

## The problem

Public speaking feedback usually comes after the presentation or requires a
human coach. SpeakCue gives discreet feedback while the speaker is presenting,
then provides a deeper review afterward.

## How it works

1. The laptop microphone and camera observe presentation delivery.
2. Local measurements estimate pace, pauses, filler patterns and camera facing.
3. A stateful Coach Agent decides whether to stay quiet or show a short cue.
4. Live cues include PAUSE, LOOK UP and SLOW DOWN.
5. Optional audio coaching can also speak LOOK UP using an AI-generated voice.
6. After Stop, SpeakCue creates a measured Speaker Profile.
7. GPT-6 Astra reviews the transcript and measured results to provide contextual
   coaching and presentation-structure feedback.

## Why it is an agent

SpeakCue does not wait for the presenter to ask a question. It runs an
**observe → assess → decide → act → observe** loop.

The local, deterministic Coach Agent remembers recent events, applies persistence
and cooldown rules, chooses one cue by priority and can deliberately stay quiet.

## Live coaching

**PAUSE · LOOK UP · SLOW DOWN · QUIET**

- Fast pace must persist before SLOW DOWN is shown.
- Long speaking periods without a meaningful pause can trigger PAUSE.
- Sustained camera-facing loss or no-face evidence can trigger LOOK UP.
- A shared 30-second cooldown prevents repeated interruptions.
- Current priority is PAUSE → LOOK UP → SLOW DOWN.

QUIET means no coaching interruption and no speech. Spoken cues default to Off
and currently support LOOK UP only. Text appears immediately; voice failure never
blocks text coaching. Stop or Off cancels pending and active voice playback.

## Post-presentation review

- Session duration and estimated average pace.
- Meaningful pauses and filler patterns.
- Camera facing, live cue counts and recognition coverage.
- **What worked** and **What to improve**, based on measured evidence.
- Astra Coach summary and presentation structure.
- Readable transcript and the unchanged original transcript.

Data-quality notes keep incomplete measurements visible. Astra's readable
transcript is validated to preserve the original word sequence.

## OpenAI tools used

### Codex / GPT-6 Astra

Used to build, inspect and test the project.

### GPT-6 Astra API

Used only after the presentation for contextual coaching and
presentation-structure review.

### OpenAI Agents SDK / Realtime Voice

Used for the optional AI-generated spoken LOOK UP cue. The local Coach Agent
still decides when a cue is allowed; the voice layer does not choose coaching
actions or start conversations.

## Architecture

**Browser**

- Microphone speech recognition and Web Audio pause measurement.
- Local MediaPipe face/head-direction analysis.
- Local Coach Agent, live UI and measured Speaker Profile.

**Local Python server**

- Serves SpeakCue locally and keeps the main OpenAI API key out of browser code.
- Requests GPT-6 Astra post-presentation review.
- Issues short-lived browser credentials for optional realtime voice.

**OpenAI**

- GPT-6 Astra for contextual review.
- Realtime voice for the optional audio cue.

## Privacy and responsible use

- Raw camera video is not uploaded to OpenAI; MediaPipe vision analysis runs locally.
- Raw microphone audio is not sent to the Realtime voice service. Only the approved
  cue phrase is sent for speech generation.
- Browser speech recognition may separately send audio to its provider.
- Astra receives transcript text, measured session data, cue counts and
  data-quality information.
- SpeakCue does not infer emotion. Camera facing is not presented as eye contact
  or audience attention.
- Measured results remain authoritative and usable if Astra is unavailable.
- Spoken cues use an AI-generated voice. Earphones help prevent speaker audio
  entering the microphone and transcript; transcript words are not removed to hide it.
- SpeakCue does not save session recordings or a session archive. OpenAI service
  retention policies still apply.

## Technology

HTML, CSS, JavaScript, Python, MediaPipe Tasks Vision, OpenAI Python SDK,
GPT-6 Astra, OpenAI Agents SDK, Realtime Voice and Pydantic.

## Running locally

Use Windows PowerShell with Git and Python installed. Chrome is the preferred
browser for the current MVP. OpenAI features require an API key with access to
the configured models.

1. Clone the repository and create a Python virtual environment inside the clone:

   ```powershell
   git clone https://github.com/f-social-code/SpeakCue.git
   Set-Location SpeakCue
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install -r requirements.txt
   ```

2. Set the API key through a masked prompt and select the Astra model:

   ```powershell
   $speakCueSecret = Read-Host 'OpenAI API key' -AsSecureString
   $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $speakCueSecret).Password
   Remove-Variable speakCueSecret
   $env:OPENAI_MODEL = 'gpt-6-astra'
   ```

3. Start the server in the same terminal:

   ```powershell
   python -m server
   ```

4. Open [SpeakCue locally](http://127.0.0.1:8000) in Chrome and allow microphone
   and camera access when prompted. Keep the terminal open during the session.

The optional voice browser bundle is already included; normal users do not need
Node.js or npm build commands. See [spoken cue details](docs/SPOKEN_CUES.md) for
voice testing and [Windows setup](docs/STAGE8.md) for an environment outside the clone.

After use, press Ctrl+C and clear the key from the terminal:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
```

## Tests

Extensive JavaScript and Python tests cover pace, pauses, filler patterns,
Coach Agent decisions, vision, recognition coverage, Astra response validation,
safe failure handling and optional spoken cues.

Latest confirmed implementation test results: **278 JavaScript tests passed**;
**69 Python tests ran: 67 passed and 2 errors**. The errors were the existing
intermittent HTTP `ConnectionResetError` / `WinError 10054` in content-type and
foreign-Origin rejection tests; the issue remains open.

With Node.js installed and the Python environment activated:

```powershell
node --test tests/*.test.mjs
python -B -m unittest discover -s tests -p 'test_*.py' -v
```

The suites use synthetic observations, mocked API responses and local HTTP
checks; they do not require paid API calls. The presenter also confirmed a live
LOOK UP voice test, with approximately 1.25 seconds to playback start.

## Hackathon scope

The current hackathon MVP focuses on the laptop version. Future work includes:

- Audience-context settings.
- Broader audio coaching cues.
- Audience Pulse.
- Raspberry Pi version.

## Hackathon

Built for the Agents Everywhere Hackathon Singapore.

@OpenAI\
@AITinkerers

\#AgentsEverywhere

## Built by

Built by f-social-code for the Agents Everywhere Hackathon, Singapore.
