-- First installation after 001-auth.sql. No existing names are adopted or overwritten.
BEGIN;
CREATE ROLE tp_task_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE tp_web_tasks NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA harness_tasks AUTHORIZATION tp_task_owner;
REVOKE ALL ON SCHEMA harness_tasks FROM PUBLIC;
GRANT USAGE ON SCHEMA harness_web TO tp_task_owner;
GRANT SELECT(id, auth_version, disabled) ON harness_web.accounts TO tp_task_owner;
GRANT SELECT(token_hash, account_id, auth_version, expires_at, revoked_at) ON harness_web.sessions TO tp_task_owner;

CREATE TABLE harness_tasks.projects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  enabled boolean NOT NULL DEFAULT false,
  execution_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE harness_tasks.members (
  account_id uuid NOT NULL REFERENCES harness_web.accounts(id),
  project_id text NOT NULL REFERENCES harness_tasks.projects(id),
  can_create boolean NOT NULL DEFAULT false,
  can_execute boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_id, project_id)
);
CREATE INDEX members_project ON harness_tasks.members(project_id);
CREATE TABLE harness_tasks.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES harness_web.accounts(id),
  project_id text NOT NULL REFERENCES harness_tasks.projects(id),
  requirement text NOT NULL CHECK (octet_length(requirement) BETWEEN 1 AND 16384 AND requirement ~ '[^[:space:]]'),
  creation_key uuid NOT NULL CHECK (creation_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'queued')),
  execution_key uuid CHECK (execution_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  queued_at timestamptz,
  UNIQUE(owner_id, creation_key),
  UNIQUE(owner_id, execution_key),
  CHECK ((state = 'draft' AND execution_key IS NULL AND queued_at IS NULL)
    OR (state = 'queued' AND execution_key IS NOT NULL AND queued_at IS NOT NULL AND queued_at >= created_at))
);
CREATE INDEX tasks_owner_page ON harness_tasks.tasks(owner_id, created_at DESC, id DESC);
CREATE INDEX tasks_project ON harness_tasks.tasks(project_id);
CREATE INDEX tasks_created ON harness_tasks.tasks(created_at);
CREATE INDEX tasks_queued ON harness_tasks.tasks(queued_at) WHERE state = 'queued';
ALTER TABLE harness_tasks.projects OWNER TO tp_task_owner;
ALTER TABLE harness_tasks.members OWNER TO tp_task_owner;
ALTER TABLE harness_tasks.tasks OWNER TO tp_task_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA harness_tasks FROM PUBLIC;

