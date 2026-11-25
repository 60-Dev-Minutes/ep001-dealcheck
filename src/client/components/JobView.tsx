import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { InvestigationStatus, JobState, ReportSnapshot } from '../../shared/types';
import { TERMINAL_STATES } from '../../shared/types';
import { ApiFailure, cancelInvestigation, clarifyInvestigation, getInvestigation, getReport, isAbort } from '../api';
import { formatLocalDateTime, formatLocalTime } from '../util';
import { Report } from './Report';

const POLL_START_MS = 1000;
const POLL_FACTOR = 1.5;
const POLL_CAP_MS = 8000;

const STEPS = [
  { key: 'identifying', label: 'Identifying' },
  { key: 'researching', label: 'Researching' },
  { key: 'validating', label: 'Validating' },
  { key: 'report', label: 'Report' },
] as const;

function stepIndex(state: JobState): number {
  switch (state) {
    case 'queued':
    case 'identifying':
    case 'awaiting_clarification':
      return 0;
    case 'researching':
      return 1;
    case 'validating':
      return 2;
    default:
      return 3;
  }
}

interface Props {
  jobId: string;
  /** Leave this job and return to an empty-ish form. */
  onRestart: () => void;
  /** The job no longer exists for this browser session. */
  onGone: () => void;
  /** Called once when the job reaches a terminal state. */
  onSettled: () => void;
}

