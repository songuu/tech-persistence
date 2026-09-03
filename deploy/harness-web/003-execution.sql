-- Install after 002-tasks.sql. Authority claims are durable and fenced; unknown dispatches are never replayed.
BEGIN;
CREATE ROLE tp_task_authority NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

ALTER TABLE harness_tasks.tasks DROP CONSTRAINT tasks_state_check;
ALTER TABLE harness_tasks.tasks DROP CONSTRAINT tasks_check;
ALTER TABLE harness_tasks.tasks
  ADD COLUMN claim_token uuid,
  ADD COLUMN worker_id text,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN dispatch_started boolean NOT NULL DEFAULT false,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN terminal_code text,
  ADD COLUMN result_ref text,
  ADD CONSTRAINT tasks_state_check CHECK (state IN ('draft', 'queued', 'claimed', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'needs_coordination')),
  ADD CONSTRAINT tasks_execution_shape CHECK (
    (state = 'draft' AND execution_key IS NULL AND queued_at IS NULL AND claim_token IS NULL AND NOT dispatch_started AND finished_at IS NULL)
    OR (state = 'queued' AND execution_key IS NOT NULL AND queued_at IS NOT NULL AND claim_token IS NULL AND NOT dispatch_started AND finished_at IS NULL)
    OR (state = 'claimed' AND claim_token IS NOT NULL AND worker_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND NOT dispatch_started AND started_at IS NULL AND finished_at IS NULL)
    OR (state IN ('running', 'cancel_requested') AND claim_token IS NOT NULL AND worker_id IS NOT NULL AND dispatch_started AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('succeeded', 'failed', 'cancelled', 'needs_coordination') AND execution_key IS NOT NULL AND queued_at IS NOT NULL AND finished_at IS NOT NULL)
  ),
  ADD CONSTRAINT tasks_worker_id_check CHECK (worker_id IS NULL OR worker_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  ADD CONSTRAINT tasks_terminal_code_check CHECK (terminal_code IS NULL OR terminal_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT tasks_result_ref_check CHECK (result_ref IS NULL OR (octet_length(result_ref) BETWEEN 1 AND 512 AND result_ref !~ '[[:cntrl:]]'));
CREATE INDEX tasks_active_lease ON harness_tasks.tasks(lease_until) WHERE state IN ('claimed', 'running', 'cancel_requested');

-- Authentication owns this narrowly scoped row-lock helper; task authority receives no account DML privilege.
CREATE FUNCTION harness_web.lock_execution_account(p_account uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_web, pg_temp AS $$
DECLARE active boolean;
BEGIN
  SELECT true INTO active FROM harness_web.accounts WHERE id = p_account AND NOT disabled FOR SHARE;
  RETURN COALESCE(active, false);
END $$;
ALTER FUNCTION harness_web.lock_execution_account(uuid) OWNER TO tp_web_account_admin;
REVOKE ALL ON FUNCTION harness_web.lock_execution_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION harness_web.lock_execution_account(uuid) TO tp_task_owner;

CREATE FUNCTION harness_tasks.claim_next(p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE candidate harness_tasks.tasks; token uuid := gen_random_uuid(); now_at timestamptz := clock_timestamp();
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9][a-z0-9_-]{2,63}$' THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid worker'; END IF;
  PERFORM pg_advisory_xact_lock(213804733, 1);
  now_at := clock_timestamp();
  -- Only a claim proven not to have crossed the dispatch boundary is replayable.
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
    'projectId', candidate.project_id, 'requirement', candidate.requirement);
END $$;

CREATE FUNCTION harness_tasks.start_claim(p_worker text, p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE changed integer; now_at timestamptz := clock_timestamp();
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  PERFORM pg_advisory_xact_lock(213804733, 1);
  IF NOT harness_web.lock_execution_account((SELECT owner_id FROM harness_tasks.tasks
      WHERE worker_id = p_worker AND claim_token = p_token AND state = 'claimed')) THEN RETURN false; END IF;
  PERFORM 1 FROM harness_tasks.tasks t JOIN harness_tasks.projects p ON p.id = t.project_id
    JOIN harness_tasks.members m ON m.project_id = t.project_id AND m.account_id = t.owner_id
    WHERE t.worker_id = p_worker AND t.claim_token = p_token AND t.state = 'claimed'
      AND p.enabled AND p.execution_enabled AND m.can_execute FOR SHARE OF p, m;
  IF NOT FOUND THEN RETURN false; END IF;
  now_at := clock_timestamp();
  UPDATE harness_tasks.tasks t SET state = 'running', dispatch_started = true, started_at = now_at, lease_until = now_at + interval '30 seconds'
    FROM harness_web.accounts a, harness_tasks.projects p, harness_tasks.members m
    WHERE t.worker_id = p_worker AND t.claim_token = p_token AND t.state = 'claimed' AND t.lease_until > now_at
      AND a.id = t.owner_id AND NOT a.disabled AND p.id = t.project_id AND p.enabled AND p.execution_enabled
      AND m.project_id = t.project_id AND m.account_id = t.owner_id AND m.can_execute;
  GET DIAGNOSTICS changed = ROW_COUNT; RETURN changed = 1;
END $$;

CREATE FUNCTION harness_tasks.heartbeat_claim(p_worker text, p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE current_state text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  UPDATE harness_tasks.tasks SET lease_until = clock_timestamp() + interval '30 seconds'
    WHERE worker_id = p_worker AND claim_token = p_token AND state IN ('claimed', 'running', 'cancel_requested') AND lease_until > clock_timestamp()
    RETURNING state INTO current_state;
  IF current_state IS NULL THEN RETURN jsonb_build_object('owned', false, 'cancel', true); END IF;
  RETURN jsonb_build_object('owned', true, 'cancel', current_state = 'cancel_requested');
END $$;

CREATE FUNCTION harness_tasks.finish_claim(p_worker text, p_token uuid, p_outcome text, p_code text, p_result_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  IF p_outcome NOT IN ('succeeded', 'failed', 'cancelled', 'needs_coordination') OR p_code IS NULL
    OR p_code !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR p_result_ref IS NULL OR octet_length(p_result_ref) NOT BETWEEN 1 AND 512 OR p_result_ref ~ '[[:cntrl:]]'
    THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid outcome'; END IF;
  UPDATE harness_tasks.tasks SET state = p_outcome, finished_at = clock_timestamp(), lease_until = NULL, terminal_code = p_code, result_ref = p_result_ref
    WHERE worker_id = p_worker AND claim_token = p_token AND state IN ('running', 'cancel_requested')
      AND lease_until > clock_timestamp()
      AND (state <> 'cancel_requested' OR p_outcome IN ('cancelled', 'needs_coordination'));
  GET DIAGNOSTICS changed = ROW_COUNT; RETURN changed = 1;
END $$;

CREATE FUNCTION harness_tasks.fail_claim_before_dispatch(p_worker text, p_token uuid, p_code text, p_result_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR p_result_ref IS NULL
    OR octet_length(p_result_ref) NOT BETWEEN 1 AND 512 OR p_result_ref ~ '[[:cntrl:]]'
    THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid outcome'; END IF;
  UPDATE harness_tasks.tasks SET state = 'failed', finished_at = clock_timestamp(), lease_until = NULL,
    terminal_code = p_code, result_ref = p_result_ref
    WHERE worker_id = p_worker AND claim_token = p_token AND state = 'claimed' AND NOT dispatch_started AND lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT; RETURN changed = 1;
END $$;

CREATE FUNCTION harness_tasks.release_claim_before_dispatch(p_worker text, p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, pg_temp AS $$
DECLARE changed integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  UPDATE harness_tasks.tasks SET state = 'queued', claim_token = NULL, worker_id = NULL, claimed_at = NULL, lease_until = NULL
    WHERE worker_id = p_worker AND claim_token = p_token AND state = 'claimed' AND NOT dispatch_started;
  GET DIAGNOSTICS changed = ROW_COUNT; RETURN changed = 1;
END $$;

CREATE FUNCTION harness_tasks.request_cancel(p_hash text, p_task uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; current_task harness_tasks.tasks;
BEGIN
  account := harness_tasks.principal(p_hash, true);
  SELECT t.* INTO current_task FROM harness_tasks.tasks t
    JOIN harness_tasks.projects p ON p.id = t.project_id AND p.enabled
    JOIN harness_tasks.members m ON m.project_id = t.project_id AND m.account_id = account
    WHERE t.id = p_task AND t.owner_id = account FOR UPDATE OF t FOR SHARE OF p, m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'not found'; END IF;
  IF current_task.state = 'queued' OR (current_task.state = 'claimed' AND NOT current_task.dispatch_started) THEN
    UPDATE harness_tasks.tasks SET state = 'cancelled', finished_at = clock_timestamp(), lease_until = NULL,
      terminal_code = 'cancelled_before_dispatch', result_ref = 'authority:cancelled-before-dispatch'
      WHERE id = current_task.id AND state = current_task.state AND NOT dispatch_started RETURNING * INTO current_task;
  ELSIF current_task.state = 'running' THEN
    UPDATE harness_tasks.tasks SET state = 'cancel_requested' WHERE id = current_task.id AND state = 'running' RETURNING * INTO current_task;
  ELSIF current_task.state NOT IN ('cancel_requested', 'succeeded', 'failed', 'cancelled', 'needs_coordination') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'task is not cancellable';
  END IF;
  RETURN harness_tasks.task_view(current_task, true);
END $$;

ALTER FUNCTION harness_tasks.claim_next(text) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.start_claim(text, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.heartbeat_claim(text, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.finish_claim(text, uuid, text, text, text) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.fail_claim_before_dispatch(text, uuid, text, text) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.release_claim_before_dispatch(text, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.request_cancel(text, uuid) OWNER TO tp_task_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA harness_tasks FROM PUBLIC;
GRANT USAGE ON SCHEMA harness_tasks TO tp_task_authority;
GRANT EXECUTE ON FUNCTION harness_tasks.claim_next(text), harness_tasks.start_claim(text, uuid),
  harness_tasks.heartbeat_claim(text, uuid), harness_tasks.finish_claim(text, uuid, text, text, text) TO tp_task_authority;
GRANT EXECUTE ON FUNCTION harness_tasks.fail_claim_before_dispatch(text, uuid, text, text) TO tp_task_authority;
GRANT EXECUTE ON FUNCTION harness_tasks.release_claim_before_dispatch(text, uuid) TO tp_task_authority;
GRANT EXECUTE ON FUNCTION harness_tasks.request_cancel(text, uuid) TO tp_web_tasks;
GRANT CONNECT ON DATABASE tech_persistence TO tp_task_authority;
COMMIT;
