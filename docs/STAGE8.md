# Stage 8: local Astra coaching

Chrome is the preferred live browser. Edge remains available for testing.
Live coaching stays local. A manual Stop first shows the measured profile,
then sends text, numerical measurements and quality information for Astra review.
No review request is made during recognition recovery or page closure.

## Environment and dependencies

Direct dependencies: `openai==3.13.0` and `pydantic==2.13.5`.
Their supporting dependencies are installed by pip. No web framework is used.

Create a local Python environment outside the project and any cloud-synced folder.
The commands below use `%LOCALAPPDATA%\SpeakCue\.venv`, which resolves for the
current Windows user. Replace `C:\path\to\SpeakCue` with your project folder
in all examples in this document. Run these commands in PowerShell:

```powershell
Set-Location 'C:\path\to\SpeakCue'
python -m venv "$env:LOCALAPPDATA\SpeakCue\.venv"
& "$env:LOCALAPPDATA\SpeakCue\.venv\Scripts\python.exe" -m pip install -r requirements.txt
```

## Start with a key entered privately

Run these commands in PowerShell. Enter the key only at the masked prompt;
do not paste the key into a command, project file, transcript or chat.

```powershell
Set-Location 'C:\path\to\SpeakCue'
$speakCuePython = "$env:LOCALAPPDATA\SpeakCue\.venv\Scripts\python.exe"
$speakCueSecret = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $speakCueSecret).Password
Remove-Variable speakCueSecret
$env:OPENAI_MODEL = 'gpt-6-astra'
try {
    & $speakCuePython -B -m server
} finally {
    Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
}
```

Open http://127.0.0.1:8000 in Chrome. Stop any earlier server using port 8000.
This one service serves both the web app and the Astra endpoint.
Ctrl+C stops it. The key exists in process memory while the server runs and is
not written to disk. The `finally` block removes it from this PowerShell session.
Never enable raw SDK/HTTP debug logging with real session data.

`OPENAI_MODEL` defaults to the verified `gpt-6-astra` identifier. An explicit
configuration is used exactly; there is no fallback to a different model.
Missing keys or inaccessible models leave the measured profile usable.

## Data and validation

- Pydantic rejects missing/extra fields, invalid types and nonfinite values.
- Structured Outputs constrain the draft. Python also checks array lengths,
  structure states, evidence references, quality eligibility and summary length.
- Model-written numerical evidence is rejected. Metric evidence sentences are
  constructed from original measurements using `evidenceRefs`.
- Readable transcript validation compares every word in order, ignoring case
  and surrounding punctuation/whitespace. Internal apostrophes and hyphens are
  preserved conservatively. Fillers cannot disappear.
- Structure claims need a matching transcript excerpt. Partial/insufficient
  recognition or short sessions must use insufficient-evidence structure states.
- Mandatory quality limitations are preserved even if the model omits them.
- Practical wording checks reject emotion and unsupported camera claims.
  They are safeguards, not proof that every qualitative sentence is correct.
- The original transcript and measured profile are never overwritten.
- No local sessions, images, video, audio or keys are saved. OpenAI receives only
  the selected text and numerical data. Requests use `store=False`; this does not
  imply that OpenAI's separate service retention policies are disabled.

The server accepts same-origin JSON requests only, restricts static files to
`app/`, caps request size, and allows one pending API request at a time.
SDK timeout is 90 seconds with automatic retries disabled. The UI times out at
95 seconds. New sessions cancel browser waiting and ignore late results;
an API request already sent may still finish remotely.

## Tests (no real API calls)

```powershell
node --test tests/*.test.mjs
& $speakCuePython -B -m unittest discover -s tests -p 'test_*.py' -v
```

For the first live check, speak for about a minute, using an opening, a main
point and a closing. Stop, check that the measured profile appears immediately,
then wait for Astra. Compare original/readable words, review structure, check
that evidence numbers match the profile, and confirm uncertainty remains visible.
Then restart without a key and confirm the safe failure leaves the profile intact.

## Stage 8B developer diagnostics

No automatic connectivity calls or retries are made. The SDK makes at most
one request per explicit connectivity command or stopped presentation.
The key must exist in the same PowerShell session that launches Python;
a key in a different terminal does not update an already running server.

In a normal PowerShell window, stop any old SpeakCue server and run:

```powershell
Set-Location 'C:\path\to\SpeakCue'
$speakCuePython = "$env:LOCALAPPDATA\SpeakCue\.venv\Scripts\python.exe"
$speakCueSecret = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $speakCueSecret).Password
Remove-Variable speakCueSecret
$env:OPENAI_MODEL = 'gpt-6-astra'
$env:SPEAKCUE_DEVELOPMENT = '1'
```

Run the connectivity check once (no presentation transcript is sent):

```powershell
& $speakCuePython -B -m server.check_astra
```

Success ends with:

```text
Connectivity OK: gpt-6-astra; key accepted; structured response validated.
```

If it fails, read the safe category; do not repeatedly rerun it. A model-not-found
response can also mean inaccessible model when the provider reports both together.
A successful check verifies this credential/project can use the requested model
and Structured Outputs at that moment; it does not guarantee every review passes
SpeakCue's additional evidence and transcript validation.

After a successful check, start the server from the same terminal:

```powershell
try {
    & $speakCuePython -B -m server
} finally {
    Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
}
```

Startup reports key presence and the model without printing the key. Development
mode returns only an allowlisted category to the browser. Remove
`Env:SPEAKCUE_DEVELOPMENT` before starting to restore generic browser failures.
The server logs request events, model, transcript word count, validation outcome,
safe error category and HTTP status only. Never enable SDK/HTTP debug logs.

For one real review, open http://127.0.0.1:8000 in Chrome, speak for about a minute
with an opening, main point and conclusion, then select Stop once. The measured
profile should remain visible while Astra prepares its review. Success says
"Coaching review ready." Compare numerical evidence with the measured profile
and the words in the original/readable transcripts. On failure, use the category
in the terminal and development UI; no automatic retry is made.
