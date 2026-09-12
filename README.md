# SpeakCue

SpeakCue is an in-room presentation coach for the laptop MVP.

Observe → assess → decide → cue or stay quiet → observe again.

The browser measures speech pace, pauses, filler patterns and camera facing.
The local Coach Agent selects PAUSE, LOOK UP, SLOW DOWN or QUIET with a shared
cooldown. After Stop, a measured Speaker Profile appears before a separate
GPT-6 Astra contextual review, structure feedback and readable transcript.

Chrome is the preferred browser; Edge remains supported for testing.

## Run

See [Stage 8 setup](docs/STAGE8.md) for the installed Python environment,
masked API-key entry, exact startup commands and tests.
One local Python server serves both the web app and `/api/astra-review` at
http://127.0.0.1:8000. The measured profile still works when Astra is unavailable.

## Project structure

- `app/`: plain HTML, CSS and JavaScript; local measurements, coaching and review UI.
- `app/vendor/`: locally served camera model/runtime.
- `server/`: localhost server, OpenAI request and strict validation.
- `tests/`: synthetic JavaScript and Python tests; no live API calls required.
- `docs/`: setup and operating instructions.
- `requirements.txt`: two direct Python dependencies.

No database, accounts, saved sessions or live Astra coaching. Camera images,
video, raw audio and landmarks are never included in Astra review requests.
Raspberry Pi and Audience Pulse remain future work.
