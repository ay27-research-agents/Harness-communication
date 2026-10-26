# Pi Communication Lab

A local testbed for four communication patterns. The default scenario compares a supplied synthetic inventory, reviews its findings, and writes an evidence-linked report. Pub/sub also supports a fictional intelligence-reconciliation scenario with separate source packets, conflicting evidence, protected dependencies, and unresolved claims. Workers choose the subjects they follow, publish progress and findings, and decide when to perform their assigned skill.

The implementation runs under Node 24 without installing project dependencies. It discovers the existing Pi installation and uses Pi's Agent runtime for optional model inference. The installed SDK tested here is **Pi 0.87.1**.

## Try it

**New: live intelligence updates and dashboard.** Start `.\harness.ps1 serve --scenario intel --dashboard --worker scripted --db runs\intel-dashboard.sqlite`, open its printed browser link, and load the backup-test example. Agents produce a new assessment while preserving the original. Inspect subjects, private messages, helpers, and changed claims in one place. See [the dashboard walkthrough](DASHBOARD.md) for Pi modes, source injection, history, and stopping.

**New: Exercise LANTERN.** Try `.\harness.ps1 run pubsub --scenario intel --trace --db runs\intel-demo.sqlite` for a finite offline demonstration. Three agents exchange different source packets, resolve contradictory intelligence, request a chronology specialist, and produce a constrained assessment. See [the intelligence demo](INTEL-DEMO.md) for separate-process Pi runs, your saved login, interaction commands, and the expected result. Inventory remains the default for every topology.

**New: bounded subagents.** Pub/sub agents can request a temporary specialist with selected evidence and receive its advisory result. New runs allow up to three helpers, one per parent, without recursive spawning. Try `.\harness.ps1 serve --worker pi-faux --subagent-demo --trace`. See [Subagents](SUBAGENTS.md) for permissions, live behavior, limits and recovery.

**New pub/sub runtime:** agents can share subjects, message peers over direct sockets, and wake automatically. Start with `.\harness.ps1 serve --worker scripted --trace`. See the [socket quickstart](SOCKET-QUICKSTART.md) for the two-terminal walkthrough, Pi mode, recovery, and limitations. The Windows launcher selects Node 24+ if Pi's default `node` is version 22.

Run these commands from this directory:

```powershell
node src/cli.ts doctor
node src/cli.ts compare
node src/cli.ts compare --worker pi-faux
node src/cli.ts run pubsub --worker pi-faux --trace
node src/cli.ts run pubsub --duplicates --fail-once review
node --test --test-isolation=none tests/*.test.ts
```

`compare` prints one row per topology and persists all four runs in `runs/lab.sqlite`. The table includes each run ID. `pi-faux` runs the actual installed Pi Agent with predetermined fixture responses, entirely offline. It tests integration with Pi; it does not test model intelligence or produce meaningful token costs.

```powershell
node src/cli.ts list
node src/cli.ts inspect RUN_ID
node src/cli.ts export RUN_ID
node src/cli.ts resume RUN_ID
```

Replace `RUN_ID` with a value printed by the CLI. `export` writes `runs/RUN_ID.json` containing the report, exact context packages, evidence, and chronological event log. `--db PATH`, `--json`, and `--output PATH` allow alternate storage and machine-readable output. `node src/cli.ts --help` lists all options.

## What each mode does

| Pattern | Implemented coordination | Responsibility |
|---|---|---|
| `coordinator` | A coordinator assigns the analysis, review, and report tasks and receives each result. | Each worker owns a bounded task; the coordinator schedules the next. |
| `pubsub` | Workers discover topic descriptions, choose subscriptions, read followed updates and publish their own notes. | Each worker chooses whether to use its assigned skill. The broker delivers information; it never assigns a successor task. |
| `routed` | The analyst requests a review through a router, receives the reply, and requests a report. Messages retain correlation and evidence links. | Review and report requests create named subtasks. The conversation has a fixed eight-message limit. |
| `handoff` | One task passes from analyst to reviewer to reporter through durable offer, acceptance, and commit records. | An ownership epoch changes atomically with each committed transfer. |

