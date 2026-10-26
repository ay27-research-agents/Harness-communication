# Live intelligence and the visual dashboard

This adds two capabilities to the intelligence pub/sub exercise: submit new intelligence during a run, and watch the team reassess it in a browser. Earlier assessments are preserved. The other three communication harnesses and the default inventory scenario are unchanged.

## Start here: a demonstration without model usage

From the project folder in PowerShell:

```powershell
.\harness.ps1 serve --scenario intel --dashboard --worker scripted --db runs\intel-dashboard.sqlite
```

Open the complete **Dashboard** link printed in the terminal. Keep that terminal running. Each invocation without a run ID creates a new run.

1. Wait for **R1 / Assessment complete**. R1 means the first assessment version.
2. Read **Who is connected** and **Subjects**. Lines show subscriptions; dashed arrows show recorded private-message exchanges, not continuously active traffic.
3. In **Add intelligence**, click **Load backup-test example**.
4. Leave **Publish on** set to **Intelligence brief**, then click **Add source & reassess**.
5. Watch R2 become pending, then complete. In **Assessment history**, BEACON readiness changes from **unresolved** to **confirmed**. The recommendation remains **HOLD**: the new test does not remove the protected medical-telemetry dependency.
6. Select **R1** to inspect the original conclusion. Select **Current** to follow subsequent revisions automatically.

The source library is an operator view of all documents, not what every agent can see. Agents still receive only their assigned sources and evidence delivered through their subscriptions or private messages.

**Send a note** supports a shared-subject post or a private message to one agent. Notes can wake agents, but they do not become assessment evidence. Use **Add intelligence** for a source that should trigger a new assessment.

Scripted agents use fixed choices and responses; they do not understand arbitrary questions. Their behavior demonstrates the communication protocol, not independent reasoning.

## Use Pi

The same dashboard can use the installed Pi SDK with offline responses:

```powershell
.\harness.ps1 serve --scenario intel --dashboard --worker pi-faux --timeout 120000 --db runs\intel-dashboard-faux.sqlite
```

For live model-selected communication, use your saved Pi login and a model listed by `login-models`:

```powershell
.\harness.ps1 login-models
.\harness.ps1 serve --scenario intel --dashboard --worker pi --auth pi-login --provider openai-codex --model YOUR_MODEL_ID --timeout 120000 --db runs\intel-dashboard-live.sqlite
```

Replace `YOUR_MODEL_ID` with an available model ID. Live runs send delivered evidence and notes to the selected provider and consume account usage. Do not enter sensitive information. Models choose their own subjects, subscriptions, messages, and whether to request a helper; success is not guaranteed. The dashboard does not force them to act or repair rejected answers.

All three modes use separate agent processes and direct local sockets when started with `serve`. Turns remain sequential. Merely viewing the dashboard or waiting while agents are idle makes no inference calls.

## What happens when a source arrives

The supervisor validates the source format and saves the source, new revision number, and subject publication together in one database transaction: either all are recorded, or none are.

The three assessment roles learn that a new revision is needed, but the source body follows normal subject delivery. An agent must subscribe to the source's subject or receive its evidence from a peer before it can perform work. Publishing on an unrelated subject may therefore leave the assessment waiting for evidence.

Analysis, review, and report are separate, versioned tasks. An earlier report cannot satisfy the new revision. If a source arrives while a worker is busy, that worker's result stays attached to the revision it started; it cannot silently become the new answer.

Repeated submission of an identical source ID and content is harmless: it returns the original receipt without another revision or model wakeup. Changed content needs a new source ID; original documents are never overwritten.

## Add a source from the command line

The bundled example is `examples/beacon-readiness.json`. In a second terminal, substitute the printed run ID:

```powershell
.\harness.ps1 inject RUN_ID --source examples\beacon-readiness.json --db runs\intel-dashboard.sqlite
```

An active service wakes automatically. For a stopped run, this saves the source; process it with `resume RUN_ID --db ...`, or restart `serve RUN_ID --dashboard --db ...`.

The JSON source fields are:

| Field | Meaning |
|---|---|
| `sourceId` | Unique lowercase name, with digits/hyphens allowed. |
| `title` | Short document title. |
| `observedAt` | When the reported event was observed, in UTC. |
| `recordedAt` | When the report was recorded, not earlier than observation. |
| `provenance` | Where the exercise document claims to come from. |
| `observations` | What it reports and its limitations. |
| `reliability` | `direct` or `unverified`, supplied by the exercise operator. |
| `claims` | One to three assertions: claim `id` and `status`. |

Use timestamps such as `2026-10-08T10:15:00Z`. Claim IDs are `atlas-primary`, `protected-dependency`, and `backup-ready`; statuses are `confirmed`, `refuted`, and `unresolved`.

This is a deliberately bounded exercise rule: the latest direct observation controls a claim; opposing direct observations at the same time leave it unresolved. Older observations and unverified reports cannot override newer direct evidence just because they arrived later. All relevant source references remain required. An operator-supplied `direct` label is **not authentication or proof of real-world truth**. Keep the observations and structured assertions consistent.

Original evidence stays fixed. At most four added sources are accepted per run, producing up to five revisions. Use a new run for a longer exercise.

## History, limits, and stopping

The printed workspace contains:

```text
evidence/sources/                  Original and added documents
assessments/index.json             Current revision and history status
assessments/revision-1/            Original analysis, review, report
assessments/revision-2/            Revised analysis, review, report
topics/                           Shared discussion
agents/AGENT/messages.md           Private-message audit
subagents/                        Helper assignments and results
```

The familiar `evidence/analysis.json`, `review.json`, and `report.json` are the latest completed stage copies. While a new revision is pending, consult the dashboard or `assessments/index.json`; an old report file is not evidence that the new revision finished. Editing generated files does not change the run.

There are 48 decision turns total and 16 per agent **per revision**. Topic, publication, direct-message, and helper limits remain lifetime limits: 16 topics, 64 posts, 64 direct messages, and at most three helpers with one per parent. A revision does not replenish helper capacity. Earlier helper findings are historical advice, not a fresh check of the new source.

Context-size and retry limits remain enforced. The harness refuses an input that cannot fit without truncating required evidence. It reports missing evidence, invalid output, and exhausted limits instead of presenting the old result as current. Several rapidly submitted sources can supersede an intermediate revision before it completes.

Stop with **Ctrl+C** in the service terminal, or from another terminal:

```powershell
.\harness.ps1 stop --db runs\intel-dashboard.sqlite
```

Restart a saved run:

```powershell
.\harness.ps1 serve RUN_ID --dashboard --db runs\intel-dashboard.sqlite
```

Use the newly printed dashboard link after restart. It has a new local port and access token. The server binds only to `127.0.0.1`, requires its token for data/actions, and rejects cross-origin mutations. Do not forward its port or share the full link: it grants operator access to that running dashboard. It is not a remotely hosted or multi-user service.

## Verification

`harness.ps1 test` covers source validation, duplicate submissions, hidden-source isolation, stale/unverified/conflicting observations, updates during in-flight work, revision preservation, restart, CLI injection, and authenticated dashboard actions. Separate-process scripted and Pi-faux integration tests verify reassessment without live provider calls.
