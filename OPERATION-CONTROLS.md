# Local operation controls

Each run ID is its operation ID. New direct messages and publications carry that ID, the assessment revision, a message type, and acknowledgement requirements. Legacy journals remain readable. Existing original source records retain their observation dates and provenance.

The supported message types are observation, question, and result. Existing agent messages default to observation. Operator messages can specify a type and optional expiry through the running service:

```powershell
.\harness.ps1 dm RUN_ID --db runs\lab.sqlite --to analyst --text "Check the current source" --message-type question --expires-at "2026-12-01T12:00:00Z"
```

Replace the date with a future UTC timestamp. Expired messages are excluded from subsequent inbox contexts. Expiration does not erase information a model already received. Revision metadata accompanies delivered messages so historical evidence remains identifiable. Completion still depends on the current assessment's required evidence.

Subject access is controlled by the local authenticated operator. Change it while the team is idle:

```powershell
.\harness.ps1 access RUN_ID --db runs\lab.sqlite --topic intel-brief --readers analyst,reviewer --writers reviewer
```

The specified lists replace the current access lists. An empty quoted list grants no agent access in that category. User/system administration retains access. New subjects default to all three agents. The checks cover catalog visibility, subscriptions, post delivery, publishing, and private messages linking a restricted subject. Previously received evidence remains in an agent's knowledge. These are subject permissions, not a document classification or mandatory information-flow system.

Cancellation is durable and applies immediately through the control service:

```powershell
.\harness.ps1 cancel RUN_ID --db runs\lab.sqlite --text "Exercise cancelled"
```

The scheduler stops assigning turns, abort signals reach active model/helper calls, and the service waits for its team and helper call to settle before recording acknowledgement. Inspect/export remain available. A cancelled run cannot resume work. Use a new run for a new operation. Provider-side cancellation guarantees depend on the provider.

Enable approval before starting a new team:

```powershell
.\harness.ps1 serve --scenario intel --worker scripted --require-approval --db runs\approval-demo.sqlite
```

The team can communicate, but work pauses until the operator grants the relevant task permission. The initial task IDs are analysis, review, and report. Revision 2 uses r2-analysis, r2-review, and r2-report. Grant each required task to its assigned agent:

```powershell
.\harness.ps1 authorize RUN_ID --db runs\approval-demo.sqlite --task-id analysis --to analyst --stage analyze --expires-at "2026-12-01T12:00:00Z"
.\harness.ps1 resume RUN_ID --db runs\approval-demo.sqlite
```

Use stage review with reviewer and stage report with reporter. Grants bind to the current revision, task, agent, stage, operation, and expiry. Checks occur before starting work and before accepting its output. Agents cannot issue these operator control commands. Existing durable task/result IDs suppress duplicate work. On an existing idle team, the require-approval command enables the same gate. Approval requirements persist across restarts.

Inspect or export the run to audit operation.authorized, operation.topic-access, operation.cancelled and operation.cancellation-acknowledged events. Board JSON includes deliveryStatus with queued, received, processed, or expired for each direct message. Task completion remains recorded separately in task/result events.

These controls apply to the existing synthetic local harness. Cross-machine TLS and certificate management, configurable operation membership, priority queues for agent-originated control messages, and authorization for external operational tools are not implemented. Scope changes affecting active work should use cancellation and a new run. Benchmark trials currently use their existing automatic synthetic-work permissions.