Coordinator, routed and handoff use fixed communication graphs. Pub/sub uses a shared topic board: in live Pi mode, model responses choose subscriptions, subjects, publications, direct messages and whether to perform available work. Decisions are structured JSON actions checked by the supervisor before being applied. The three worker IDs and analysis/review/report capabilities remain fixed, with scenario-specific goals, evidence, contracts and validation. `run` and `compare` use inline, single-process delivery; `serve` uses separate agent processes and peer sockets. Both schedule turns sequentially; this version does not measure parallel scaling.

The default inventory fixture has three fictitious assets and two discrepancies. LANTERN has four fictional source documents and three intelligence claims. Workers inspect records already in memory. There are no target addresses, scanners, exploitation components, shell tools, or operational execution adapters.

## The shared pub/sub board

Start with this visible demonstration:

```powershell
node src/cli.ts run pubsub --worker pi-faux --trace
```

`--trace` prints what each worker chose and why. `pi-faux` exercises the actual Pi runtime using predetermined decisions. Use `--worker pi --provider PROVIDER --model MODEL_ID` for model-selected decisions; live behavior and success can differ. `scripted` uses the same deterministic demonstration policy without Pi.

The analyst discovers the supplied inventory subject and follows it. When it publishes its findings under a new subject, the reviewer sees that subject's description and chooses whether to subscribe. A subscription delivers previous unread updates as well as future ones. The reporter makes its own choices as subjects appear. An unrelated announcements subject is included to make selective attention visible.

Every worker sees short topic descriptions. Only subscribers receive topic updates through pub/sub; peers can also share known evidence explicitly through direct messages. Workers retain evidence they previously read, so unsubscribing stops delivery without erasing memory. They can follow multiple topics, unsubscribe, create subjects, post on each other's subjects, send direct messages, work or wait. Their complete desired subscription list, status, reasoning and actions are saved each turn. The broker contains no analysis-to-review-to-report routing rule. An agent may refuse to work; an idle board without a verified, published report is reported as incomplete.

The CLI writes a readable workspace beside the database, normally `runs/boards/RUN_ID/`:

```text
README.md                         Overview of subjects, agents and updates
board.json                        Complete board snapshot
topics/index.json                 Discoverable subject descriptions
topics/SUBJECT.md                 A subject's complete update history
updates/UPDATE_ID.md              Individual dated publications
agents/AGENT/status.md            What the worker says it is doing
agents/AGENT/subscriptions.json   Subjects it follows and reasons
agents/AGENT/decisions.md         History of its choices
agents/AGENT/messages.md          Sent/received direct messages (operator audit)
evidence/                        Saved fixture and validated results
```

The database is the durable record; these files are readable copies refreshed as agents work. Direct edits to generated files are not ingested. Add your own note with `post` and then let agents respond with `resume`:

```powershell
node src/cli.ts board RUN_ID
node src/cli.ts post RUN_ID --topic inventory --text "Please explain the missing metrics finding."
node src/cli.ts resume RUN_ID --trace
```

You can also introduce a new subject:

```powershell
node src/cli.ts post RUN_ID --topic follow-up --title "Inventory follow-up" --description "Unreviewed inventory findings for discussion." --text "A human note for anyone interested in these findings."
node src/cli.ts resume RUN_ID --trace
```

`post` saves a public note and `dm` saves a private note. While `serve` is active, these automatically wake relevant agents and may cause model calls in live mode. Otherwise, `resume` processes changes to the catalog, followed topics, direct inbox, or own-work results. The scripted policy uses fixed choices and replies; a live model can choose its own response. Completed inventory skills run once per experiment, so a follow-up note does not rerun the analysis. Start a new run for a new inventory experiment.

`run` and `resume` exit when everyone has seen their relevant updates and is waiting. `serve` instead stays alive and wakes agents on new activity. Neither imports direct edits to generated files. Each run has persistent limits of 48 decision turns, 16 turns per agent, 16 topics, 64 publications and 64 direct messages to bound feedback loops. For LANTERN, decision limits apply per assessment revision; up to four validated intelligence sources can trigger new revisions. Other limits remain lifetime limits. Deliveries are deduplicated and read positions are saved. Decisions are committed before their effects; reopening reuses a committed choice and any completed work.

New pub/sub runs use protocol version 2. Old completed runs remain inspectable and resumable without being rewritten. An unfinished run using the retired fixed pub/sub protocol requires a new run.

