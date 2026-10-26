# Intelligence exercise: conflicting sources

An intelligence-reconciliation test for the pub/sub harness. Three agents receive different fictional documents and must exchange information before assessing a hypothetical interruption of the ATLAS relay. There are no real targets, scanners, execution tools, or operational actions.

The inventory demo remains the default. The intelligence exercise is selected with `--scenario intel` and currently works only with pub/sub.

For a visual demonstration with new intelligence arriving during the run, see [the dashboard walkthrough](DASHBOARD.md). Start `.\harness.ps1 serve --scenario intel --dashboard --worker scripted --db runs\intel-dashboard.sqlite`, then open the printed Dashboard link.

## What the agents know initially

| Agent ID | Role | Initial source packet |
|---|---|---|
| `analyst` | Intelligence analyst | An old route diagram and an anonymous backup-readiness tip |
| `reviewer` | Source and chronology reviewer | A completed change record plus current observation excerpt |
| `reporter` | Mission assessor | Exercise constraints and a protected-service dependency manifest |

All three also receive the same brief: assess the primary route, protected dependencies, and backup readiness. They do **not** receive all source documents automatically. The original packets and subsequent knowledge delivery are recorded in the journal.

They can create subjects, subscribe, publish original evidence, post on each other's subjects, ask peers private questions, and request bounded specialists. A new subject wakes discovery; relevant posts, direct messages, and helper results wake the affected agents. The supervisor does not choose their subjects or send missing documents on their behalf.

The three work stages remain analysis, independent review, and final assessment. Those capabilities and their evidence requirements are fixed; communication choices are agent actions. This is more demanding than the inventory fixture, but it is still a bounded exercise, not an unrestricted agent society.

## Run a quick, offline demonstration

In PowerShell, from the project folder:

```powershell
.\harness.ps1 run pubsub --scenario intel --worker scripted --trace --db runs\intel-demo.sqlite
```

This exits when the board settles and prints the final assessment. It uses deterministic code, no model account, and inline delivery—not separate sockets. Each invocation creates a new run; it does not overwrite previous runs.

The scripted demonstration:

1. The analyst opens a route-history subject, shares its leads, and privately asks the reviewer for newer observations.
2. The reviewer publishes its current source, replies directly, and posts the useful contradiction back to the analyst's subject.
3. The reporter publishes the protected-service constraints before waiting for the other agents' conclusions.
4. The analyst collects the missing sources and reconciles the three claims.
5. The reviewer requests a `chronology-checker` helper with only three selected documents. Its advisory result returns to the reviewer, who performs its own full review.
6. The reporter publishes the evidence-backed final assessment.

This baseline deliberately requests one helper when the budget permits. `--max-subagents 0` disables helpers; the team can still complete the task. `--subagent-demo` is not needed for the intelligence exercise.

## Use actual Pi and direct sockets without model charges

```powershell
.\harness.ps1 serve --scenario intel --worker pi-faux --timeout 120000 --trace --db runs\intel-faux.sqlite
```

`pi-faux` uses the installed Pi Agent SDK with predetermined responses. `serve` starts three separate processes and direct local TCP connections; the requested helper is a fourth, temporary process that exits after returning its result. This tests integration and communication, **not model reasoning**. Turns are scheduled sequentially.

The service remains open after completing the assessment. `busy: false` means it is waiting, not stopped. Ctrl+C stops it.

## Let your logged-in models make the decisions

Using the previously selected Pi login and model:

```powershell
.\harness.ps1 serve --scenario intel --worker pi --auth pi-login --provider openai-codex --model gpt-5.5 --timeout 120000 --trace --db runs\intel-live.sqlite
```

This makes real model calls using your saved Pi login and consumes account usage. Source documents and any delivered notes are sent to that provider. Credentials remain in Pi's normal credential store.

Live agents choose their own subjects, subscriptions, messages, and delegation. They may communicate differently or decide not to use a helper. The private-message exchange and helper shown in the scripted baseline are **not guaranteed live behaviors**. A team that stalls, omits required evidence, or produces an invalid result is reported incomplete or failed; the supervisor does not silently fix it.

If the model is unavailable in your current Pi installation, use `.\harness.ps1 login-models` to inspect installed provider/model metadata and select an available model.

## Watch and interact in a second terminal

