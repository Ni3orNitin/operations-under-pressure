CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL, token text UNIQUE NOT NULL, password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (
 user_id text REFERENCES users(id), team_id text REFERENCES teams(id), role text NOT NULL CHECK (role IN ('Viewer','Member','Lead','Admin')),
 PRIMARY KEY(user_id,team_id)
);
CREATE TABLE IF NOT EXISTS work_items (
 id text PRIMARY KEY, title text NOT NULL, description text NOT NULL DEFAULT '', type text NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
 priority text NOT NULL CHECK(priority IN ('low','normal','high','urgent')), status text NOT NULL CHECK(status IN ('open','in_progress','awaiting_approval','resolved','closed')),
 team_id text NOT NULL REFERENCES teams(id), assignee_id text REFERENCES users(id), created_by text NOT NULL REFERENCES users(id), due_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_team_created_idx ON work_items(team_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_team_status_priority_idx ON work_items(team_id,status,priority);
CREATE INDEX IF NOT EXISTS items_assignee_team_idx ON work_items(team_id,assignee_id,status);
CREATE INDEX IF NOT EXISTS items_search_idx ON work_items USING gin(to_tsvector('english', title || ' ' || description));
CREATE TABLE IF NOT EXISTS activity_events (
 id bigserial PRIMARY KEY, item_id text NOT NULL REFERENCES work_items(id), actor_id text NOT NULL REFERENCES users(id), kind text NOT NULL,
 body text NOT NULL DEFAULT '', changes jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_item_idx ON activity_events(item_id,id DESC);
CREATE OR REPLACE FUNCTION prevent_activity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'activity_events are append-only'; END $$;
DROP TRIGGER IF EXISTS activity_no_update ON activity_events;
CREATE TRIGGER activity_no_update BEFORE UPDATE OR DELETE ON activity_events FOR EACH ROW EXECUTE FUNCTION prevent_activity_mutation();
CREATE TABLE IF NOT EXISTS idempotency_keys (
 actor_id text NOT NULL REFERENCES users(id), key text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,key)
);
CREATE TABLE IF NOT EXISTS outbox_jobs (
 id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, failed_at timestamptz, available_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_jobs(available_at,id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_deliveries (job_id bigint PRIMARY KEY REFERENCES outbox_jobs(id), delivered_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL);
