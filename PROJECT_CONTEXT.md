# SpeakCue

SpeakCue is an in room AI presentation coach.

Hackathon target:
12 September 2026 Agents Everywhere Hackathon Singapore.

Current build target:
SpeakCue Laptop MVP.

The Raspberry Pi version is future work and must not distract from the
hackathon MVP.

Project direction:

SpeakCue is built with GPT-6 Astra in Codex. The MVP will also use GPT-6 Astra through the OpenAI API for contextual post presentation coaching once the core live agent works.

Architecture rules:

- Fast live cues should run locally where possible.
- Do not send every live presentation signal to Astra.
- Use Astra where context and judgement add value, especially post presentation coaching and presentation structure feedback.
- Never expose an OpenAI API key in browser code.
- Do not add the Astra API yet. It comes only after the core live agent works.

Core agent loop:

Observe → assess → decide → cue or stay quiet → observe again.

The agent should decide:

- whether an issue is meaningful
- whether it has lasted long enough
- whether another cue was given too recently
- which issue has priority
- whether a cue would help
- whether staying quiet is better

Core user flow:

Start
→ choose Live Coach or Review After
→ present
→ receive feedback
→ stop
→ view speaker profile

Core MVP:

- laptop built in microphone
- laptop built in camera
- start and stop session
- Live Coach mode
- Review After mode
- transcript
- pace
- pauses
- filler words
- camera facing time
- Coach Agent
- SLOW DOWN
- PAUSE
- LOOK UP
- ability for agent to stay quiet
- cooldown between live cues
- post presentation speaker profile
- presentation structure feedback
- coaching score
- speaker self report before and after presentation

Later only if the core works:

- vocal variety
- Audience Pulse

Audience Pulse is the one affective computing component.

It estimates changes in group engagement from observable cues such as
face presence, head direction, sustained look away and sustained head down.

It must not label people as bored, happy, frustrated or other emotional states.

Possible adaptive cues:

RE ENGAGE
ASK A QUESTION

Do not build Audience Pulse until the core SpeakCue MVP works.
