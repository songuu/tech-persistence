-- Install after 003-execution.sql. A confirmed specification resumes the original immutable run.
BEGIN;

ALTER TABLE harness_tasks.tasks DROP CONSTRAINT tasks_execution_shape;
ALTER TABLE harness_tasks.tasks
  ADD COLUMN resume_claim_token uuid,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmed_by uuid REFERENCES harness_web.accounts(id),
  ADD CONSTRAINT tasks_execution_shape CHECK (
    (state = 'draft' AND execution_key IS NULL AND queued_at IS NULL AND claim_token IS NULL AND resume_claim_token IS NULL
      AND NOT dispatch_started AND finished_at IS NULL AND confirmed_at IS NULL AND confirmed_by IS NULL)
    OR (state = 'queued' AND execution_key IS NOT NULL AND queued_at IS NOT NULL AND claim_token IS NULL
      AND NOT dispatch_started AND finished_at IS NULL
      AND ((resume_claim_token IS NULL AND confirmed_at IS NULL AND confirmed_by IS NULL)
        OR (resume_claim_token IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by = owner_id)))
    OR (state = 'claimed' AND claim_token IS NOT NULL AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_until IS NOT NULL AND NOT dispatch_started AND started_at IS NULL AND finished_at IS NULL)
    OR (state IN ('running', 'cancel_requested') AND claim_token IS NOT NULL AND worker_id IS NOT NULL
      AND dispatch_started AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('succeeded', 'failed', 'cancelled', 'needs_coordination') AND execution_key IS NOT NULL
      AND queued_at IS NOT NULL AND finished_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION harness_tasks.task_view(p_task harness_tasks.tasks, p_detail boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
  SELECT jsonb_build_object('id', (p_task).id, 'projectId', (p_task).project_id, 'state', (p_task).state,
    'createdAt', (p_task).created_at, 'queuedAt', (p_task).queued_at)
    || CASE WHEN p_detail THEN jsonb_build_object('requirement', (p_task).requirement,
      'terminalCode', (p_task).terminal_code,
      'confirmationRequired', (p_task).state = 'needs_coordination' AND (p_task).terminal_code = 'harness_spec_ready')
      ELSE '{}'::jsonb END
$$;

CREATE FUNCTION harness_tasks.confirm_task(p_hash text, p_task uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; current_task harness_tasks.tasks;
BEGIN
  account := harness_tasks.principal(p_hash, true);
  SELECT t.* INTO current_task FROM harness_tasks.tasks t
    JOIN harness_tasks.projects p ON p.id = t.project_id AND p.enabled AND p.execution_enabled
    JOIN harness_tasks.members m ON m.project_id = t.project_id AND m.account_id = account AND m.can_execute
    WHERE t.id = p_task AND t.owner_id = account FOR UPDATE OF t FOR SHARE OF p, m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'not found'; END IF;
  IF current_task.state <> 'needs_coordination' OR current_task.terminal_code <> 'harness_spec_ready'
    OR current_task.claim_token IS NULL OR current_task.resume_claim_token IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'task is not confirmable';
  END IF;
  UPDATE harness_tasks.tasks SET state = 'queued', resume_claim_token = claim_token, claim_token = NULL,
    worker_id = NULL, claimed_at = NULL, lease_until = NULL, dispatch_started = false, started_at = NULL,
    finished_at = NULL, terminal_code = NULL, confirmed_at = clock_timestamp(), confirmed_by = account
    WHERE id = current_task.id RETURNING * INTO current_task;
  RETURN harness_tasks.task_view(current_task, true);
END $$;

CREATE OR REPLACE FUNCTION harness_tasks.claim_next(p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE candidate harness_tasks.tasks; token uuid := gen_random_uuid(); now_at timestamptz := clock_timestamp();
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9][a-z0-9_-]{2,63}$' THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid worker'; END IF;
  PERFORM pg_advisory_xact_lock(213804733, 1);
  now_at := clock_timestamp();
  UPDATE harness_tasks.tasks SET state = 'queued', claim_token = NULL, worker_id = NULL, claimed_at = NULL, lease_until = NULL
    WHERE state = 'claimed' AND NOT dispatch_started AND lease_until <= now_at;
  UPDATE harness_tasks.tasks SET state = 'needs_coordination', finished_at = now_at, terminal_code = 'lease_expired_after_dispatch'
    WHERE state IN ('running', 'cancel_requested') AND dispatch_started AND lease_until <= now_at;
  IF EXISTS (SELECT 1 FROM harness_tasks.tasks WHERE state IN ('claimed', 'running', 'cancel_requested', 'needs_coordination')) THEN RETURN NULL; END IF;
  SELECT t.* INTO candidate FROM harness_tasks.tasks t
    JOIN harness_web.accounts a ON a.id = t.owner_id AND NOT a.disabled
    JOIN harness_tasks.projects p ON p.id = t.project_id AND p.enabled AND p.execution_enabled
    JOIN harness_tasks.members m ON m.project_id = t.project_id AND m.account_id = t.owner_id AND m.can_execute
    WHERE t.state = 'queued' ORDER BY t.queued_at, t.id LIMIT 1 FOR UPDATE OF t, p, m SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE harness_tasks.tasks SET state = 'claimed', claim_token = token, worker_id = p_worker, claimed_at = now_at,
    lease_until = now_at + interval '30 seconds' WHERE id = candidate.id RETURNING * INTO candidate;
  RETURN jsonb_build_object('taskId', candidate.id, 'claimToken', candidate.claim_token, 'ownerId', candidate.owner_id,
    'projectId', candidate.project_id, 'requirement', candidate.requirement, 'resumeClaimToken', candidate.resume_claim_token);
END $$;

CREATE FUNCTION harness_tasks.transcript_locator(p_hash text, p_task uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; current_task harness_tasks.tasks; attempt uuid; run_root text;
BEGIN
  account := harness_tasks.principal(p_hash, false);
  current_task := harness_tasks.visible_task(account, p_task);
  attempt := COALESCE(current_task.resume_claim_token, current_task.claim_token);
  IF attempt IS NULL THEN RETURN NULL; END IF;
  run_root := '/var/lib/tech-persistence/task-sandboxes/' || current_task.id::text || '/' || attempt::text
    || '/evidence/runs/' || current_task.id::text || '-' || attempt::text;
  RETURN encode(sha256(convert_to(run_root, 'UTF8')), 'hex');
END $$;

ALTER FUNCTION harness_tasks.task_view(harness_tasks.tasks, boolean) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.confirm_task(text, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.claim_next(text) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.transcript_locator(text, uuid) OWNER TO tp_task_owner;
REVOKE ALL ON FUNCTION harness_tasks.confirm_task(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION harness_tasks.confirm_task(text, uuid) TO tp_web_tasks;
GRANT EXECUTE ON FUNCTION harness_tasks.transcript_locator(text, uuid) TO tp_web_tasks;
COMMIT;
