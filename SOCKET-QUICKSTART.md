# Shared subjects, direct messages, and automatic wakeups

For the more involved intelligence test, add `--scenario intel` to a new service and use a separate database. The [intelligence walkthrough](INTEL-DEMO.md) explains the distributed source packets, expected assessment, and live Pi commands. The examples below retain the inventory scenario.

Add `--dashboard` to `serve` for a local browser view of agents, subjects, messages, helpers, and assessment history. In the intelligence exercise, its **Add intelligence** form triggers a versioned reassessment; ordinary notes only prompt discussion. See [the dashboard walkthrough](DASHBOARD.md).

Agents can now also request temporary subagents. See the [subagent walkthrough](SUBAGENTS.md). The original three agents remain the board participants; helpers receive selected evidence, report to their parent, and exit.

## Run it

In PowerShell, from this project folder:

```powershell
.\harness.ps1 serve --worker scripted --trace
```

The launcher selects Node 24+ from PATH or the bundled Codex runtime without changing global settings. If Node 24+ is already on PATH, you can instead use `node src/cli.ts serve --worker scripted --trace`.

`serve` stays running. It prints a run ID and the shared workspace path. It starts three separate agent processes—analyst, reviewer, reporter—each with its own local TCP socket. A socket is a connection another program can send messages through. A storage supervisor keeps the durable history and schedules turns. Turns are still sequential; this is not a parallel-performance benchmark.

The demonstration shows:

1. The analyst creates a findings subject and posts evidence.
2. The reviewer chooses that subject. The analyst also sends it a private follow-up over a direct peer connection.
3. The reviewer replies privately and posts back to the analyst's shared subject. The subject's creator does not have exclusive posting rights.
4. The reporter follows approved findings and publishes the report.
5. The processes remain alive, waiting for relevant information. Idle agents make no model calls.

In a **second terminal**, from the same folder, replace `RUN_ID` with the printed value:

```powershell
.\harness.ps1 status
.\harness.ps1 board RUN_ID
.\harness.ps1 post RUN_ID --topic inventory --text "A follow-up for agents interested in this inventory."
.\harness.ps1 dm RUN_ID --to reviewer --topic inventory-findings --text "Please look at the shared findings."
.\harness.ps1 post RUN_ID --topic discussion --title "Findings discussion" --description "Unreviewed inventory findings for discussion." --text "Anyone interested can subscribe and post here."
.\harness.ps1 stop
```

No manual `resume` is needed while the service is running. Ctrl+C in its terminal also stops it.

## What to look for

- **Subjects** are shared discussion spaces. Everyone sees their descriptions; agents choose subscriptions. Only subscribers receive post bodies through topic delivery. Subscribing catches up on unread history.
- **Direct messages** go to one agent, even if it does not subscribe to the linked subject. A sender can explicitly share evidence it already knows. Other agents do not receive the private body in their working context.
- **Wakeup** means calling an agent when relevant information is ready. Its idle process listens on a socket. A new subject triggers discovery; a post wakes followers; a direct message wakes its recipient. Information arriving during a turn is handled on a subsequent turn.
- **Shared workspace** means the saved board plus readable files. Open the printed workspace's `README.md`, `topics/`, and `agents/AGENT/messages.md`. These are generated views: change the board through `post` or agent decisions, not by editing generated files.

`status` shows each agent's process ID (PID), listening port, whether it is alive, total decisions, sent direct messages, received socket messages, and any error. After the default demo settles, expect three live agent processes, two direct messages and two socket receipts: analyst → reviewer and reviewer → analyst. An operator private note adds another message and receipt. `busy: false` means the board is waiting, not that the service stopped.

The scripted policy chooses subjects using their descriptions and responds with fixed demonstration text. It does not understand arbitrary requests. Inventory skills run only once per experiment; a new note does not rerun completed analysis.

## Use Pi

For the actual installed Pi Agent with deterministic, offline responses:

```powershell
.\harness.ps1 serve --worker pi-faux --trace
```

For actual model-chosen subjects, subscriptions, publications and replies:

```powershell
.\harness.ps1 serve --worker pi --provider PROVIDER --model MODEL_ID --trace
```

Replace the placeholders with a built-in provider and model from your installed Pi catalog. The command above uses environment credentials. For an existing Pi `/login`, use:

```powershell
.\harness.ps1 login-models
.\harness.ps1 serve --worker pi --auth pi-login --provider PROVIDER --model MODEL_ID --timeout 120000 --trace
```

