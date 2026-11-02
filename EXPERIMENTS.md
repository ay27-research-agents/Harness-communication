# Feature controls and benchmarks

Use these controls to study which communication capabilities help agents complete the same task. A **trial** is one fresh run. A **configuration** is its set of enabled features. A **benchmark** repeats trials and compares their results.

## Quick offline comparison

From the harness folder:

```powershell
.\harness.ps1 benchmark --worker scripted --repeats 1
```

This runs four fresh intelligence exercises and prints a comparison table. It saves a unique folder under `runs/benchmarks` containing:

- `results.json`: configuration, worker/model label, each run's full report, usage by agent/activity, outcome and summary.
- `results.csv`: one row per trial with success, elapsed time, input/output tokens and missing usage.
- `runs.sqlite`: the durable event history for inspecting individual trials.

The default is three repetitions per configuration (12 trials); the range is 1–20. Use `--output PATH` to choose the parent results folder. Each benchmark gets its own subfolder.

| Configuration | Shared subjects | Direct messages | Helpers |
|---|---|---|---|
| subjects-only | On | Off | Off |
| direct-only | Off | On | Off |
| combined | On | On | Off |
| combined-helpers | On | On | On |

All trials use the same initial evidence, roles, model and evaluator. Order rotates between repetitions. Helpers are available in the last configuration; live agents choose whether to request one. Presets allow new intelligence, but the benchmark evaluates only the initial assessment: it does not inject additional sources.

## Limit agents working at once

Use `--max-concurrent-agents 1|2|3` on pub/sub `run`, `serve`, `resume`, or `benchmark`. The default is 1. A value of 2 or 3 overlaps independent agent turns; dependencies still wait for their evidence. Only one turn per agent can run at once. Waiting/idle agents do not consume active slots. A helper uses its waiting parent's slot, so helpers also respect the cap.

For a new Sol socket team with up to three active agents:

```powershell
.\harness.ps1 serve --scenario intel --dashboard --worker pi --auth pi-login --provider openai-codex --model gpt-6-sol --timeout 120000 --max-concurrent-agents 3 --db runs\sol-parallel.sqlite
```

The limit is saved with the run. Existing journals default to one; resuming with a different limit is rejected. Use a fresh database or new run to change it. The dashboard's **Maximum agents working at once** selection applies to new experiment trials, including all four presets; it does not change the main team. The current team's limit appears above the controls.

Compare runs with the same features and model at limits 1, 2, and 3. Each benchmark records its chosen limit in JSON, CSV and individual run reports. Faster execution is possible, but extra decisions before peers finish can change token usage. There is no promise of a speedup on stages that depend on each other. If any turn fails, the scheduler stops assigning new turns and waits for already-started turns to finish or time out before returning an error. Restart/replay retains their saved outcomes.

## Dashboard

```powershell
.\harness.ps1 serve --scenario intel --dashboard --worker scripted --db runs\experiments-demo.sqlite
```

Open the printed Dashboard URL. In **Experiments and usage**, select:

- **Selected settings** to test the checkboxes.
- **Compare four standard configurations** to use the preset table above, ignoring the checkboxes.

Set repetitions and click **Start experiment** after the main team is idle. Results appear as trials finish. New trials use the service's model and scenario but start from fresh initial evidence, without the main team's notes or added sources. They do not replace or reconfigure the main team. Only the latest experiment is shown; all saved result folders remain available. Operator actions are blocked while the experiment runs. Stopping the service cancels unfinished trials.

## Change features on the main team

All features default to on. Start a new run with any combination of:

| Flag | What it disables |
|---|---|
| `--no-direct` | Private agent-to-agent and operator messages |
| `--no-subjects` | Creating, subscribing to, posting on, and reading shared subjects |
| `--no-helpers` | Spawning temporary helpers |
| `--no-intelligence` | Adding source documents and starting reassessments |

For a direct-only socket team:

```powershell
.\harness.ps1 serve --scenario intel --dashboard --worker scripted --no-subjects --no-helpers --db runs\direct-only.sqlite
```

For a finite shared-subjects-only run:

```powershell
.\harness.ps1 run pubsub --scenario intel --no-direct --no-helpers --db runs\subjects-only.sqlite
```

For a benchmark using one custom configuration:

```powershell
.\harness.ps1 benchmark --worker scripted --no-subjects --no-helpers --repeats 3
```

Features are enforced by the harness, not just instructions to the model. Disabled actions are rejected. Settings are saved with each run and cannot change on resume; make a new run for another configuration. Existing runs keep their previous defaults and helper limits.

With subjects disabled, agents retain their separately assigned initial evidence and exchange it privately. Added intelligence is delivered privately to the analyst, which can share it with peers. The operator journal and source files remain available for inspection; disabling shared subjects does not delete logs. Both channels off is an isolation control and is expected to fail this distributed-evidence task. Helpers receive selected evidence and return to their parent; they cannot substitute for missing peer communication.

## Use actual models

First list models available to the saved Pi login:

```powershell
.\harness.ps1 login-models
```

Then replace `MODEL_ID` below with an ID listed for your openai-codex login:

```powershell
.\harness.ps1 benchmark --worker pi --auth pi-login --provider openai-codex --model MODEL_ID --repeats 1
```

This uses your model account and makes real requests. Start with one repetition (four trials). To use dashboard controls with real models, use the same worker/auth/provider/model options on `serve --scenario intel --dashboard`.

`scripted` makes no model calls: zero tokens are expected and are labeled **no-model**. `pi-faux` exercises the installed Pi SDK with fixed responses: its usage is labeled **synthetic** and cannot establish cost or model quality. `pi` records **provider-reported** usage supplied through Pi.

## Reading the results

- **Input**: tokens supplied to the model, including cached input. **Output**: tokens generated, as reported by Pi.
- **Cache read/write**: separately reported cached-token counts. These are already included in input totals; do not add them again. Older logs may lack this breakdown.
- **By agent**: usage attributed to analyst, reviewer or reporter. Helper usage is charged to its parent agent.
- **By activity**: decision (choosing the next action), work (analyze/review/report), or helper (temporary specialist). Calls include retry attempts; scripted invocations are also counted but spend no model tokens.
- **Missing usage**: attempts with no recorded usage, such as an interrupted or failed request. Reported token totals are incomplete when this is nonzero, not a claim that those attempts were free.
- **Success**: the existing evaluator accepted the evidence-backed final report and the required delivery completed. It is specific to this synthetic exercise, not a general intelligence score.
- **Mean tokens**: average recorded input plus output across trials.
- **Tokens per success**: tokens from all trials, including failures, divided by successes; null if no trial succeeded. Available in JSON.
- **Median time**: the middle trial duration, including decisions, work, delivery, and journal activity. Initial SDK setup and result-file export are excluded.

Benchmarks use **inline delivery** (messages delivered inside one process) consistently across configurations. They compare communication behavior and model usage, not TCP transport latency. `serve` remains the separate-process socket implementation. Automatic wakeups remain enabled; there is no wakeup toggle in this version.

There are no dollar estimates or separate reasoning-token counters. Cache state and provider variability can affect live comparisons, so repeat experiments and retain the complete reports. Failed/incomplete trials remain in the results. An unfinished benchmark cannot currently be resumed; rerunning creates a new benchmark.

To inspect a saved trial:

```powershell
.\harness.ps1 inspect RUN_ID --db runs\benchmarks\BENCHMARK_ID\runs.sqlite --json
```

Use the IDs and folder printed by your benchmark. For the dashboard service, press **Ctrl+C** in its terminal to stop it.