Use the database matching your running service. These examples use the live database; replace `RUN_ID` with the ID printed on startup:

```powershell
.\harness.ps1 status --db runs\intel-live.sqlite
.\harness.ps1 board RUN_ID --db runs\intel-live.sqlite
.\harness.ps1 inspect RUN_ID --db runs\intel-live.sqlite
.\harness.ps1 dm RUN_ID --db runs\intel-live.sqlite --to reviewer --text "Explain why the backup tip is still unverified and which sources establish the chronology."
.\harness.ps1 post RUN_ID --db runs\intel-live.sqlite --topic intel-brief --text "Please distinguish what is confirmed, refuted, and unresolved, and share any useful explanation on a subject."
.\harness.ps1 stop --db runs\intel-live.sqlite
```

A direct message goes only to its recipient. A subject post goes to its subscribers. With `serve`, both can wake agents automatically. Live follow-ups can consume more model usage; scripted agents use fixed responses and do not understand arbitrary requests.

Topic names other than the initial `intel-brief` and `announcements` may differ in live runs. Consult `board` before posting to an agent-created subject.

The printed workspace folder contains:

- `assignments.json`: which original documents each agent received.
- `evidence/sources/`: all original and added source documents for operator inspection.
- `topics/`: shared discussion history.
- `agents/AGENT/messages.md`: private-message audit trail.
- `subagents/`: specialist task, advisory result, limitations, and lifecycle state.
- `evidence/analysis.json`, `review.json`, `report.json`: validated structured outputs.
- `assessments/index.json` and `assessments/revision-N/`: current revision status and preserved stage results for every assessment version. The familiar evidence output files show latest completed stages, which may belong to a previous revision while new work is pending.

These files are an **operator audit view**, not a filesystem exposed to the models. Editing them does not update the exercise. Use `export RUN_ID --db ...` for the exact delivered model contexts and journal events.

## What a successful result means

Expected conclusions for the original assessment (revision 1):

- **Refuted:** ATLAS is the current primary exercise route. The older diagram is superseded by the completed change and newer observation identifying BIRCH.
- **Confirmed:** ATLAS carries protected medical telemetry. Current observations and the dependency manifest agree.
- **Unresolved:** BEACON backup readiness. A recently received anonymous claim is not a dated readiness test; absence of verification does not prove failure.
- **Recommendation: HOLD.** The hypothetical interruption conflicts with the protected-service constraint, and backup readiness remains unverified.

`success: true` means the structured claims, required citations, superseded source, review, protected dependency, uncertainty, and recommendation passed the exercise checks, and a final report was published with the board settled. It does not mean an operation was executed or that all free-form prose was semantically verified.

Three worker calls correspond to analysis, review, and report. Decision calls are the separate choices about reading, posting, subscribing, messaging, delegating, or waiting. Helper calls are counted separately. In the scripted socket baseline, expect one completed helper and two peer messages with two socket delivery receipts; live counts may differ.

## Boundaries and recovery

- The original evidence pack stays fixed. Use the dashboard or `inject RUN_ID --source examples/beacon-readiness.json --db ...` to append a dated source and request reassessment. Notes are conversation, not new source documents.
- Each work stage completes once per assessment revision. Original outputs are retained; accepted new sources cannot make the old report count as the new answer. The backup-test example resolves BEACON readiness but preserves HOLD because protected medical telemetry remains.
- Helpers see only the requested documents, cannot spawn more helpers, and cannot post or message peers. Their advice does not replace the parent's review.
- Limits: four added sources per run; 48 decisions total and 16 per agent per revision. Helpers remain a lifetime budget of at most three, one per parent; new revisions do not replenish them. Follow-up conversations consume the current revision's decision budget.
- Resume a stopped socket run with `.\harness.ps1 serve RUN_ID --db runs\intel-live.sqlite --trace`. It restores the saved scenario, worker, provider/model, and auth mode. Do not repeat `--scenario` to change an existing run.
- Use a new run for another attempt. Do not overwrite source files or journals to change a recorded experiment.

## Verification

`.\harness.ps1 test` includes scenario validation, source-isolation and missing-evidence tests, invalid-claim rejection, unchanged inventory behavior, CLI/resume checks, and separate-process scripted/Pi-faux socket tests. These tests make no live model inference calls. The fixture's answer key stays in validator/scripted code and is not included in live model contexts.
