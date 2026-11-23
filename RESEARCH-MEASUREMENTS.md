# Research measurements

Every benchmark now writes a research bundle in its printed results directory.
Existing saved runs can also be exported; unavailable historical measurements stay
unavailable. The instrumentation does not change agents' trust instructions.

## Windows commands

From the harness folder, verify instrumentation without a paid model request:

```powershell
.\harness.ps1 benchmark --worker scripted --transport socket --repeats 1 --no-helpers --output runs\research-check
.\harness.ps1 benchmark --worker pi-faux --repeats 1 --no-helpers --output runs\research-pi-check
```

`scripted` has no model and zero model tokens. `pi-faux` exercises the installed Pi
SDK with synthetic responses and synthetic token counts. Neither measures real
model performance. Local-model connection configuration is separate work.

For your current saved login, a real-model experiment would be:

```powershell
.\harness.ps1 benchmark --worker pi --auth pi-login --provider openai-codex --model gpt-6-sol --transport socket --repeats 3 --output runs\paper-pilot
```

This makes real model requests. Without feature flags, benchmarks compare the four
existing communication presets. `--no-helpers` selects a single custom configuration
with helpers disabled. Keep the model, task inputs, concurrency, deadlines and
generation settings fixed when comparing communication conditions.

Export an existing run (replace RUN_ID and database path):

```powershell
.\harness.ps1 export RUN_ID --db runs\example.sqlite --output runs\example-export.json
```

The original JSON export remains, with a sibling `example-export.json.research`
directory. Exporting a stopped service avoids the live RPC's 8 MiB frame limit for
large transcripts. Historical exports capture the current exporter environment and
source hashes; these are not evidence of the code/hardware used for the old run.

## Bundle

| File | Meaning |
| --- | --- |
| manifest.json | Schema, source SHA-256 hashes, local hardware/software, benchmark settings, generation defaults, per-run configurations and export file checksums |
| calls.csv | One row per harness decision/work/helper attempt; includes failures and retries, stable call ID, agent/parent, tokens and timing |
| messages.csv | Direct messages, subject posts and task envelopes; body, author, target, evidence references, UTF-8 body bytes and originating decision call when known |
| message-events.csv | Created, send started/acknowledged/failed, received/expired, prompt exposure and recipient-turn-applied records |
| trials.csv | Trial outcomes, transport, elapsed time, token totals and observed subtotals, completeness and communication counts |
| events.jsonl | Original journal event IDs, run IDs, sequence numbers and UTC timestamps |
| transcripts.jsonl | Captured system/user prompt strings, assistant content blocks, raw SDK usage and model identifiers for completed/returned Pi invocations |
| results.json / results.csv | Existing benchmark outputs; JSON also contains reports and summaries |

`manifest.json` is written last with checksums of the research files. Verify the
checksums on a completed export before analysis; files are refreshed while a
benchmark runs. CSV nulls are blank cells, distinct from numeric zero. JSON uses
null. No authentication headers, environment variables, login files or API keys are
captured by this instrumentation. Supplied prompt/evidence text is preserved, so
review transcripts before publishing them. Export files are data, not commands.

## Token accounting

Usage comes from the SDK, never the model's JSON claims. Preserve raw SDK counters
in transcripts. Pi's normalized input is `input + cacheRead + cacheWrite` and output
is its output counter. Cache columns are subsets: do not add them again. An absent
cache counter is not a measured zero. Validate counter semantics against each local
server before using a new backend; an SDK can itself normalize server responses.

Rejected structured responses retain usage and telemetry before the harness rejects
them and retries. A missing counter, lost process, transport failure, timeout or
cancelled request can still leave usage unavailable. `usageComplete=false` identifies
these cases. Trials report complete totals as null when incomplete and retain
observed subtotals. Mean tokens and tokens per success are null for an incomplete
configuration group. Legacy `results.csv` token columns remain observed subtotals;
check its missingUsage column, or prefer trials.csv for analysis.

