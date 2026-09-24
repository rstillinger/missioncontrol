begin;

-- This migration adds mission-control objects only. It does not modify CPC data.
create table if not exists public.mc_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin','viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.mc_objectives (
  id uuid primary key default gen_random_uuid(),
  business_unit text not null,
  title text not null,
  description text,
  status text not null default 'active' check (status in ('active','paused','done')),
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.mc_agents (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null unique,
  display_name text not null,
  department text not null,
  role text not null check (role in ('manager','worker','reviewer')),
  workflow_key text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.mc_tasks (
  id uuid primary key default gen_random_uuid(),
  objective_id uuid references public.mc_objectives(id) on delete set null,
  business_unit text not null,
  title text not null,
  brief text not null,
  source_table text,
  source_id text,
  status text not null default 'queued' check (status in
    ('queued','working','review_queued','reviewing','revision_queued','approval_pending','done','blocked','cancelled')),
  worker_id uuid not null references public.mc_agents(id),
  reviewer_id uuid not null references public.mc_agents(id),
  priority smallint not null default 3 check (priority between 1 and 5),
  acceptance_criteria jsonb not null default '[]'::jsonb,
  output jsonb,
  requires_approval boolean not null default false,
  due_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  work_attempts integer not null default 0,
  review_attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mc_distinct_agents check (worker_id <> reviewer_id),
  constraint mc_source_pair check ((source_table is null) = (source_id is null))
);
create table if not exists public.mc_task_dependencies (
  task_id uuid not null references public.mc_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.mc_tasks(id) on delete cascade,
  primary key(task_id,depends_on_task_id),
  check(task_id <> depends_on_task_id)
);
create index if not exists mc_tasks_dispatch_idx on public.mc_tasks (status, next_attempt_at, priority, created_at);
create index if not exists mc_tasks_source_idx on public.mc_tasks (source_table, source_id);
create index if not exists mc_tasks_lease_idx on public.mc_tasks (lease_expires_at) where lease_expires_at is not null;

create table if not exists public.mc_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.mc_tasks(id) on delete cascade,
  agent_id uuid not null references public.mc_agents(id),
  kind text not null check (kind in ('work','review')),
  status text not null default 'running' check (status in ('running','succeeded','failed','expired')),
  n8n_execution_id text,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  output jsonb,
  error text
);
create index if not exists mc_runs_task_idx on public.mc_runs (task_id, started_at desc);

create table if not exists public.mc_reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.mc_tasks(id) on delete cascade,
  run_id uuid not null unique references public.mc_runs(id),
  reviewer_id uuid not null references public.mc_agents(id),
  verdict text not null check (verdict in ('pass','revise')),
  findings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.mc_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references public.mc_tasks(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decision_note text,
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.mc_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.mc_tasks(id) on delete cascade,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists mc_events_task_idx on public.mc_events (task_id, created_at desc);

alter table public.mc_agents enable row level security;
alter table public.mc_members enable row level security;
alter table public.mc_objectives enable row level security;
alter table public.mc_tasks enable row level security;
alter table public.mc_task_dependencies enable row level security;
alter table public.mc_runs enable row level security;
alter table public.mc_reviews enable row level security;
alter table public.mc_approvals enable row level security;
alter table public.mc_events enable row level security;

revoke all on public.mc_members, public.mc_objectives, public.mc_agents, public.mc_tasks, public.mc_task_dependencies, public.mc_runs, public.mc_reviews, public.mc_approvals, public.mc_events from anon, authenticated;
grant select on public.mc_members to authenticated;
grant select,insert,update on public.mc_objectives, public.mc_agents, public.mc_tasks, public.mc_task_dependencies to authenticated;
grant select on public.mc_runs, public.mc_reviews, public.mc_approvals, public.mc_events to authenticated;
grant all on public.mc_members, public.mc_objectives, public.mc_agents, public.mc_tasks, public.mc_task_dependencies, public.mc_runs, public.mc_reviews, public.mc_approvals, public.mc_events to service_role;
grant usage, select on sequence public.mc_events_id_seq to service_role;

create or replace function public.mc_is_member(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.mc_members where user_id=p_user_id);
$$;
create or replace function public.mc_is_admin(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.mc_members where user_id=p_user_id and role='admin');
$$;
revoke all on function public.mc_is_member(uuid),public.mc_is_admin(uuid) from public,anon;
grant execute on function public.mc_is_member(uuid),public.mc_is_admin(uuid) to authenticated,service_role;

create policy mc_member_self_read on public.mc_members for select to authenticated using (user_id=auth.uid());
create policy mc_objectives_read on public.mc_objectives for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_objectives_insert on public.mc_objectives for insert to authenticated with check (public.mc_is_admin(auth.uid()));
create policy mc_objectives_update on public.mc_objectives for update to authenticated using (public.mc_is_admin(auth.uid())) with check (public.mc_is_admin(auth.uid()));
create policy mc_agents_read on public.mc_agents for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_agents_insert on public.mc_agents for insert to authenticated with check (public.mc_is_admin(auth.uid()));
create policy mc_agents_update on public.mc_agents for update to authenticated using (public.mc_is_admin(auth.uid())) with check (public.mc_is_admin(auth.uid()));
create policy mc_tasks_read on public.mc_tasks for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_tasks_insert on public.mc_tasks for insert to authenticated with check (public.mc_is_admin(auth.uid()));
create policy mc_tasks_update on public.mc_tasks for update to authenticated using (public.mc_is_admin(auth.uid())) with check (public.mc_is_admin(auth.uid()));
create policy mc_dependencies_read on public.mc_task_dependencies for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_dependencies_insert on public.mc_task_dependencies for insert to authenticated with check (public.mc_is_admin(auth.uid()));
create policy mc_dependencies_update on public.mc_task_dependencies for update to authenticated using (public.mc_is_admin(auth.uid())) with check (public.mc_is_admin(auth.uid()));
create policy mc_runs_read on public.mc_runs for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_reviews_read on public.mc_reviews for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_approvals_read on public.mc_approvals for select to authenticated using (public.mc_is_member(auth.uid()));
create policy mc_events_read on public.mc_events for select to authenticated using (public.mc_is_member(auth.uid()));

create or replace function public.mc_claim(p_agent_key text, p_kind text, p_limit integer default 1)
returns table(task_id uuid, run_id uuid, title text, brief text, acceptance_criteria jsonb,
              source_table text, source_id text, output jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_agent public.mc_agents; v_task public.mc_tasks; v_run uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  if p_kind not in ('work','review') or p_limit not between 1 and 20 then raise exception 'invalid claim'; end if;
  select * into v_agent from public.mc_agents where agent_key=p_agent_key and enabled;
  if not found or (p_kind='work' and v_agent.role not in ('worker','manager')) or (p_kind='review' and v_agent.role <> 'reviewer') then
    raise exception 'agent unavailable for this kind';
  end if;
  for v_task in
    select t.* from public.mc_tasks t
    where t.status = any(case when p_kind='work' then array['queued','revision_queued'] else array['review_queued'] end)
      and t.next_attempt_at <= now()
      and not exists (
        select 1 from public.mc_task_dependencies d join public.mc_tasks prerequisite on prerequisite.id=d.depends_on_task_id
        where d.task_id=t.id and prerequisite.status <> 'done'
      )
      and (case when p_kind='work' then t.worker_id else t.reviewer_id end) = v_agent.id
    order by t.priority desc, t.created_at
    for update skip locked limit p_limit
  loop
    insert into public.mc_runs(task_id, agent_id, kind) values(v_task.id,v_agent.id,p_kind) returning id into v_run;
    update public.mc_tasks set status=case when p_kind='work' then 'working' else 'reviewing' end,
      lease_expires_at=now()+interval '15 minutes', updated_at=now(),
      work_attempts=work_attempts+case when p_kind='work' then 1 else 0 end,
      review_attempts=review_attempts+case when p_kind='review' then 1 else 0 end
      where id=v_task.id;
    insert into public.mc_events(task_id,event_type,detail) values(v_task.id,'claimed',jsonb_build_object('agent',p_agent_key,'kind',p_kind,'run_id',v_run));
    task_id:=v_task.id; run_id:=v_run; title:=v_task.title; brief:=v_task.brief;
    acceptance_criteria:=v_task.acceptance_criteria; source_table:=v_task.source_table;
    source_id:=v_task.source_id; output:=v_task.output; return next;
  end loop;
end $$;

create or replace function public.mc_heartbeat(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select task_id into v_task_id from public.mc_runs where id=p_run_id and status='running' for update;
  if not found then return false; end if;
  update public.mc_runs set heartbeat_at=now() where id=p_run_id;
  update public.mc_tasks set lease_expires_at=now()+interval '15 minutes',updated_at=now() where id=v_task_id;
  return true;
end $$;

create or replace function public.mc_finish_run(p_run_id uuid, p_success boolean, p_output jsonb default null, p_error text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_run public.mc_runs; v_task public.mc_tasks; v_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  if p_success and p_output is null then raise exception 'successful work requires output'; end if;
  select * into v_run from public.mc_runs where id=p_run_id for update;
  if not found or v_run.kind <> 'work' then raise exception 'work run unavailable'; end if;
  if v_run.status <> 'running' then return v_run.status; end if;
  select * into v_task from public.mc_tasks where id=v_run.task_id for update;
  if v_task.status <> 'working' then raise exception 'task state mismatch'; end if;
  v_status:=case when p_success then 'review_queued'
    when v_task.work_attempts >= v_task.max_attempts then 'blocked' else 'queued' end;
  update public.mc_runs set status=case when p_success then 'succeeded' else 'failed' end,
    finished_at=now(),output=p_output,error=p_error where id=p_run_id;
  update public.mc_tasks t set status=v_status,output=case when p_success then p_output else t.output end,
    last_error=case when p_success then null else p_error end, lease_expires_at=null,
    next_attempt_at=case when p_success then now() else now()+interval '2 minutes' end,
    updated_at=now() where id=v_task.id;
  insert into public.mc_events(task_id,event_type,detail) values(v_task.id,'work_finished',jsonb_build_object('run_id',p_run_id,'status',v_status,'error',p_error));
  return v_status;
end $$;

create or replace function public.mc_fail_review(p_run_id uuid, p_error text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_run public.mc_runs; v_task public.mc_tasks; v_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_run from public.mc_runs where id=p_run_id for update;
  if not found or v_run.kind <> 'review' then raise exception 'review run unavailable'; end if;
  if v_run.status <> 'running' then return v_run.status; end if;
  select * into v_task from public.mc_tasks where id=v_run.task_id for update;
  if v_task.status <> 'reviewing' then raise exception 'task state mismatch'; end if;
  v_status:=case when v_task.review_attempts >= v_task.max_attempts then 'blocked' else 'review_queued' end;
  update public.mc_runs set status='failed',finished_at=now(),error=p_error where id=p_run_id;
  update public.mc_tasks set status=v_status,lease_expires_at=null,last_error=p_error,
    next_attempt_at=now()+interval '2 minutes',updated_at=now() where id=v_task.id;
  insert into public.mc_events(task_id,event_type,detail) values(v_task.id,'review_failed',jsonb_build_object('run_id',p_run_id,'status',v_status,'error',p_error));
  return v_status;
end $$;

create or replace function public.mc_finish_review(p_run_id uuid, p_verdict text, p_findings jsonb default '[]'::jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_run public.mc_runs; v_task public.mc_tasks; v_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  if p_verdict not in ('pass','revise') then raise exception 'invalid verdict'; end if;
  select * into v_run from public.mc_runs where id=p_run_id for update;
  if not found or v_run.kind <> 'review' then raise exception 'review run unavailable'; end if;
  if v_run.status <> 'running' then return v_run.status; end if;
  select * into v_task from public.mc_tasks where id=v_run.task_id for update;
  if v_task.status <> 'reviewing' then raise exception 'task state mismatch'; end if;
  v_status:=case when p_verdict='pass' and v_task.requires_approval then 'approval_pending'
    when p_verdict='pass' then 'done'
    when v_task.work_attempts >= v_task.max_attempts then 'blocked' else 'revision_queued' end;
  insert into public.mc_reviews(task_id,run_id,reviewer_id,verdict,findings)
    values(v_task.id,p_run_id,v_run.agent_id,p_verdict,p_findings);
  update public.mc_runs set status='succeeded',finished_at=now(),output=jsonb_build_object('verdict',p_verdict,'findings',p_findings) where id=p_run_id;
  update public.mc_tasks set status=v_status,lease_expires_at=null,next_attempt_at=now(),updated_at=now() where id=v_task.id;
  if v_status='approval_pending' then
    insert into public.mc_approvals(task_id,status) values(v_task.id,'pending')
      on conflict(task_id) do update set status='pending',decision_note=null,decided_by=null,decided_at=null;
  end if;
  insert into public.mc_events(task_id,event_type,detail) values(v_task.id,'review_finished',jsonb_build_object('run_id',p_run_id,'verdict',p_verdict,'status',v_status,'findings',p_findings));
  return v_status;
end $$;

create or replace function public.mc_decide_approval(p_task_id uuid, p_decision text, p_decided_by text, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if auth.role() <> 'service_role' and not public.mc_is_admin(auth.uid()) then raise exception 'admin required'; end if;
  if p_decision not in ('approved','rejected') or nullif(p_decided_by,'') is null then raise exception 'invalid decision'; end if;
  perform 1 from public.mc_tasks where id=p_task_id and status='approval_pending' for update;
  if not found then raise exception 'task is not awaiting approval'; end if;
  update public.mc_approvals set status=p_decision,decision_note=p_note,
    decided_by=case when auth.role()='service_role' then p_decided_by else auth.uid()::text end,decided_at=now()
    where task_id=p_task_id and status='pending';
  if not found then raise exception 'approval record unavailable'; end if;
  v_status:=case when p_decision='approved' then 'done' else 'blocked' end;
  update public.mc_tasks set status=v_status,updated_at=now() where id=p_task_id;
  insert into public.mc_events(task_id,event_type,detail) values(p_task_id,'approval_decided',jsonb_build_object('decision',p_decision,'note',p_note));
  return v_status;
end $$;

create or replace function public.mc_watchdog()
returns table(task_id uuid, new_status text) language plpgsql security definer set search_path = '' as $$
declare v_task public.mc_tasks; v_run public.mc_runs; v_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  for v_task in select t.* from public.mc_tasks t
    where t.status in ('queued','revision_queued','review_queued')
      and exists (
        select 1 from public.mc_task_dependencies d join public.mc_tasks prerequisite on prerequisite.id=d.depends_on_task_id
        where d.task_id=t.id and prerequisite.status in ('blocked','cancelled')
      )
    for update skip locked
  loop
    update public.mc_tasks set status='blocked',last_error='a prerequisite is blocked or cancelled',updated_at=now() where id=v_task.id;
    insert into public.mc_events(task_id,event_type,detail) values(v_task.id,'prerequisite_blocked','{}'::jsonb);
    task_id:=v_task.id; new_status:='blocked'; return next;
  end loop;
  for v_task in select t.* from public.mc_tasks t
    where t.status in ('working','reviewing') and t.lease_expires_at < now()
    for update skip locked
  loop
    select * into v_run from public.mc_runs r where r.task_id=v_task.id and r.status='running'
      order by started_at desc limit 1 for update;
    if found then update public.mc_runs set status='expired',finished_at=now(),error='lease expired' where id=v_run.id; end if;
    v_status:=case when v_task.status='working' and v_task.work_attempts < v_task.max_attempts then 'queued'
      when v_task.status='reviewing' and v_task.review_attempts < v_task.max_attempts then 'review_queued'
      else 'blocked' end;
    update public.mc_tasks set status=v_status,lease_expires_at=null,
      next_attempt_at=now()+interval '2 minutes',last_error='lease expired',updated_at=now()
      where id=v_task.id;
    insert into public.mc_events(task_id,event_type,detail) values(v_task.id,'lease_expired',jsonb_build_object('status',v_status));
    task_id:=v_task.id; new_status:=v_status; return next;
  end loop;
end $$;

revoke all on function public.mc_claim(text,text,integer), public.mc_heartbeat(uuid),
  public.mc_finish_run(uuid,boolean,jsonb,text), public.mc_finish_review(uuid,text,jsonb), public.mc_fail_review(uuid,text),
  public.mc_decide_approval(uuid,text,text,text), public.mc_watchdog() from public, anon, authenticated;
grant execute on function public.mc_claim(text,text,integer), public.mc_heartbeat(uuid),
  public.mc_finish_run(uuid,boolean,jsonb,text), public.mc_finish_review(uuid,text,jsonb), public.mc_fail_review(uuid,text),
  public.mc_decide_approval(uuid,text,text,text), public.mc_watchdog() to service_role;
grant execute on function public.mc_decide_approval(uuid,text,text,text) to authenticated;

commit;