-- Private helpers are never executable by the web role. All relations/functions are schema-bound.
CREATE FUNCTION harness_tasks.principal(p_hash text, p_mutating boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'unsafe isolation'; END IF;
  IF p_mutating THEN PERFORM pg_advisory_xact_lock(213804733, 0); END IF;
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION USING ERRCODE = 'P0401', MESSAGE = 'unauthorized'; END IF;
  SELECT a.id INTO account FROM harness_web.accounts a JOIN harness_web.sessions s ON s.account_id = a.id AND s.auth_version = a.auth_version
    WHERE s.token_hash = p_hash AND NOT a.disabled AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp();
  IF account IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0401', MESSAGE = 'unauthorized'; END IF;
  RETURN account;
END $$;

CREATE FUNCTION harness_tasks.visible_task(p_account uuid, p_task uuid) RETURNS harness_tasks.tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE found_task harness_tasks.tasks;
BEGIN
  SELECT t.* INTO found_task FROM harness_tasks.tasks t JOIN harness_tasks.projects p ON p.id = t.project_id AND p.enabled
    JOIN harness_tasks.members m ON m.project_id = t.project_id AND m.account_id = p_account
    WHERE t.id = p_task AND t.owner_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'not found'; END IF;
  RETURN found_task;
END $$;

CREATE FUNCTION harness_tasks.task_view(p_task harness_tasks.tasks, p_detail boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
  SELECT jsonb_build_object('id', (p_task).id, 'projectId', (p_task).project_id, 'state', (p_task).state,
    'createdAt', (p_task).created_at, 'queuedAt', (p_task).queued_at)
    || CASE WHEN p_detail THEN jsonb_build_object('requirement', (p_task).requirement) ELSE '{}'::jsonb END
$$;

CREATE FUNCTION harness_tasks.create_task(p_hash text, p_project text, p_requirement text, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; existing harness_tasks.tasks; cutoff timestamptz;
BEGIN
  account := harness_tasks.principal(p_hash, true);
  IF p_project IS NULL OR p_project !~ '^[a-z0-9][a-z0-9_-]{2,63}$' OR p_key IS NULL
    OR p_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_requirement IS NULL OR octet_length(p_requirement) NOT BETWEEN 1 AND 16384 OR p_requirement !~ '[^[:space:]]'
    THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid request'; END IF;
  -- Hold the policy rows until commit so revocation cannot slip between authorization and mutation.
  PERFORM 1 FROM harness_tasks.projects p JOIN harness_tasks.members m ON m.project_id = p.id
    WHERE p.id = p_project AND p.enabled AND m.account_id = account AND m.can_create FOR SHARE OF p, m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'not found'; END IF;
  SELECT t.* INTO existing FROM harness_tasks.tasks t WHERE t.owner_id = account AND t.creation_key = p_key;
  IF FOUND THEN
    IF existing.project_id <> p_project OR existing.requirement <> p_requirement THEN RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'idempotency conflict'; END IF;
    RETURN harness_tasks.task_view(existing, true) || jsonb_build_object('replayed', true);
  END IF;
  cutoff := clock_timestamp() - interval '1 minute';
  IF (SELECT count(*) FROM harness_tasks.tasks t WHERE t.owner_id = account AND t.state = 'draft') >= 10
    OR (SELECT count(*) FROM harness_tasks.tasks t WHERE t.owner_id = account) >= 100
    OR (SELECT count(*) FROM harness_tasks.tasks) >= 1000
    OR (SELECT count(*) FROM harness_tasks.tasks t WHERE t.owner_id = account AND t.created_at > cutoff) >= 5
    OR (SELECT count(*) FROM harness_tasks.tasks t WHERE t.created_at > cutoff) >= 20
    THEN RAISE EXCEPTION USING ERRCODE = 'P0429', MESSAGE = 'task limit'; END IF;
  INSERT INTO harness_tasks.tasks(owner_id, project_id, requirement, creation_key) VALUES(account, p_project, p_requirement, p_key) RETURNING * INTO existing;
  RETURN harness_tasks.task_view(existing, true) || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION harness_tasks.enqueue_task(p_hash text, p_task uuid, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; existing harness_tasks.tasks; allowed boolean; qualified boolean; cutoff timestamptz;
BEGIN
  account := harness_tasks.principal(p_hash, true);
  IF p_task IS NULL OR p_key IS NULL OR p_key::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid request'; END IF;
  existing := harness_tasks.visible_task(account, p_task);
  SELECT m.can_execute, p.execution_enabled INTO allowed, qualified FROM harness_tasks.members m JOIN harness_tasks.projects p ON p.id = m.project_id
    WHERE m.account_id = account AND m.project_id = existing.project_id AND p.enabled FOR SHARE OF p, m;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'not found'; END IF;
  IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'forbidden'; END IF;
  IF qualified IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'execution unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM harness_tasks.tasks t WHERE t.owner_id = account AND t.execution_key = p_key AND t.id <> p_task)
    THEN RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'idempotency conflict'; END IF;
  IF existing.state = 'queued' THEN
    IF existing.execution_key <> p_key THEN RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'already queued'; END IF;
    RETURN harness_tasks.task_view(existing, true) || jsonb_build_object('replayed', true);
  END IF;
  IF existing.state <> 'draft' THEN RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'task is not enqueueable'; END IF;
  cutoff := clock_timestamp() - interval '1 minute';
  IF (SELECT count(*) FROM harness_tasks.tasks t WHERE t.owner_id = account AND t.state = 'queued') >= 5
    OR (SELECT count(*) FROM harness_tasks.tasks t WHERE t.state = 'queued') >= 20
    OR (SELECT count(*) FROM harness_tasks.tasks t WHERE t.owner_id = account AND t.queued_at > cutoff) >= 5
    OR (SELECT count(*) FROM harness_tasks.tasks t WHERE t.queued_at > cutoff) >= 20
    THEN RAISE EXCEPTION USING ERRCODE = 'P0429', MESSAGE = 'queue limit'; END IF;
  UPDATE harness_tasks.tasks SET state = 'queued', execution_key = p_key, queued_at = clock_timestamp() WHERE id = existing.id RETURNING * INTO existing;
  RETURN harness_tasks.task_view(existing, true) || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION harness_tasks.get_task(p_hash text, p_task uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
BEGIN RETURN harness_tasks.task_view(harness_tasks.visible_task(harness_tasks.principal(p_hash, false), p_task), true); END $$;

CREATE FUNCTION harness_tasks.list_tasks(p_hash text, p_after uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; anchor harness_tasks.tasks; entries jsonb; cursor_value uuid;
BEGIN
  account := harness_tasks.principal(p_hash, false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid page'; END IF;
  IF p_after IS NOT NULL THEN anchor := harness_tasks.visible_task(account, p_after); END IF;
  SELECT COALESCE(jsonb_agg(harness_tasks.task_view(q, false) ORDER BY q.created_at DESC, q.id DESC), '[]'::jsonb) INTO entries FROM (
    SELECT t.* FROM harness_tasks.tasks t JOIN harness_tasks.projects p ON p.id = t.project_id AND p.enabled
      JOIN harness_tasks.members m ON m.project_id = t.project_id AND m.account_id = account
      WHERE t.owner_id = account AND (p_after IS NULL OR (t.created_at, t.id) < (anchor.created_at, anchor.id))
      ORDER BY t.created_at DESC, t.id DESC LIMIT p_limit + 1
  ) q;
  IF jsonb_array_length(entries) > p_limit THEN entries := entries - p_limit; cursor_value := (entries -> (p_limit - 1) ->> 'id')::uuid; END IF;
  RETURN jsonb_build_object('items', entries, 'nextCursor', cursor_value);
END $$;

CREATE FUNCTION harness_tasks.list_projects(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, harness_tasks, harness_web, pg_temp AS $$
DECLARE account uuid; entries jsonb;
BEGIN
  account := harness_tasks.principal(p_hash, false);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'canCreate', q.can_create,
    'canExecute', q.can_execute AND q.execution_enabled) ORDER BY q.id), '[]'::jsonb) INTO entries FROM (
    SELECT p.id, p.name, m.can_create, m.can_execute, p.execution_enabled FROM harness_tasks.projects p
      JOIN harness_tasks.members m ON m.project_id = p.id WHERE m.account_id = account AND p.enabled ORDER BY p.id LIMIT 101
  ) q;
  IF jsonb_array_length(entries) > 100 THEN RAISE EXCEPTION USING ERRCODE = 'P0503', MESSAGE = 'project limit'; END IF;
  RETURN entries;
END $$;

ALTER FUNCTION harness_tasks.principal(text, boolean) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.visible_task(uuid, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.task_view(harness_tasks.tasks, boolean) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.create_task(text, text, text, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.enqueue_task(text, uuid, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.get_task(text, uuid) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.list_tasks(text, uuid, integer) OWNER TO tp_task_owner;
ALTER FUNCTION harness_tasks.list_projects(text) OWNER TO tp_task_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA harness_tasks FROM PUBLIC;
GRANT USAGE ON SCHEMA harness_tasks TO tp_web_tasks;
GRANT EXECUTE ON FUNCTION harness_tasks.create_task(text, text, text, uuid), harness_tasks.enqueue_task(text, uuid, uuid),
  harness_tasks.get_task(text, uuid), harness_tasks.list_tasks(text, uuid, integer), harness_tasks.list_projects(text) TO tp_web_tasks;
GRANT CONNECT ON DATABASE tech_persistence TO tp_web_tasks;
COMMIT;
