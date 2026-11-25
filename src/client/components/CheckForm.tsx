import { useId, useRef, useState, type FormEvent } from 'react';
import { marketByCode } from '../../shared/markets';
import { parseUserPrice } from '../../shared/money';
import type { MarketInfo, QuotaInfo } from '../../shared/types';
import { ApiFailure, createInvestigation } from '../api';
import { useTurnstile } from '../turnstile';
import { randomKey, storage, STORAGE_SUBSCRIBE, SUBSCRIBE_URL } from '../util';

export type QuotaState = { status: 'loading' } | { status: 'error' } | { status: 'ok'; info: QuotaInfo };

export interface FormValues {
  product: string;
  price: string;
  retailer: string;
}

export const EMPTY_VALUES: FormValues = { product: '', price: '', retailer: '' };

const MAX_PRODUCT_TEXT = 512;
const MAX_PRODUCT_URL = 2048;
const MAX_RETAILER = 100;

const PAUSED_MESSAGES = {
  disabled: 'Research is paused right now — the pilot is not yet accepting new checks.',
  budget: "Today's research budget has been reached. Try again after midnight New Zealand time.",
} as const;

type FieldErrors = Partial<Record<keyof FormValues, string>>;

type SubmitError =
  | { kind: 'invalid'; message: string }
  | { kind: 'quota'; message: string }
  | { kind: 'busy'; message: string }
  | { kind: 'turnstile'; message: string }
  | { kind: 'technical'; message: string };

interface Props {
  markets: MarketInfo[];
  market: string;
  onMarketChange: (code: string) => void;
  quota: QuotaState;
  values: FormValues;
  onValuesChange: (v: FormValues) => void;
  onCreated: (jobId: string) => void;
  notice: string | null;
}

