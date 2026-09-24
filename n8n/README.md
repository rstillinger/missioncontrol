# n8n integration

The mission control ledger controls state; n8n runs the specialist workflows you already use. Make a single server-side Supabase credential in n8n. All requests below use `POST https://PROJECT_REF.supabase.co/rest/v1/rpc/FUNCTION` with headers:

```text
apikey: SUPABASE_SERVER_SIDE_KEY
Authorization: Bearer SUPABASE_SERVER_SIDE_KEY
Content-Type: application/json
```

Keep that key in n8n credentials, never in the dashboard, webhook URL, task output, or GitHub.

## 1. Dispatcher: every minute

Read enabled `mc_agents`, then for each agent call `mc_claim` with a small limit. Map `workflow_key` to the corresponding n8n workflow. A manager uses kind `work`, just like a specialist; a reviewer uses kind `review`.

```json
{"p_agent_key":"cpc-marketing-writer","p_kind":"work","p_limit":3}
```

Each returned row contains `task_id`, `run_id`, `title`, `brief`, `acceptance_criteria`, `source_table`, `source_id`, and the previous `output`. Start the mapped workflow with this payload. For a revision, fetch the latest `mc_reviews` row for the task and pass its `findings` as well. Store the n8n execution ID in `mc_runs.n8n_execution_id` if useful. If dispatch itself fails after claim, the watchdog will recover the lease.

The claim function uses row locks and skips tasks with unfinished dependencies, so two dispatchers can run without taking the same task. Each run has a 15-minute lease. Long jobs should call `mc_heartbeat` before it expires:

```json
{"p_run_id":"RUN_UUID"}
```

## 2. Worker or manager

Read the relevant business record when `source_table` and `source_id` are present. Produce structured output with an artifact or record URL, supporting evidence, and the result of each acceptance criterion. On success call:

```json
{"p_run_id":"RUN_UUID","p_success":true,"p_output":{"artifact_url":"https://example.com/draft","checks":[{"criterion":"Claims sourced","passed":true}]}}
```

On failure call `mc_finish_run` with `p_success=false`, `p_output=null`, and `p_error`. A failed worker gets a two-minute backoff and a bounded retry. A successful worker moves the task to `review_queued`.

A manager agent can produce a plan, create child tasks through the Supabase REST API, and insert rows into `mc_task_dependencies`. Keep child task creation idempotent: check for existing tasks under the objective before inserting, or store a stable external key in the manager output. A manager run still needs an independent reviewer and normal completion call.

## 3. Reviewer

Use a distinct agent and workflow. Compare the worker output to the acceptance criteria, source evidence, and any domain-specific rules. A CPC marketing reviewer should check factual claims, source links, CTA, channel formatting, and `cpc_content_queue.compliance_flags`.

```json
{"p_run_id":"RUN_UUID","p_verdict":"revise","p_findings":[{"criterion":"Claims sourced","issue":"The stated rate has no source URL"}]}
```

Call `mc_finish_review` with `pass` or `revise`. A pass moves to `approval_pending` when the task requires Ryan's approval, otherwise to `done`. A revision returns to the original worker with the findings. On an execution error, call `mc_fail_review` with `p_run_id` and `p_error`. A timeout is handled by the watchdog.

## 4. Watchdog: every five minutes

Call `mc_watchdog` with `{}`. For each returned `task_id` and `new_status`, notify Ryan if the task is `blocked`; otherwise the dispatcher picks it up on the next eligible cycle. Monitor the count of blocked tasks and pending approvals. Do not turn a failed task into an infinite retry loop.

## 5. Approval and external action

Ryan approves or rejects in the dashboard. `mc_decide_approval` updates the task and approval record together. Before a publishing or outreach workflow acts, it must read the matching `mc_approvals` row and require `status='approved'` for the exact task ID. Use the task ID as an idempotency key in the external workflow; an approval is permission for a particular proposed action, not blanket permission for later actions.

For the CPC content pilot, keep the existing `cpc_content_queue` draft workflow. Attach its row ID to the mission task, and put the actual publish step behind this approval check. Test with an unpublished draft before enabling the live schedule.

## Suggested starter roster

| Department | Worker | Independent check |
| --- | --- | --- |
| Management | Chief of Staff planner | Operations reviewer |
| Finance | Finance analyst | Finance reviewer |
| Legal/compliance | Issue spotter | Compliance reviewer and human counsel for legal decisions |
| Marketing | Content writer | Claims and brand reviewer |
| Sales | Prospect researcher | Data-quality reviewer |
| Operations | Process operator | QA reviewer |

Add only workflows with a real task contract and test data. The roster can grow without changing the schema.