## Use a real model through Pi

The live adapter uses the installed Pi built-in model catalog. Authentication defaults to environment/ambient credentials. Add `--auth pi-login` to use an existing Pi OAuth login instead. This imports only Pi's native credential-storage submodule—not extensions, skills, saved sessions, the coding-agent entrypoint, or custom `models.json` endpoints.

For saved Pi login, first run `/login` in Pi, then list your local login providers and their installed model catalog:

```powershell
.\harness.ps1 login-models
.\harness.ps1 serve --worker pi --auth pi-login --provider PROVIDER --model MODEL_ID --timeout 120000 --trace
```

Replace both placeholders with entries printed by `login-models`. The listing makes no inference requests, refreshes no tokens, and prints no credential values. Catalog presence does not guarantee your account has access. Each agent reads the selected provider's OAuth credentials from Pi's normal storage, honoring Pi's agent-directory setting. Pi handles token refresh under its native cross-process file lock and writes rotated credentials back to Pi's store, never to this project. Stored API-key commands are not executed in login mode; there is no fallback to environment credentials on login failure. Use `/login` or `/logout` inside Pi to manage the account.

The authentication choice is saved with the experiment and restored by `serve RUN_ID` or `resume RUN_ID`; changing it requires a new run. Live requests may consume account quota or incur provider charges. On 2026-10-08, one live socket-service experiment using `openai-codex/gpt-5.5` and saved Pi OAuth completed successfully: 15 decision calls, 3 inventory-work calls, and no failed attempts. Agents chose to use the existing inventory subject and sent no direct messages. This verifies the live login and shared-board path, not live peer-message behavior or every provider.

With a supported provider API key already available in your terminal environment:

```powershell
node src/cli.ts run coordinator --worker pi --provider PROVIDER --model MODEL_ID
```

Replace the placeholders with a provider and model in the installed Pi catalog. Context contains the bundled synthetic fixture, intermediate results, and—for pub/sub—topic descriptions, followed notes, direct inbox and saved agent state. Each invocation creates a fresh Agent with an empty tool list and one model turn. The supervisor validates and applies the returned decision actions. The adapter enforces JSON output, cancellation, output limits, and a deadline. Real inference can consume provider usage. The installed offline provider and one live OpenAI Codex OAuth run have been exercised; other provider/account combinations remain unverified.

Pi's launcher does not need to be on `PATH`. Discovery checks the managed installation pointer and common package directories. To override discovery:

```powershell
$env:PI_PACKAGE_PATH = 'C:\path\to\node_modules\@earendil-works\pi-coding-agent'
node src/cli.ts doctor
```

The current machine's managed installation was found at `.pi\agent\install\releases\0.87.1\node_modules\@earendil-works\pi-coding-agent` under the user directory. The code imports its existing `pi-agent-core` and `pi-ai` packages. The compatibility check fails clearly if the required API is absent. Record the version reported by `doctor` alongside experimental results; upgrading Pi can change runtime behavior.

## State and recovery

The supervisor owns an append-only SQLite event journal. A successful stage commits its immutable output artifact and task update in the same transaction. Handoff commit similarly records the new task owner and committed transfer together. Artifacts carry SHA-256 content hashes checked on reopening.

Pi workers receive copies of canonical stored inputs. They cannot write to the database or supply their own sender identity. The task store checks owner, ownership epoch, and state version before accepting a response. Every model request's context is recorded, including the objective, evidence, selected recent messages, and result contract.

`resume` reconstructs task and delivery state. Completed stages, committed choices and acknowledged updates are reused. An attempt left active by an interrupted supervisor is marked failed, with its consumed attempt budget retained. Attempts default to two per stage or decision turn. When that budget is exhausted, start a new run to repeat the experiment; resume never silently resets it.

The SQLite supervisor record prevents concurrent supervisors from owning the same database on one host and permits reclaiming a record whose process is gone. Use the database on one machine and avoid opening the active database from another machine or a synchronized copy. Export JSON after a run for sharing.

Retries are appropriate here because stage computations have no external effects. A missing response is never evidence that an external operation did not occur. This version does not implement external-effect retries.

## What is measured