/** Mirrors the Worker's product rules so obvious mistakes are caught before a request. */
function validateProduct(raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Enter a product name, model number, barcode or product link.';
  const looksLikeLink = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d/.test(s);
  if (looksLikeLink) {
    if (s.length > MAX_PRODUCT_URL) return `Links can be at most ${MAX_PRODUCT_URL} characters.`;
    if (!/^https?:\/\//i.test(s)) return 'That looks like a link. Only http:// or https:// product links are accepted.';
    try {
      new URL(s);
    } catch {
      return 'That link is not a valid web address.';
    }
    return null;
  }
  if (s.length > MAX_PRODUCT_TEXT) return `Product text can be at most ${MAX_PRODUCT_TEXT} characters (you entered ${s.length}). Shorten it or paste a product link instead.`;
  return null;
}

export function CheckForm({ markets, market, onMarketChange, quota, values, onValuesChange, onCreated, notice }: Props) {
  const ids = {
    market: useId(),
    marketHint: useId(),
    product: useId(),
    productHint: useId(),
    productErr: useId(),
    price: useId(),
    priceHint: useId(),
    priceErr: useId(),
    retailer: useId(),
    retailerErr: useId(),
    quota: useId(),
  };
  const productRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const retailerRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pausedByServer, setPausedByServer] = useState<string | null>(null);
  const [exhaustedByServer, setExhaustedByServer] = useState(false);
  // Owner decision (2026-11-25): the first check requires clicking Subscribe. Not verified — a click
  // opens the newsletter's subscribe page in a new tab and unlocks checks in this browser.
  const [subscribeClicked, setSubscribeClicked] = useState(() => storage.get(STORAGE_SUBSCRIBE) !== null);
  const [justUnlocked, setJustUnlocked] = useState(false);
  /** Idempotency key reused only when retrying the identical submission after a network error. */
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);

  const info = quota.status === 'ok' ? quota.info : null;
  const turnstile = useTurnstile(info?.turnstile_site_key ?? null);
  const currentMarket = markets.find((m) => m.code === market) ?? markets[0];
  const currency = currentMarket?.currency ?? '';

  const pausedMessage = pausedByServer ?? (info && !info.research_available ? PAUSED_MESSAGES[info.paused_reason ?? 'disabled'] : null);
  const exhausted = exhaustedByServer || (info !== null && info.research_available && info.remaining <= 0);
  const blocked = Boolean(pausedMessage) || exhausted;

  function update(field: keyof FormValues, value: string) {
    onValuesChange({ ...values, [field]: value });
    if (fieldErrors[field]) setFieldErrors({ ...fieldErrors, [field]: undefined });
  }

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    const p = validateProduct(values.product);
    if (p) errs.product = p;
    const full = marketByCode(market);
    if (values.price.trim() && full) {
      const parsed = parseUserPrice(values.price, full);
      if (parsed.kind === 'invalid' || parsed.kind === 'ambiguous' || parsed.kind === 'currency_mismatch') {
        errs.price =
          parsed.kind === 'currency_mismatch'
            ? `${parsed.reason} Re-enter the price in ${full.currency}, or change the market above.`
            : parsed.kind === 'ambiguous'
              ? parsed.reason
              : `${parsed.reason} Re-enter the price, for example 799 or 799.99.`;
      }
    }
    if (values.retailer.trim().length > MAX_RETAILER) errs.retailer = `Retailer can be at most ${MAX_RETAILER} characters.`;
    return errs;
  }

  function focusField(field: keyof FormValues) {
    if (field === 'retailer' && detailsRef.current) detailsRef.current.open = true;
    const el = field === 'product' ? productRef.current : field === 'price' ? priceRef.current : retailerRef.current;
    el?.focus();
  }

  function onSubscribeClick() {
    storage.set(STORAGE_SUBSCRIBE, new Date().toISOString());
    setSubscribeClicked(true);
    setJustUnlocked(true);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!subscribeClicked || submitting || blocked || quota.status === 'loading') return;
    const errs = validate();
    setFieldErrors(errs);
    const firstInvalid = (['product', 'price', 'retailer'] as const).find((f) => errs[f]);
    if (firstInvalid) {
      setSubmitError({ kind: 'invalid', message: 'Please correct the highlighted field before checking.' });
      focusField(firstInvalid);
      return;
    }
    const turnstileToken = turnstile.getToken();
    if (turnstile.required && !turnstileToken) {
      setSubmitError({
        kind: 'turnstile',
        message:
          turnstile.status === 'error'
            ? 'The human-verification check could not load. Check your connection or content blockers, then reload the page.'
            : 'Please wait for the human-verification check below to finish, then try again.',
      });
      return;
    }

    const core = {
      market,
      product: values.product.trim(),
      price: values.price.trim() || undefined,
      retailer: values.retailer.trim() || undefined,
    };
    const fingerprint = JSON.stringify(core);
    const key = pending.current?.fingerprint === fingerprint ? pending.current.key : randomKey(32);
    pending.current = { fingerprint, key };

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await createInvestigation({ ...core, idempotency_key: key, turnstile_token: turnstileToken });
      pending.current = null;
      onCreated(res.id);
    } catch (err) {
      if (!(err instanceof ApiFailure)) {
        pending.current = null;
        setSubmitError({ kind: 'technical', message: 'Something unexpected went wrong. Please try again.' });
      } else {
        if (!err.network) pending.current = null;
        handleError(err);
      }
    } finally {
      setSubmitting(false);
      turnstile.reset();
    }
  }

  function handleError(err: ApiFailure) {
    const { code, message } = err.error;
    switch (code) {
      case 'AMBIGUOUS_PRICE':
        setFieldErrors({ price: `${message}` });
        setSubmitError({ kind: 'invalid', message: 'The advertised price could be read in more than one way. Please re-enter it.' });
        focusField('price');
        return;
      case 'MARKET_MISMATCH':
        setFieldErrors({ price: `${message} Re-enter the price in ${currency}, or change the market above.` });
        setSubmitError({ kind: 'invalid', message: 'The price does not match the selected market.' });
        focusField('price');
        return;
      case 'INVALID_INPUT':
        setSubmitError({ kind: 'invalid', message });
        return;
      case 'QUOTA_EXHAUSTED':
        setExhaustedByServer(true);
        setSubmitError({ kind: 'quota', message });
        return;
      case 'BUDGET_PAUSED':
        setPausedByServer(message || PAUSED_MESSAGES.budget);
        setSubmitError(null);
        return;
      case 'BUSY':
      case 'RATE_LIMITED':
        setSubmitError({ kind: 'busy', message });
        return;
      case 'TURNSTILE_FAILED':
        setSubmitError({ kind: 'turnstile', message: `${message} Wait for the verification check to refresh, then submit again.` });
        return;
      default:
        setSubmitError({ kind: 'technical', message });
    }
  }

  const describedBy = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ') || undefined;

  return (
    <section aria-labelledby="landing-title" className="stack">
      <div className="intro">
        <h1 id="landing-title" tabIndex={-1}>
          Was it cheaper before Black Friday?
        </h1>
        <p className="lede">
          Tell us what you're looking at. DealCheck searches for dated, verifiable prices from the previous Black Friday and the months since,
          then shows you the evidence — not a guess.
        </p>
      </div>

      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}

      {pausedMessage && (
        <div className="alert alert-paused" role="status">
          <p className="alert-title">Research paused</p>
          <p>{pausedMessage}</p>
          <p className="small">Reports you already have in this browser remain available.</p>
        </div>
      )}

      <form className="card form" onSubmit={submit} noValidate aria-describedby={ids.quota}>
        <div className="field">
          <label htmlFor={ids.market}>Market</label>
          <div className="market-row">
            <select
              id={ids.market}
              value={market}
              onChange={(e) => {
                onMarketChange(e.target.value);
                if (fieldErrors.price) setFieldErrors({ ...fieldErrors, price: undefined });
              }}
              aria-describedby={ids.marketHint}
            >
              {markets.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.name} ({m.currency})
                </option>
              ))}
            </select>
            <span className="currency-chip" aria-hidden="true">
              {currency}
            </span>
          </div>
          <p id={ids.marketHint} className="hint">
            Prices are checked in {currentMarket?.name ?? 'the selected market'} only, in {currency}. We never guess your country.
          </p>
        </div>

        <div className="field">
          <label htmlFor={ids.product}>Product name, model number, barcode or product link</label>
          <input
            id={ids.product}
            ref={productRef}
            type="text"
            value={values.product}
            maxLength={MAX_PRODUCT_URL}
            onChange={(e) => update('product', e.target.value)}
            aria-invalid={fieldErrors.product ? true : undefined}
            aria-describedby={describedBy(ids.productHint, fieldErrors.product && ids.productErr)}
            autoComplete="off"
            spellCheck={false}
            required
            placeholder="e.g. Sony WH-1000XM5 headphones, black"
          />
          <p id={ids.productHint} className="hint">
            Text up to 512 characters, or a link starting with http:// or https://. New condition only.
          </p>
          {fieldErrors.product && (
            <p id={ids.productErr} className="field-error">
              {fieldErrors.product}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor={ids.price}>
            Advertised price ({currency}) <span className="optional">optional</span>
          </label>
          <input
            id={ids.price}
            ref={priceRef}
            type="text"
            inputMode="decimal"
            className="input-price"
            value={values.price}
            maxLength={32}
            onChange={(e) => update('price', e.target.value)}
            aria-invalid={fieldErrors.price ? true : undefined}
            aria-describedby={describedBy(ids.priceHint, fieldErrors.price && ids.priceErr)}
            autoComplete="off"
            placeholder="799.99"
          />
          <p id={ids.priceHint} className="hint">
            The price you're seeing now. Leave blank and DealCheck will look for the current offer.
          </p>
          {fieldErrors.price && (
            <p id={ids.priceErr} className="field-error">
              {fieldErrors.price}
            </p>
          )}
        </div>

        <details className="more" ref={detailsRef}>
          <summary>More details (optional)</summary>
          <div className="field">
            <label htmlFor={ids.retailer}>Retailer</label>
            <input
              id={ids.retailer}
              ref={retailerRef}
              type="text"
              value={values.retailer}
              maxLength={MAX_RETAILER}
              onChange={(e) => update('retailer', e.target.value)}
              aria-invalid={fieldErrors.retailer ? true : undefined}
              aria-describedby={fieldErrors.retailer ? ids.retailerErr : undefined}
              autoComplete="off"
              placeholder="e.g. JB Hi-Fi"
            />
            {fieldErrors.retailer && (
              <p id={ids.retailerErr} className="field-error">
                {fieldErrors.retailer}
              </p>
            )}
          </div>
        </details>

        {turnstile.required && (
          <div className="turnstile">
            <div ref={turnstile.containerRef} />
            {turnstile.status === 'loading' && <p className="hint">Loading a quick human-verification check…</p>}
            {turnstile.status === 'error' && (
              <p className="field-error">The verification check could not load. Check your connection or content blockers, then reload.</p>
            )}
          </div>
        )}

        {submitError && <SubmitErrorView error={submitError} onRetry={() => void submit()} />}

        {exhausted && !submitError && (
          <div className="alert alert-quota" role="status">
            <p className="alert-title">Free limit reached</p>
            <p>This network has used its free checks for the pilot. The allowance is shared by everyone on the same network.</p>
          </div>
        )}

        {!subscribeClicked && !blocked && (
          <div className="subscribe-gate" role="group" aria-labelledby={`${ids.quota}-sub`}>
            <p id={`${ids.quota}-sub`} className="alert-title">
              One step before your first check
            </p>
            <p>
              DealCheck is a free experiment from the 60 Dev Minutes newsletter. Please subscribe (it's free) to unlock your checks — the subscribe page
              opens in a new tab.
            </p>
            <a className="btn btn-secondary" href={SUBSCRIBE_URL} target="_blank" rel="noopener noreferrer" onClick={onSubscribeClick}>
              Subscribe to 60 Dev Minutes
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </div>
        )}
        {justUnlocked && !blocked && (
          <p className="hint" role="status">
            Thanks! Checks are unlocked in this browser — come back to this tab to run yours.
          </p>
        )}

        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={submitting || blocked || !subscribeClicked || quota.status === 'loading'} aria-busy={submitting || undefined}>
            {submitting ? 'Starting…' : 'Check the price history'}
          </button>
        </div>

        <QuotaLine id={ids.quota} quota={quota} exhausted={exhausted} />
      </form>
    </section>
  );
}

function SubmitErrorView({ error, onRetry }: { error: SubmitError; onRetry: () => void }) {
  switch (error.kind) {
    case 'invalid':
      return (
        <div className="alert alert-error" role="alert">
          <p className="alert-title">Please check your input</p>
          <p>{error.message}</p>
        </div>
      );
    case 'quota':
      return (
        <div className="alert alert-quota" role="alert">
          <p className="alert-title">Free limit reached</p>
          <p>{error.message}</p>
          <p className="small">Reports you already have in this browser remain available.</p>
        </div>
      );
    case 'busy':
      return (
        <div className="alert alert-warn" role="alert">
          <p className="alert-title">Please try again later</p>
          <p>{error.message}</p>
        </div>
      );
    case 'turnstile':
      return (
        <div className="alert alert-warn" role="alert">
          <p className="alert-title">Verification needed</p>
          <p>{error.message}</p>
        </div>
      );
    case 'technical':
      return (
        <div className="alert alert-error" role="alert">
          <p className="alert-title">Technical problem</p>
          <p>{error.message}</p>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      );
  }
}

function QuotaLine({ id, quota, exhausted }: { id: string; quota: QuotaState; exhausted: boolean }) {
  let main: string;
  if (quota.status === 'loading') main = 'Checking your remaining free checks…';
  else if (quota.status === 'error') main = "Couldn't load your remaining free checks right now.";
  else {
    const remaining = exhausted ? 0 : Math.max(0, quota.info.remaining);
    main = `About ${remaining} of ${quota.info.total} free checks left for your network.`;
  }
  return (
    <div id={id} className="quota">
      <p className="quota-main">{main}</p>
      <p className="hint">
        The allowance is shared by everyone on the same network (for example a household, office or mobile carrier), not per person, so the
        number is approximate.
      </p>
    </div>
  );
}