`login-models` lists saved OAuth provider names and installed model IDs without printing tokens, refreshing them, or making inference requests. Select an ID from that provider's list; account access still needs live verification. Do not paste credentials into chat or put them in the project.

Login mode uses Pi's native credential store and refresh locking. Refreshed credentials stay in Pi's own storage. It does not execute stored API-key commands or silently fall back to API-key billing. Authentication mode is remembered on restart. Manage login/logout in Pi itself.

Live mode sends context, including notes and private messages, to the selected provider and may consume account quota or incur charges. Live-model behavior is not deterministic. The scripted service, real Pi SDK's offline service, and login-store integration with synthetic credentials are tested.

### First live verification — 2026-10-08

Using the existing Pi login and saved model choice `openai-codex/gpt-5.5`, the three socket workers completed a verified report with 15 model decision calls, 3 work calls, and zero failures. SDK-reported usage was 22,593 input tokens (including cached input) and 2,399 output tokens; this is not a billing estimate. The agents all chose the existing inventory subject and sent no private messages. Direct sockets remain covered by offline integration tests; this run did not exercise model-chosen direct messaging.

The service was stopped after the experiment. Local results are in `runs/live-pi-login-20261008-55452158.sqlite`; the board is `runs/boards/dc8a5156-a38a-448b-b7b3-3cc0460d9804/`. These generated results are ignored by Git and are not included when cloning the repository.

## How it works

1. An agent returns a structured decision to create subjects, subscribe, post, send direct messages, work, or wait. The supervisor validates it and saves it in SQLite—an on-disk database.
2. For a direct message, it saves an **outbox** record: a message awaiting delivery. It asks the sender process to connect **directly to the recipient process**. The message payload crosses that peer connection; it is not simply forwarded by a central broker.
3. The recipient authenticates the sender's delivery capability and confirms the exact message against the saved record. The supervisor saves a transport receipt before the recipient acknowledges delivery. The supervisor then includes the message only in that recipient's next decision context.
4. After that decision is applied, a separate processed receipt and inbox cursor are committed. A **cursor** is the saved position in message history. Repeated transport is deduplicated, and a completed decision is not requested again.

The supervisor remains the single storage authority and controls wakeup scheduling. This is a hybrid shared board plus peer transport, not a decentralized system. Each agent process hosts its own Pi adapter; a model itself does not own a network socket. Evidence references in direct messages are resolved against canonical stored artifacts by the supervisor.

Models never see socket secrets, arbitrary destinations, or filesystem paths to write. They name a known agent; the runtime resolves its current port. Public peer descriptions and subscriptions help agents choose whom to contact.

## Stop, recover, and inspect

`post`, `dm`, `board`, `inspect`, `export`, `status`, and `resume` communicate with the active service, avoiding competing database writers. While serving, inspection/export targets the active run; stop the service to inspect another saved run. `list` lists saved IDs and marks the active one.

To restart the same board:

```powershell
.\harness.ps1 serve RUN_ID --trace
```

Unacknowledged messages are retried, committed decisions are replayed, and saved read positions prevent repeat processing. This does not promise exactly-once external effects. A failed agent is reported in `status`; stop and restart the service to recreate its process. There is no automatic crash respawn.

Each run retains limits of 48 decision turns, 16 turns per agent, 16 subjects, 64 public updates, and 64 direct messages. Decisions allow at most two public posts and two direct messages each. Attempt budgets remain consumed after interruption; restarting does not reset them. Begin a new run when its budget is exhausted. The service can remain idle with an incomplete report; inspect the report and agent decisions to distinguish waiting from success.

The original `run pubsub` and `resume` commands still finish and exit. They use inline delivery in one process, not peer sockets. A `post` or `dm` saved while no service is active waits until `resume` or `serve RUN_ID`. The other three harnesses are unchanged.

## Local-lab boundaries

All sockets bind only to `127.0.0.1` (this computer), use random capabilities for control and sender/recipient delivery, and enforce frame sizes and deadlines. The ignored `*.runtime.json` file contains a local control secret: never share it. Windows file protection inherits the directory ACL. This is a same-user local lab, **not** a hostile multi-user or remote-network security boundary.

The operator's database, exports, and board files contain the full audit history, including direct messages. “Private” describes agent context isolation, not encryption or secrecy from the operator. Keep active databases and runtime descriptors on one machine, preferably outside synchronized folders, by adding `--db C:\local-path\lab.sqlite` to every command. No live targets, scanning, shell execution tools, or operational adapters are added.

Run the tests with `.\harness.ps1 test`. Socket integration tests launch and stop real child processes, so they require an environment that permits local child processes and loopback TCP.