export function JobView({ jobId, onRestart, onGone, onSettled }: Props) {
  const [status, setStatus] = useState<InvestigationStatus | null>(null);
  const [connectionTrouble, setConnectionTrouble] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const settledRef = useRef(false);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  const terminal = status ? TERMINAL_STATES.includes(status.state) : false;

  // Poll with exponential backoff until a terminal state. Backoff restarts at 1 s whenever the state changes.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_START_MS;
    let lastState: JobState | null = null;
    let failures = 0;

    const tick = async () => {
      try {
        const s = await getInvestigation(jobId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        failures = 0;
        setConnectionTrouble(false);
        setStatus(s);
        if (TERMINAL_STATES.includes(s.state)) return;
        if (s.state !== lastState) {
          lastState = s.state;
          delay = POLL_START_MS;
        } else {
          delay = Math.min(delay * POLL_FACTOR, POLL_CAP_MS);
        }
      } catch (e) {
        if (isAbort(e) || ctrl.signal.aborted) return;
        if (e instanceof ApiFailure && e.status === 404) {
          onGoneRef.current();
          return;
        }
        failures += 1;
        if (failures >= 2) setConnectionTrouble(true);
        delay = Math.min(delay * POLL_FACTOR, POLL_CAP_MS);
      }
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, pollNonce]);

  useEffect(() => {
    if (terminal && !settledRef.current) {
      settledRef.current = true;
      onSettled();
    }
  }, [terminal, onSettled]);

  async function cancel() {
    setCancelling(true);
    setActionError(null);
    try {
      const s = await cancelInvestigation(jobId);
      setStatus(s);
      if (!TERMINAL_STATES.includes(s.state)) setPollNonce((n) => n + 1);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) onGone();
      else setActionError(e instanceof ApiFailure ? e.error.message : 'Could not cancel. Please try again.');
    } finally {
      setCancelling(false);
    }
  }

  if (!status) {
    return (
      <section className="stack" aria-labelledby="job-title" aria-busy="true">
        <h1 id="job-title" tabIndex={-1}>
          Checking the price history
        </h1>
        <div className="card">
          <p role="status">{connectionTrouble ? 'Having trouble reaching DealCheck. Still trying…' : 'Connecting to your check…'}</p>
        </div>
      </section>
    );
  }

  if (status.state === 'complete' && status.report_id) {
    return <ReportLoader reportId={status.report_id} onRestart={onRestart} />;
  }

  if (status.state === 'failed' || status.state === 'complete') {
    return (
      <section className="stack" aria-labelledby="job-title">
        <h1 id="job-title" tabIndex={-1}>
          The check could not be completed
        </h1>
        <div className="alert alert-error" role="alert">
          <p className="alert-title">Technical failure</p>
          <p>{status.error?.message ?? 'A technical problem stopped this investigation. Your allowance was not used.'}</p>
        </div>
        <ProductEcho status={status} />
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onRestart}>
            Start again
          </button>
        </div>
      </section>
    );
  }

  if (status.state === 'cancelled') {
    return (
      <section className="stack" aria-labelledby="job-title">
        <h1 id="job-title" tabIndex={-1}>
          Check cancelled
        </h1>
        <div className="alert alert-info" role="status">
          <p>Cancelled. Your allowance was not used.</p>
        </div>
        <ProductEcho status={status} />
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onRestart}>
            Start a new check
          </button>
        </div>
      </section>
    );
  }

  const current = stepIndex(status.state);
  const awaiting = status.state === 'awaiting_clarification' && status.clarification;

  return (
    <section className="stack" aria-labelledby="job-title">
      <h1 id="job-title" tabIndex={-1}>
        {awaiting ? 'Which product exactly?' : 'Checking the price history'}
      </h1>
      <ProductEcho status={status} />

      <div className="card progress">
        <ol className="steps" aria-label="Progress">
          {STEPS.map((step, i) => {
            const state = i < current ? 'done' : i === current ? 'current' : 'todo';
            return (
              <li key={step.key} className={`step step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="step-marker" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className="step-label">{step.label}</span>
                <span className="visually-hidden">{state === 'done' ? ' (done)' : state === 'current' ? ' (in progress)' : ' (not started)'}</span>
              </li>
            );
          })}
        </ol>
        <p className="stage-label" aria-live="polite" aria-atomic="true">
          {status.stage_label}
          {!awaiting && <span className="spinner" aria-hidden="true" />}
        </p>
        <p className="hint">
          Started at {formatLocalTime(status.created_at)}. Research can take a few minutes; you can leave this page open or come back to it in this
          browser.
        </p>
        {connectionTrouble && (
          <p className="field-error" role="status">
            Having trouble reaching DealCheck. Still trying…
          </p>
        )}
      </div>

      {awaiting && status.clarification && (
        <Clarify
          jobId={jobId}
          status={status}
          onUpdated={(s) => {
            setStatus(s);
            setPollNonce((n) => n + 1);
          }}
          onGone={onGone}
        />
      )}

      {actionError && (
        <div className="alert alert-error" role="alert">
          <p>{actionError}</p>
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={() => void cancel()} disabled={cancelling}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </section>
  );
}

function ProductEcho({ status }: { status: InvestigationStatus }) {
  return (
    <p className="echo">
      <span className="echo-label">Checking</span> <span className="echo-value">{status.product_input}</span>{' '}
      <span className="echo-market">in {status.market}</span>
    </p>
  );
}

function Clarify({
  jobId,
  status,
  onUpdated,
  onGone,
}: {
  jobId: string;
  status: InvestigationStatus;
  onUpdated: (s: InvestigationStatus) => void;
  onGone: () => void;
}) {
  const clar = status.clarification!;
  const [choice, setChoice] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const errId = useId();
  const expiresAt = Date.parse(clar.expires_at);
  const expired = Number.isFinite(expiresAt) && expiresAt < Date.now();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice) {
      setError('Choose one of the options to continue.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      onUpdated(await clarifyInvestigation(jobId, choice));
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 404) onGone();
      else setError(err instanceof ApiFailure ? err.error.message : 'Could not send your choice. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="card clarify" onSubmit={submit} noValidate>
      <div className="alert alert-warn">
        <p className="alert-title">Ambiguous variant</p>
        <p>We found more than one matching product. Pick the exact one so we compare like with like.</p>
      </div>
      <fieldset aria-describedby={error ? errId : undefined}>
        <legend>{clar.question}</legend>
        <div className="radio-list">
          {clar.candidates.map((c) => (
            <label key={c.id} className="radio">
              <input type="radio" name={name} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} />
              <span>
                <span className="radio-label">{c.label}</span>
                {c.detail && <span className="radio-detail">{c.detail}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="hint">
        {expired ? 'The time to choose has passed.' : `Please choose by ${formatLocalDateTime(clar.expires_at)} (your local time).`}
      </p>
      {error && (
        <p id={errId} className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={sending || expired}>
          {sending ? 'Sending…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}

function ReportLoader({ reportId, onRestart }: { reportId: string; onRestart: () => void }) {
  const [report, setReport] = useState<ReportSnapshot | null>(null);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    getReport(reportId, ctrl.signal)
      .then(setReport)
      .catch((e: unknown) => {
        if (isAbort(e)) return;
        if (e instanceof ApiFailure && e.status === 404) setError({ message: 'This report is no longer available in this browser session.', retry: false });
        else setError({ message: e instanceof ApiFailure ? e.error.message : 'Could not load the report.', retry: true });
      });
    return () => ctrl.abort();
  }, [reportId, nonce]);

  if (report) return <Report snapshot={report} onNewCheck={onRestart} />;

  return (
    <section className="stack" aria-labelledby="job-title">
      <h1 id="job-title" tabIndex={-1}>
        Your report
      </h1>
      {error ? (
        <div className="alert alert-error" role="alert">
          <p className="alert-title">Technical problem</p>
          <p>{error.message}</p>
          <div className="actions">
            {error.retry && (
              <button type="button" className="btn btn-secondary" onClick={() => setNonce((n) => n + 1)}>
                Retry
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={onRestart}>
              Start again
            </button>
          </div>
        </div>
      ) : (
        <div className="card" aria-busy="true">
          <p role="status">Loading your report…</p>
        </div>
      )}
    </section>
  );
}
