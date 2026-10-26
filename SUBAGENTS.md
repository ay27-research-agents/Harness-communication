# Bounded agent-created subagents

The existing inventory scenario is unchanged. This delegation capability is also used by the [intelligence scenario](INTEL-DEMO.md): its scripted reviewer requests a chronology checker automatically when a helper is available. Live agents choose whether to delegate.

## What an agent can do

The analyst, reviewer, or reporter can request a temporary specialist while choosing its next action. It supplies:

- A short name, such as `evidence-checker`.
- A focused task, such as checking whether the supplied analysis covers all fixture differences.
- The IDs of specific evidence it already knows.

The harness checks the request, saves it before execution, and runs the helper. In `serve` mode, the helper is a separate process with its own Pi Agent context. It uses the same provider, model, and authentication mode as the parent team; the requesting model cannot select another account, add tools, or expand permissions.

Only the assignment and selected evidence go into the helper's model context—not the parent's conversation, subscriptions, private inbox, or other agents' findings. The helper returns findings, evidence references, and limitations. It then exits. The result appears in the parent's next decision context.

The helper's result is **advice, not independently verified evidence or stage approval**. The parent remains responsible for its own work and can choose to publish useful information to a shared subject. Nothing is automatically published.

## See it happen without live account usage

From the project folder:

```powershell
.\harness.ps1 serve --worker pi-faux --subagent-demo --trace
```

This uses the actual installed Pi Agent SDK with predetermined offline responses. For a demonstration without Pi, replace `pi-faux` with `scripted`.

The reviewer requests an evidence-checking helper after receiving the fixture and analysis. The trace prints:

1. The parent requests a named helper.
2. The helper completes or fails and its result returns only to the parent.
3. The reviewer performs its own review and publishes it.

In a second terminal:

```powershell
.\harness.ps1 status
.\harness.ps1 board RUN_ID
.\harness.ps1 stop
```

`status` shows the helper's parent and lifecycle state plus any currently active helper process IDs. The helper usually finishes quickly, so seeing a completed helper and no active helper process is normal.

Open the printed board folder's `README.md`. Its subagent links lead to the assignment, result, and limitations. `subagents/index.json` contains the full records. Like the rest of the board, these files are operator-readable audit copies, not private from the human operator.

For a finite, inline demonstration that exits on its own:

```powershell
.\harness.ps1 run pubsub --worker pi-faux --subagent-demo --trace
```

Inline mode creates an isolated Pi model context, but not a separate OS process. Use `serve` to demonstrate process creation and teardown.

## Live models choose for themselves

Start a **new** live run:

```powershell
.\harness.ps1 serve --worker pi --auth pi-login --provider openai-codex --model gpt-5.5 --timeout 120000 --trace
```

Delegation is available, not mandatory. The current small inventory problem may not justify a helper. Live agents choose whether to request one; do not expect a spawn on every run. `--subagent-demo` is intentionally limited to scripted/pi-faux mode so predetermined demonstration choices cannot be mistaken for autonomous live choices.

Live helpers make additional inference calls through the selected account. Their SDK-reported usage is included in the run's token totals.

## Limits and permissions

- **Depth one:** only the three original agents can spawn. Helpers cannot spawn.
- **Default three helpers per run, one per parent:** a failed or completed helper still consumes its lifetime slot.
- **One active helper at a time:** the existing scheduler remains sequential. During a helper call, incoming user posts are saved and handled on subsequent turns.
- **One bounded task per helper:** no ongoing subscriptions, direct peer messaging, filesystem tools, shell tools, or independent subject publication. The supervisor returns results to the parent; helpers are not additional full board participants.
- **Finite context and output:** up to eight selected evidence references, a 2,000-character task, a 4,000-character finding, and four bounded limitations. The overall context must fit the existing context limit.
- **Timeouts and attempts:** helper startup and inference share the existing request deadline. Each helper uses the run's persistent `--max-attempts` budget (default two, maximum five). A retry may use a replacement process, but does not gain another logical helper slot.

Use `--max-subagents 0` to disable delegation, or choose a lower limit of 1 or 2 when starting a run. Limits are saved and must remain unchanged on restart. Existing runs created before this feature keep delegation disabled; start a new run to enable it.

## Recovery and inspection

The journal saves the request, each attempt and its exact selected context, process start/stop records, returned usage, terminal result, and the parent's processed receipt.

A completed result is reused after restart without calling the helper again. Interrupted attempts consume their budget. If retries are exhausted, the parent receives an explicit failure, not a fabricated result. Late timed-out output is not accepted. Ctrl+C or `stop` terminates temporary helper processes as well as the original workers.

Metrics distinguish:

- `subagentsCreated`: logical helper assignments.
- `subagentCalls`: attempted helper calls, including retries.
- `subagentsCompleted` / `subagentsFailed`: terminal outcomes.
- `subagentFailures`: failed individual attempts.

Token totals include reported helper usage, including schema-rejected responses where usage is available. This is not a billing estimate, and an interrupted request may consume usage that the SDK never reports.

This feature does not add a new operational scenario, external-effect tools, recursive delegation, or distributed execution across machines.