`calls.csv` counts harness adapter attempts, not guaranteed HTTP requests. SDK-internal
retries are not independently observable. `modelInvocationObserved` and
`transcriptAvailable` distinguish captured calls from attempts with insufficient
telemetry. Scripted rows explicitly use `no-model`; Pi faux rows use `synthetic`.
Helpers have their own agent IDs and parentAgent column; legacy aggregate byAgent
reports charge helper usage to the parent. Do not sum both forms together.

Message body tokens are unavailable (`contentTokens` blank). A message can be
generated once and included in several later prompts, contributing to input usage
each time. Character counts and UTF-8 bytes are not token counts. No claim of exact
per-message token cost is made.

## Timing boundaries

Durations use monotonic process clocks. Journal timestamps are UTC append times.

- `adapterInvocationMs`: Pi adapter work from prompt construction through captured
  completion/failure; includes client overhead, not isolated server inference time.
- `attemptElapsedMs`: harness work/decision/helper attempt duration, including its
  validation and bookkeeping. Abandoned historical attempts can be null.
- Send acknowledgement `elapsedMs`: send operation through acknowledgement, including
  routing and receiver persistence. Inline values are in-process overhead, not wire
  latency. Failed sends have separate rows and durations.
- Inline trial elapsed time surrounds board execution, excluding shared worker setup
  and export generation. `manifest.settings.setupMs` records shared initialization.
- Socket trial elapsed time includes runtime startup and board execution, but excludes
  final export generation and shutdown. `startupMs` is time to runtime readiness;
  startup can overlap initial work. Do not compare this directly with inline elapsed
  time as pure socket overhead.

Concurrent agent durations overlap and must not be summed to estimate wall time.
Queue time, first-token latency, TLS handshake time, actual network bytes, GPU usage
and server-side inference time are not measured; unavailable fields remain null.
No cross-host one-way latency is inferred by subtracting unsynchronized clocks.
Transcript logging and journaling add overhead, so use the same instrumentation
settings across conditions.

## Communication definitions

A shared post is one publication, regardless of subscriber count. Each inclusion in
a captured model prompt is a separate exposure, including retry exposures. The
ledger distinguishes system seed posts, user posts and agent publications. An
`included-in-model-request` event means the message ID appears in the captured
submitted prompt and the corresponding prepared inbox (or task envelope); it is
not proof that the model read, understood, believed or used it. Without captured
telemetry, board contexts get `context-prepared-exposure-unconfirmed` instead.
Submission is observed at the Pi adapter boundary, not acknowledged by the remote
inference server. A captured failed invocation does not establish server receipt.

`recipient-turn-applied` means the harness applied the recipient's completed turn.
It is not acknowledgement of the claim's truth. Expired direct messages are not
counted as successful deliveries. A delivery attempt and a unique received message
are different counts, especially on retry. Helper delegation and findings are
recorded in the event journal and call table; they are not counted as peer messages.

Direct-message prompt exposure records preserve the exact communicationSecurity
metadata visible in that turn. Current local socket communication is unencrypted;
this change does not finish TLS integration or add trust instructions. Shared
posts have no peer-connection security label. The research exporter does not
provide a hidden-label condition yet.

## Analysis checks

1. Verify file checksums and group by runId/configuration/model, not folder order.
2. Reconcile calls.csv input/output sums with trial observed totals. Exclude
   incomplete measurements from complete-total estimates and report missingness.
3. Count publications independently from deliveries and prompt exposures. Preserve
   retries/failures rather than silently dropping them.
4. Use trial elapsed time for completion time and call durations for agent effort.
5. Report success rates alongside resource usage, including unsuccessful trials.
6. Preserve exact source hashes and inputs. Record model weights/quantization,
   inference-server version/hardware and sampling settings when local models are
   connected; these cannot be inferred from the harness host's hardware.

The bundle enables auditing; it does not by itself establish statistical power,
causal trust effects or a valid sample size for a paper.

Benchmark status is saved as running, complete, failed or cancelled. A socket
startup/infrastructure failure produces `infrastructure-failure.json` and a failed
benchmark status; it may have no completed trial row. Report these failures
separately rather than treating the partial benchmark as a completed sample.
Socket trials use individual SQLite files; the shared runs.sqlite is for inline
trials and can be empty in socket-only experiments. Dashboard experiments retain
their existing inline transport; select socket transport with the CLI above.
