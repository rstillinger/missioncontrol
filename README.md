# Mission Control

A Supabase-backed dashboard for a team of n8n agents. Ryan can assign work across business units, see what is running, inspect the output and review history, pause agents, and decide approval requests. n8n executes the work; Supabase keeps the durable task state.

## What is in this repository

- `index.html`, `styles.css`, `app.js`: a static browser dashboard. No build step or third-party JavaScript dependency.
- `supabase_migration.sql`: new `mc_*` tables, row-level policies, and atomic agent lifecycle functions. Existing CPC tables are not changed.
- `n8n/README.md`: dispatcher, worker, reviewer, watchdog, and publishing-gate wiring.

The dashboard does **not** execute agents on its own. It becomes live after the database migration, n8n workflows, and browser configuration are connected.

## Set up a development project first

1. Run `supabase_migration.sql` in a Supabase development/branch project. Review it before applying to production. It only creates `mc_*` objects and grants.
2. In **Authentication → Users**, create an account for the dashboard operator (or use an existing account with an email/password login). Copy that user's UUID.
3. In SQL Editor, run the following with the actual UUID. This grants dashboard access:

   ```sql
   insert into public.mc_members(user_id, role)
   values ('YOUR_AUTH_USER_UUID', 'admin')
   on conflict (user_id) do update set role = excluded.role;
   ```

4. Copy `config.example.js` to `config.js`. Fill in the Supabase **project URL** and **publishable/anon key** from Project Settings → API. `config.js` is gitignored. Never use a secret or `service_role` key here.
5. Serve this directory over HTTP, for example `python3 -m http.server 8080`, and visit `http://localhost:8080`. Sign in with the Supabase Auth account from step 2.
6. Add agents in **Agent team**. Each `workflow_key` should map to an n8n worker or reviewer workflow. Add a manager role if you want a planning agent that creates child tasks.
7. Wire n8n as described in [`n8n/README.md`](n8n/README.md). Create one test task and verify a failed review returns it for revision.

For deployment, serve the four frontend files from static hosting and provide a `config.js` at deploy time. Add the deployed URL to the Supabase Auth allowed redirect/site URL configuration as applicable. Use HTTPS in production. Access to `mc_*` data is limited by Supabase Auth and the `mc_members` row-level policies; the public key itself is not an authorization secret.

## Current scope

The UI shows current tasks, business-unit filters, objectives, agents, approvals, output, reviews, and recent activity. It refreshes every 20 seconds. The database prevents the same task from being claimed by two workers at once, waits for declared dependencies, and requeues expired leases up to the attempt limit. A worker and reviewer must have different agent IDs.

For the first CPC pilot, create a task referencing a `cpc_content_queue` ID as `source_table='cpc_content_queue'` and `source_id='<row ID>'`. The existing publishing workflow must check an approved `mc_approvals` record before publishing. The generic source reference avoids assuming foreign keys or constraints that were absent from the provided schema export.

## Boundaries

- The migration has not been run against the user's Supabase project. It requires review and a development-project trial before production use.
- The existing 31-relation CSV did not include table/view types, foreign keys, or current policies. No existing CPC object is altered.
- A manager agent can create child tasks through n8n using its server-side credential, but work does not start until the dispatcher claims those tasks.
- The reviewer checks a deliverable; it does not give legal or financial professional sign-off. External publishing, outreach, spending, and legal/financial commitments should be explicitly gated through approval workflows.
- Dashboard task creation requires an admin member. Browser users never receive an n8n or Supabase secret key.
