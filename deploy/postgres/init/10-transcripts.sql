\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.transcripts (
  transcript_id text PRIMARY KEY CHECK (transcript_id <> ''),
  root_session_id text NOT NULL CHECK (root_session_id <> ''),
  parent_thread_id text,
  source_file_name text NOT NULL CHECK (
    source_file_name <> ''
    AND source_file_name = regexp_replace(source_file_name, '^.*[\\/]', '')
  ),
  path_hash text NOT NULL CHECK (path_hash ~ '^[0-9a-f]{64}$'),
  file_identity_hash text NOT NULL CHECK (file_identity_hash ~ '^[0-9a-f]{64}$'),
  position_kind text NOT NULL CHECK (position_kind IN ('ordinal', 'line')),
  observed_size bigint NOT NULL DEFAULT 0 CHECK (observed_size >= 0),
  observed_mtime double precision CHECK (observed_mtime IS NULL OR observed_mtime >= 0),
  next_byte_offset bigint NOT NULL DEFAULT 0 CHECK (next_byte_offset >= 0),
  next_line_no bigint NOT NULL DEFAULT 1 CHECK (next_line_no >= 1),
  last_ordinal bigint CHECK (last_ordinal IS NULL OR last_ordinal >= 0),
  last_event_byte_offset bigint CHECK (
    last_event_byte_offset IS NULL OR last_event_byte_offset >= 0
  ),
  last_event_byte_length bigint CHECK (
    last_event_byte_length IS NULL OR last_event_byte_length > 0
  ),
  last_event_sha256 text CHECK (
    last_event_sha256 IS NULL OR last_event_sha256 ~ '^[0-9a-f]{64}$'
  ),
  event_chain_sha256 text CHECK (
    event_chain_sha256 IS NULL OR event_chain_sha256 ~ '^[0-9a-f]{64}$'
  ),
  projection_chain_sha256 text CHECK (
    projection_chain_sha256 IS NULL OR projection_chain_sha256 ~ '^[0-9a-f]{64}$'
  ),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  projection_version text NOT NULL CHECK (projection_version <> ''),
  redaction_version text NOT NULL CHECK (redaction_version <> ''),
  cwd text,
  originator text,
  cli_version text,
  source text,
  model_provider text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_event_at timestamptz,
  last_event_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path_hash)
);

CREATE TABLE IF NOT EXISTS public.transcript_events (
  transcript_id text NOT NULL REFERENCES public.transcripts(transcript_id) ON DELETE CASCADE,
  position_kind text NOT NULL CHECK (position_kind IN ('ordinal', 'line')),
  source_position bigint NOT NULL CHECK (
    (position_kind = 'ordinal' AND source_position >= 0)
    OR (position_kind = 'line' AND source_position >= 1)
  ),
  source_byte_offset bigint NOT NULL CHECK (source_byte_offset >= 0),
  source_byte_length bigint NOT NULL CHECK (source_byte_length > 0),
  event_timestamp timestamptz,
  outer_type text NOT NULL CHECK (outer_type <> ''),
  payload_type text,
  explicit_turn_id text,
  item_id text,
  call_id text,
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_id, position_kind, source_position)
);

CREATE INDEX IF NOT EXISTS transcripts_root_session_id_idx
  ON public.transcripts (root_session_id);
CREATE INDEX IF NOT EXISTS transcript_events_event_timestamp_idx
  ON public.transcript_events (event_timestamp);

REVOKE ALL ON TABLE public.transcripts, public.transcript_events FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO transcript_reader, transcript_writer;
GRANT SELECT ON TABLE public.transcripts, public.transcript_events TO transcript_reader;
GRANT INSERT ON TABLE public.transcripts TO transcript_writer;
GRANT SELECT (
  transcript_id,
  root_session_id,
  parent_thread_id,
  path_hash,
  file_identity_hash,
  position_kind,
  observed_size,
  observed_mtime,
  next_byte_offset,
  next_line_no,
  last_ordinal,
  last_event_byte_offset,
  last_event_byte_length,
  last_event_sha256,
  event_chain_sha256,
  projection_chain_sha256,
  event_count,
  projection_version,
  redaction_version,
  last_event_at
) ON TABLE public.transcripts TO transcript_writer;
GRANT UPDATE (
  observed_size,
  observed_mtime,
  next_byte_offset,
  next_line_no,
  last_ordinal,
  last_event_byte_offset,
  last_event_byte_length,
  last_event_sha256,
  event_chain_sha256,
  projection_chain_sha256,
  event_count,
  last_event_at,
  updated_at,
  last_synced_at
) ON TABLE public.transcripts TO transcript_writer;
GRANT INSERT ON TABLE public.transcript_events TO transcript_writer;
GRANT SELECT (
  transcript_id,
  position_kind,
  source_position,
  event_sha256,
  projection_sha256
) ON TABLE public.transcript_events TO transcript_writer;

COMMIT;
