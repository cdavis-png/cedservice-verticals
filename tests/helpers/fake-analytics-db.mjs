/* In-memory stand-in for the analytics half of the schema. Mirrors
   supabase/migrations/0005_assessment_analytics.sql step for step.

   Like fake-db.mjs, this proves the CONTRACT, not the SQL: it enforces the
   constraints ingestion can actually violate — the append-only rule, the
   forward-only roll-up, the timing sanity checks, and idempotency — so a
   double that only mirrors the happy path cannot hide a constraint bug. The
   PL/pgSQL itself needs a live Postgres; see docs/REAL_POSTGRES_VALIDATION.md
   section M. */

import { randomUUID } from 'node:crypto';

const clone = v => JSON.parse(JSON.stringify(v));

class ConstraintViolation extends Error {}

export function createFakeAnalyticsDb(options = {}) {
  const { now = () => new Date('2026-08-05T12:00:00.000Z'), failAt = null } = options;

  const state = {
    assessment_analytics_events: [],
    assessment_analytics_sessions: [],
    assessment_funnel_daily: [],
    rate_limit_buckets: []
  };

  const snapshot = () => clone(state);
  const restore = snap => Object.keys(state).forEach(k => { state[k] = snap[k]; });

  /* ---------- constraints ---------- */

  const checkEventRow = row => {
    if (row.assessment_stage !== null && ![1, 2].includes(row.assessment_stage)) {
      throw new ConstraintViolation('analytics_events_stage_check');
    }
    /* 1 as shipped in 0005, widened to 2 by 0006 when the envelope gained
       reviewType. A fake still pinned at 1 would have refused every
       post-SM-1 batch — which is exactly the defect real-Postgres validation
       found in the migration itself. */
    if (row.schema_version < 1 || row.schema_version > 2) {
      throw new ConstraintViolation('analytics_events_schema_version_check');
    }
    if (Date.parse(row.received_at) < Date.parse(row.occurred_at)) {
      throw new ConstraintViolation('analytics_events_recorded_after_occurred');
    }
    if (row.active_elapsed_ms < 0 || row.total_elapsed_ms < 0 ||
        (row.step_elapsed_ms !== null && row.step_elapsed_ms < 0) ||
        row.active_elapsed_ms > row.total_elapsed_ms) {
      throw new ConstraintViolation('analytics_events_timing_sane');
    }
    if (Date.parse(row.expires_at) <= Date.parse(row.received_at)) {
      throw new ConstraintViolation('analytics_events_expiry_future');
    }
  };

  const checkSessionRow = row => {
    const states = ['in_progress', 'preliminary_results', 'fit_review_available',
      'fit_review_complete', 'activation_ready', 'abandoned'];
    if (!states.includes(row.result_state)) {
      throw new ConstraintViolation('analytics_sessions_result_state_check');
    }
    /* The constraint the first version of this double did not model, and the
       reason a real defect reached Postgres: a roll-up that coerced two nulls
       to 0 produced max_stage_reached = 0, which is neither null nor 1 nor 2. */
    if (row.max_stage_reached !== null && row.max_stage_reached !== undefined &&
        ![1, 2].includes(row.max_stage_reached)) {
      throw new ConstraintViolation('analytics_sessions_stage_check');
    }
    if (row.total_active_ms > row.total_elapsed_ms) {
      throw new ConstraintViolation('analytics_sessions_counts_sane');
    }
  };

  /* Postgres GREATEST skips nulls: greatest(null, null) is null and
     greatest(null, 2) is 2. Math.max does not — Math.max(null, null) is 0 —
     which is exactly how the defect got past this double. */
  const greatest = (a, b) => {
    if (a === null || a === undefined) return b ?? null;
    if (b === null || b === undefined) return a;
    return Math.max(a, b);
  };

  /* ---------- check_rate_limit (same shape as fake-db) ---------- */

  const checkRateLimit = ({ p_keys, p_window_seconds, p_max_requests }) => {
    const windowSeconds = p_window_seconds > 0 ? p_window_seconds : 900;
    const maxRequests = p_max_requests > 0 ? p_max_requests : 120;
    const epoch = Math.floor(now().getTime() / 1000);
    const windowStart = Math.floor(epoch / windowSeconds) * windowSeconds;

    let worst = 0;
    let worstScope = null;
    (p_keys || []).forEach(entry => {
      if (!entry || !entry.scope || !entry.key) return;
      let bucket = state.rate_limit_buckets.find(b =>
        b.scope === entry.scope && b.bucket_key === entry.key && b.window_start === windowStart);
      if (!bucket) {
        bucket = { scope: entry.scope, bucket_key: entry.key, window_start: windowStart, request_count: 0 };
        state.rate_limit_buckets.push(bucket);
      }
      bucket.request_count += 1;
      if (bucket.request_count > worst) { worst = bucket.request_count; worstScope = entry.scope; }
    });

    if (worst > maxRequests) {
      return { allowed: false, scope: worstScope, limit: maxRequests, count: worst,
               retryAfterSeconds: Math.max(1, (windowStart + windowSeconds) - epoch) };
    }
    return { allowed: true, scope: worstScope, limit: maxRequests, count: worst };
  };

  /* ---------- ingest_analytics_events ---------- */

  const ingest = ({ p_events: eventsIn, p_meta: meta = {}, p_retention_days: retention = 400 }) => {
    if (!Array.isArray(eventsIn) || eventsIn.length === 0) {
      throw new Error('analytics_empty_batch');
    }
    const sessions = [...new Set(eventsIn.map(e => e.assessmentSessionId))];
    if (sessions.length !== 1) throw new Error('analytics_mixed_sessions');
    const sessionId = sessions[0];

    const at = now();
    const nowIso = at.toISOString();
    const expiresAt = new Date(at.getTime() + retention * 86400000).toISOString();

    const accepted = [];
    const duplicates = [];

    eventsIn.forEach(event => {
      if (state.assessment_analytics_events.some(r => r.event_id === event.eventId)) {
        duplicates.push(event.eventId);
        return;
      }
      /* Clamped in the database too, not only at the endpoint. */
      const occurred = new Date(
        Math.min(Date.parse(event.occurredAt), at.getTime())).toISOString();

      const row = {
        event_id: event.eventId,
        event_name: event.eventName,
        event_version: event.eventVersion ?? 1,
        schema_version: event.schemaVersion ?? 1,
        assessment_session_id: event.assessmentSessionId,
        submission_id: event.submissionId ?? null,
        business_id: event.businessId ?? null,
        vertical_id: event.verticalId,
        assessment_version: event.assessmentVersion ?? null,
        question_set_version: event.questionSetVersion ?? null,
        assessment_stage: event.assessmentStage ?? null,
        /* 0006 added review_type, resolved from the event NAME first so a
           service_mix.* event can never be filed under the Growth funnel by a
           misconfigured page. Mirrored here so a test can inspect the complete
           stored row rather than most of it. */
        review_type: event.eventName && event.eventName.startsWith('service_mix.')
          ? 'service_mix'
          : (event.reviewType === 'service_mix' ? 'service_mix' : 'growth_review'),
        step_id: event.stepId ?? null,
        question_id: event.questionId ?? null,
        occurred_at: occurred,
        received_at: nowIso,
        active_elapsed_ms: event.activeElapsedMs ?? 0,
        total_elapsed_ms: event.totalElapsedMs ?? 0,
        step_elapsed_ms: event.stepElapsedMs ?? null,
        visible_question_count: event.visibleQuestionCount ?? null,
        completed_question_count: event.completedQuestionCount ?? null,
        attribution: event.attribution ?? {},
        device: event.device ?? {},
        metadata: event.metadata ?? {},
        expires_at: expiresAt
      };
      checkEventRow(row);
      state.assessment_analytics_events.push(row);
      accepted.push(event.eventId);
    });

    if (failAt === 'events') throw new Error('injected_failure_at_events');

    /* Roll-up recomputed from what is STORED, which is what makes a late or
       out-of-order event correct itself rather than double-count. */
    const rows = state.assessment_analytics_events
      .filter(r => r.assessment_session_id === sessionId)
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

    const has = name => rows.filter(r => r.event_name === name);
    const firstAt = name => (has(name)[0] ? has(name)[0].occurred_at : null);
    const stepNumber = id => {
      const digits = String(id || '').replace(/\D/g, '');
      return digits === '' ? null : Number(digits);
    };

    const resultState =
      has('assessment.stage2_completed').length ? 'fit_review_complete'
      : has('assessment.stage2_started').length ? 'fit_review_available'
      : has('assessment.stage1_completed').length ? 'preliminary_results'
      : has('assessment.abandoned').length ? 'abandoned'
      : 'in_progress';

    const withStep = rows.filter(r => r.step_id !== null);
    const computed = {
      assessment_session_id: sessionId,
      business_id: rows.map(r => r.business_id).filter(Boolean).pop() ?? null,
      vertical_id: rows[0].vertical_id,
      assessment_version: rows.map(r => r.assessment_version).filter(Boolean).pop() ?? null,
      question_set_version: rows.map(r => r.question_set_version).filter(Boolean).pop() ?? null,
      started_at: rows[0].occurred_at,
      last_event_at: rows[rows.length - 1].occurred_at,
      stage1_completed_at: firstAt('assessment.stage1_completed'),
      stage2_started_at: firstAt('assessment.stage2_started'),
      stage2_completed_at: firstAt('assessment.stage2_completed'),
      latest_step_id: withStep.length ? withStep[withStep.length - 1].step_id : null,
      max_step_reached: withStep.reduce((max, r) => {
        const n = stepNumber(r.step_id);
        return n === null ? max : Math.max(max ?? 0, n);
      }, null),
      max_stage_reached: rows.reduce((max, r) =>
        r.assessment_stage === null ? max : Math.max(max ?? 0, r.assessment_stage), null),
      result_state: resultState,
      resumed_count: has('assessment.resumed').length,
      validation_failures: has('assessment.validation_failed').length,
      question_interactions: has('assessment.question_answered').length,
      event_count: rows.length,
      total_active_ms: Math.max(...rows.map(r => r.active_elapsed_ms)),
      total_elapsed_ms: Math.max(...rows.map(r => r.total_elapsed_ms)),
      first_touch: rows.map(r => r.attribution?.firstTouch).find(Boolean) ?? {},
      latest_touch: rows.map(r => r.attribution?.latestTouch).filter(Boolean).pop() ?? {},
      device: rows[rows.length - 1].device ?? {},
      expires_at: expiresAt
    };

    const existing = state.assessment_analytics_sessions
      .find(s => s.assessment_session_id === sessionId);

    if (!existing) {
      const row = { ...computed, created_at: nowIso, updated_at: nowIso, abandoned_at: null };
      checkSessionRow(row);
      state.assessment_analytics_sessions.push(row);
    } else {
      /* Forward only, exactly as the ON CONFLICT clause in the migration. */
      const earlier = (a, b) => (Date.parse(a) <= Date.parse(b) ? a : b);
      const later = (a, b) => (Date.parse(a) >= Date.parse(b) ? a : b);
      Object.assign(existing, {
        business_id: computed.business_id ?? existing.business_id,
        assessment_version: computed.assessment_version ?? existing.assessment_version,
        question_set_version: computed.question_set_version ?? existing.question_set_version,
        started_at: earlier(existing.started_at, computed.started_at),
        last_event_at: later(existing.last_event_at, computed.last_event_at),
        stage1_completed_at: existing.stage1_completed_at ?? computed.stage1_completed_at,
        stage2_started_at: existing.stage2_started_at ?? computed.stage2_started_at,
        stage2_completed_at: existing.stage2_completed_at ?? computed.stage2_completed_at,
        latest_step_id: computed.latest_step_id ?? existing.latest_step_id,
        max_step_reached: greatest(existing.max_step_reached, computed.max_step_reached),
        max_stage_reached: greatest(existing.max_stage_reached, computed.max_stage_reached),
        result_state: computed.result_state,
        resumed_count: computed.resumed_count,
        validation_failures: computed.validation_failures,
        question_interactions: computed.question_interactions,
        event_count: computed.event_count,
        total_active_ms: Math.max(existing.total_active_ms, computed.total_active_ms),
        total_elapsed_ms: Math.max(existing.total_elapsed_ms, computed.total_elapsed_ms),
        first_touch: Object.keys(existing.first_touch || {}).length ? existing.first_touch : computed.first_touch,
        latest_touch: computed.latest_touch,
        device: computed.device,
        expires_at: later(existing.expires_at, computed.expires_at),
        updated_at: nowIso
      });
      checkSessionRow(existing);
    }

    /* A session that produced an abandonment event and later continued is not
       abandoned. Retracted here, because the client cannot know the future at
       the moment it guesses. */
    const session = state.assessment_analytics_sessions
      .find(s => s.assessment_session_id === sessionId);
    session.abandoned_at = session.result_state === 'abandoned' ? session.last_event_at : null;

    return {
      ok: true,
      sessionId,
      accepted,
      duplicates,
      receivedAt: nowIso,
      correlationId: meta.correlationId ?? null
    };
  };

  /* ---------- refresh_assessment_funnel_daily ---------- */

  const refreshFunnel = ({ p_from, p_to } = {}) => {
    const from = p_from ? Date.parse(p_from) : -Infinity;
    const to = p_to ? Date.parse(p_to) + 86400000 : Infinity;

    const groups = new Map();
    state.assessment_analytics_events.forEach(e => {
      const day = e.occurred_at.slice(0, 10);
      const t = Date.parse(day);
      if (t < from || t >= to) return;
      const key = [day, e.vertical_id, e.assessment_version || 'unknown',
        e.question_set_version || 'unknown',
        e.attribution?.firstTouch?.utm?.utm_source || '(none)',
        e.device?.deviceClass || 'unknown'].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });

    const median = values => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    };

    let rows = 0;
    groups.forEach((rowsIn, key) => {
      const [aggregate_date, vertical_id, assessment_version, question_set_version, source, device_class] =
        key.split('|');
      const sessionsWith = name =>
        new Set(rowsIn.filter(e => e.event_name === name).map(e => e.assessment_session_id)).size;
      const countOf = name => rowsIn.filter(e => e.event_name === name).length;

      const record = {
        aggregate_date, vertical_id, assessment_version, question_set_version, source, device_class,
        page_views: sessionsWith('assessment.page_viewed'),
        starts: sessionsWith('assessment.started'),
        resumes: sessionsWith('assessment.resumed'),
        stage1_completions: sessionsWith('assessment.stage1_completed'),
        preliminary_result_views: sessionsWith('assessment.preliminary_results_viewed'),
        stage2_starts: sessionsWith('assessment.stage2_started'),
        stage2_completions: sessionsWith('assessment.stage2_completed'),
        full_result_views: sessionsWith('assessment.full_results_viewed'),
        personal_review_clicks: countOf('assessment.personal_review_clicked'),
        recommended_system_clicks: countOf('assessment.recommended_system_clicked'),
        improve_recommendation_clicks: countOf('assessment.improve_recommendation_clicked'),
        checkout_intents: countOf('assessment.checkout_intent'),
        report_requests: countOf('assessment.report_requested'),
        validation_failures: countOf('assessment.validation_failed'),
        question_interactions: countOf('assessment.question_answered'),
        /* Per session, the largest question count its path reported, summed
           across the group. NOT a sum over events, which would count each
           question once per step view. */
        visible_question_total: [...new Set(rowsIn.map(e => e.assessment_session_id))]
          .reduce((sum, sid) => {
            const counts = rowsIn
              .filter(e => e.assessment_session_id === sid && e.visible_question_count !== null)
              .map(e => e.visible_question_count);
            return sum + (counts.length ? Math.max(...counts) : 0);
          }, 0),
        abandonment_count: sessionsWith('assessment.abandoned'),
        median_stage1_active_ms: median(rowsIn
          .filter(e => e.event_name === 'assessment.stage1_completed')
          .map(e => e.active_elapsed_ms)),
        median_stage2_active_ms: median(rowsIn
          .filter(e => e.event_name === 'assessment.stage2_completed')
          .map(e => e.active_elapsed_ms)),
        computed_at: now().toISOString()
      };

      const index = state.assessment_funnel_daily.findIndex(r =>
        r.aggregate_date === aggregate_date && r.vertical_id === vertical_id &&
        r.assessment_version === assessment_version &&
        r.question_set_version === question_set_version &&
        r.source === source && r.device_class === device_class);
      /* Re-running a date range REPLACES rather than accumulates. */
      if (index >= 0) state.assessment_funnel_daily[index] = record;
      else state.assessment_funnel_daily.push(record);
      rows++;
    });
    return rows;
  };

  /* ---------- purges ---------- */

  const purgeEvents = ({ p_now, p_limit = 50000 } = {}) => {
    const cutoff = Date.parse(p_now || now().toISOString());
    const doomed = state.assessment_analytics_events
      .filter(r => Date.parse(r.expires_at) < cutoff).slice(0, p_limit);
    const ids = new Set(doomed.map(r => r.event_id));
    state.assessment_analytics_events =
      state.assessment_analytics_events.filter(r => !ids.has(r.event_id));
    return doomed.length;
  };

  const purgeSessions = ({ p_now, p_limit = 10000 } = {}) => {
    const cutoff = Date.parse(p_now || now().toISOString());
    const doomed = state.assessment_analytics_sessions
      .filter(r => Date.parse(r.expires_at) < cutoff).slice(0, p_limit);
    const ids = new Set(doomed.map(r => r.assessment_session_id));
    state.assessment_analytics_sessions =
      state.assessment_analytics_sessions.filter(r => !ids.has(r.assessment_session_id));
    return doomed.length;
  };

  const HANDLERS = {
    ingest_analytics_events: ingest,
    check_rate_limit: checkRateLimit,
    refresh_assessment_funnel_daily: refreshFunnel,
    purge_expired_analytics_events: purgeEvents,
    purge_expired_analytics_sessions: purgeSessions
  };

  return {
    state,
    async rpc(name, args) {
      const handler = HANDLERS[name];
      if (!handler) return { data: null, error: { message: `unknown function ${name}` } };
      const before = snapshot();
      try {
        return { data: handler(args), error: null };
      } catch (err) {
        restore(before);          /* one call = one transaction */
        return { data: null, error: { message: err.message } };
      }
    },
    /* Convenience for tests that need a session row without going through
       the endpoint. */
    seedEvent(overrides = {}) {
      return {
        eventId: randomUUID(),
        eventName: 'assessment.page_viewed',
        eventVersion: 1,
        schemaVersion: 1,
        assessmentSessionId: randomUUID(),
        verticalId: 'nails',
        occurredAt: now().toISOString(),
        activeElapsedMs: 0,
        totalElapsedMs: 0,
        attribution: {},
        device: { deviceClass: 'phone' },
        metadata: {},
        ...overrides
      };
    }
  };
}