The CLI records messages, inventory worker calls, decision calls, failures, suppressed duplicate deliveries, committed handoffs and reported input/output tokens. In pub/sub, `messages` counts topic updates delivered to subscribers; publications and current subscriptions are separate JSON metrics. `calls` counts attempts at analysis/review/report, while `decisions` counts attempts to choose subscriptions and actions. The table's `failures` includes both kinds; JSON keeps them separate. Token totals include both work and decision responses. Failed responses that expose usage are included. Failures before usable usage arrives are counted in `attemptsWithoutUsage`; token totals are incomplete when that value is nonzero. Faux token figures are synthetic, not billed usage.

Structured findings are independently recomputed from the supplied fixture. Acceptance checks the asset differences, missing/unexpected services, counts, evidence IDs, and approved review. Final report prose and ordinary board notes are **not semantically graded**. A successful run means the structured fixture contract passed and all tasks completed. Pub/sub additionally requires the reporter to publish its report and the board to finish processing relevant updates. Publishing a note does not make its claims verified evidence.

The context budget is measured in **characters**, not model tokens. Required evidence is never silently truncated: a run fails if it cannot fit. Inventory requests remove recent messages first; board decisions receive unread updates in batches that fit the budget. This version uses a fixed context policy; rolling summaries, retrieval experiments, broader datasets, and a statistical evaluation suite are future work.

## Files

```text
src/
  cli.ts          Commands and run summaries
  experiments.ts  Scripted, real Pi, and offline Pi worker selection
  types.ts        Messages, tasks, contexts, artifacts and journal contracts
  kernel.ts       Validation, ownership, retry budgets, cancellation and metrics
  store.ts        In-memory and SQLite journals with supervisor ownership
  topologies.ts   Fixed routes and the pub/sub board entry point
  board.ts        Topic delivery, durable decisions, readable files and recovery
  board-types.ts  Subjects, updates, subscriptions and decision contracts
  board-policy.ts Deterministic demonstration policy and live decision prompt
  fixtures.ts     Synthetic expected/observed input records
  workers.ts      Deterministic workers and evidence validation
  pi.ts           Installed Pi discovery and inference-only Agent adapter
  socket.ts       Bounded loopback TCP request/response transport
  agent-host.ts   Separate worker process with its own Pi adapter and peer listener
  runtime.ts      Persistent supervisor, worker lifecycle and event-driven wakeups
  subagents.ts    Bounded specialist contract, durable attempts and advisory results
  subagent-types.ts  Delegation requests, context and lifecycle records
  subagent-process.ts  On-demand process startup, local RPC and guaranteed teardown
  subagent-host.ts  Isolated one-task helper process, no board action interface
tests/            Protocol, recovery, persistence, CLI and real Pi SDK tests
runs/             Generated local results, ignored by Git
```

Useful entry points for reading an execution are `runTopology()` in `src/topologies.ts`, `Kernel.execute()` in `src/kernel.ts`, and a JSON export's `context`, `delivery`, and `handoff` events.

## Verification

```powershell
node --test --test-isolation=none tests/*.test.ts
```

The suite covers all four arrangements, selective subscription, agent refusal, unsubscribe/catch-up, duplicate notifications, publication and decision recovery, conversation limits, readable files, CLI posting, interrupted handoffs, malformed or fabricated results, cancellation, deadlines, retry exhaustion, artifact integrity, SQLite reopening, and the installed Pi runtime with its offline provider. Pi integration tests skip when the SDK is absent; the remaining tests require only Node 24.

Socket tests additionally check separate process identities, real peer delivery, direct-inbox isolation, idle wakeups, saved outbox recovery, authentication, fragmented Unicode frames, timeouts, shutdown and restart. They launch local child processes and use loopback TCP. Exported metrics distinguish `directMessages`, `directDeliveries` (transport received), and `directProcessed` (agent decision applied); the original `messages` metric continues counting topic/routed deliveries.

The project uses Node's built-in TypeScript stripping and test runner. No build output or package download is required. Type-only imports and erasable TypeScript syntax are used throughout.

## References

- [Pi Agent Core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi model interface](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- [Original shared discussion](https://chatgpt.com/share/6ab56701-f770-83ea-a20d-56fe79ecea5f)
