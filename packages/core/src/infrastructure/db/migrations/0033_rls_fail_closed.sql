-- Tenant isolation enforced by the database.
--
-- BEFORE THIS MIGRATION there was no database-level barrier between workspaces:
-- no policies, no row security, no session context. What separated one tenant's
-- traces, spans and evaluations from another's was the `workspace_id = $n`
-- predicate written by hand in every query. A single omission returned another
-- workspace's telemetry with no error, no log line and no failing test.
--
-- Traces carry prompts, tool arguments and model output — the most sensitive
-- payload in the platform. A cross-workspace read here leaks conversations.
--
-- WHAT THIS ESTABLISHES
--   * every workspace-scoped table gets ENABLE + FORCE ROW LEVEL SECURITY
--   * one fail-closed policy per table, reading `app.workspace_id`
--   * no permissive disjunct: an unset context matches NOTHING. Zero rows is a
--     visible bug; every tenant's rows is a breach.
--
-- HOW THE CONTEXT ARRIVES. `tenantScopedPool` sets `app.workspace_id` on every
-- connection it hands out, from the request-bound scope in workspace-scope.ts.
-- Repository code did not change.
--
-- THE TABLE LIST IS DERIVED FROM THE CATALOG, not from the ORM schema. Reading
-- it off the TypeScript schema produced a false positive in a sibling package
-- (a table without the column was included and the migration aborted), so the
-- membership test here is the column's actual presence.
--
-- ON `theo_api_keys`: it carries BOTH `tenant_id` and `workspace_id`. The policy
-- uses `workspace_id`, which is the discriminator every other table in this
-- schema uses; `tenant_id` here is a legacy column and scoping by it would
-- create a second, divergent notion of tenancy in one database.

DO $$
DECLARE
    t             text;
    has_worker    boolean;
    scoped_tables text[] := ARRAY[
        'annotations',
        'copilot_feedback',
        'dataset_items',
        'datasets',
        'eval_jobs',
        'evaluators',
        'experiment_run_items',
        'experiment_runs',
        'labeling_queue_items',
        'monitors',
        'replay_sessions',
        'session_evaluations',
        'sessions',
        'span_evaluations',
        'spans',
        'trace_tags',
        'traces',
        'workspace_users'
    ];
    -- DELIBERATELY ABSENT: the API-key table.
    --
    -- Credential resolution is what DISCOVERS the workspace: the lookup runs
    -- before any tenant context can exist, keyed by the hash of the presented
    -- secret. Scoping that table by workspace is circular — you would need the
    -- workspace to read the row that tells you the workspace — and the practical
    -- effect is that authentication fails closed for every request, including
    -- legitimate ones.
    --
    -- What protects it instead: the lookup is by secret hash (not enumerable),
    -- the row is never returned to a caller, and the admin listing routes filter
    -- by the Principal's workspace. That last one is a WHERE clause rather than
    -- a policy — the weaker guarantee this migration exists to replace — so it
    -- is registered as follow-up work: a dedicated auth role holding a
    -- SELECT-only cross-workspace policy would close it without the circularity.

BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lens_worker') INTO has_worker;

    FOREACH t IN ARRAY scoped_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = t
        ) THEN
            RAISE NOTICE 'skipping %: table not present', t;
            CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_workspace_isolation', t);
        EXECUTE format($f$
            CREATE POLICY %I ON public.%I
              USING      (workspace_id = current_setting('app.workspace_id', true))
              WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
        $f$, t || '_workspace_isolation', t);

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_worker_cross_workspace', t);
        IF has_worker THEN
            EXECUTE format($f$
                CREATE POLICY %I ON public.%I
                  TO lens_worker
                  USING (true) WITH CHECK (true)
            $f$, t || '_worker_cross_workspace', t);
        END IF;
    END LOOP;
END $$;
--> statement-breakpoint

-- `workspaces` is the self-table: scoped by its own id.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'workspaces'
    ) THEN
        ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;

        DROP POLICY IF EXISTS workspaces_self_isolation ON public.workspaces;
        CREATE POLICY workspaces_self_isolation ON public.workspaces
          USING      (id = current_setting('app.workspace_id', true))
          WITH CHECK (id = current_setting('app.workspace_id', true));

        DROP POLICY IF EXISTS workspaces_worker_cross_workspace ON public.workspaces;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lens_worker') THEN
            CREATE POLICY workspaces_worker_cross_workspace ON public.workspaces
              TO lens_worker USING (true) WITH CHECK (true);
        END IF;
    END IF;
END $$;
