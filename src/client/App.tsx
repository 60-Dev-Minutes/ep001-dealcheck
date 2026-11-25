import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MARKET, MARKETS } from '../shared/markets';
import type { MarketInfo } from '../shared/types';
import { getMarkets, getQuota, isAbort } from './api';
import { CheckForm, EMPTY_VALUES, type FormValues, type QuotaState } from './components/CheckForm';
import { Footer } from './components/Footer';
import { JobView } from './components/JobView';
import { JOB_ID_RE, STORAGE_JOB, STORAGE_MARKET, storage } from './util';

const FALLBACK_MARKETS: MarketInfo[] = MARKETS.map((m) => ({ code: m.code, name: m.name, currency: m.currency }));

function initialMarket(): string {
  const saved = storage.get(STORAGE_MARKET)?.toUpperCase();
  return saved && FALLBACK_MARKETS.some((m) => m.code === saved) ? saved : DEFAULT_MARKET;
}

function initialJob(): string | null {
  const saved = storage.get(STORAGE_JOB);
  if (saved && JOB_ID_RE.test(saved)) return saved;
  if (saved) storage.remove(STORAGE_JOB);
  return null;
}

export function App() {
  const [markets, setMarkets] = useState<MarketInfo[]>(FALLBACK_MARKETS);
  const [market, setMarket] = useState<string>(initialMarket);
  const [quota, setQuota] = useState<QuotaState>({ status: 'loading' });
  const [jobId, setJobId] = useState<string | null>(initialJob);
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [notice, setNotice] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // Markets: the API is authoritative; the bundled registry is the offline fallback.
  useEffect(() => {
    const ctrl = new AbortController();
    getMarkets(ctrl.signal)
      .then(({ markets: list }) => {
        if (!Array.isArray(list) || list.length === 0) return;
        setMarkets(list);
        setMarket((cur) => (list.some((m) => m.code === cur) ? cur : list.some((m) => m.code === DEFAULT_MARKET) ? DEFAULT_MARKET : list[0]!.code));
      })
      .catch(() => {
        /* keep fallback list */
      });
    return () => ctrl.abort();
  }, []);

  const refreshQuota = useCallback(() => {
    const ctrl = new AbortController();
    getQuota(ctrl.signal)
      .then((info) => setQuota({ status: 'ok', info }))
      .catch((e: unknown) => {
        if (!isAbort(e)) setQuota((q) => (q.status === 'ok' ? q : { status: 'error' }));
      });
    return ctrl;
  }, []);

  // Quota is fetched on load and every time the form is shown again.
  useEffect(() => {
    if (jobId) return;
    const ctrl = refreshQuota();
    return () => ctrl.abort();
  }, [jobId, refreshQuota]);

  // Move focus to the new view's heading so keyboard and screen reader users land in the right place.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const h = mainRef.current?.querySelector<HTMLElement>('h1');
    h?.focus();
  }, [jobId]);

  const changeMarket = (code: string) => {
    setMarket(code);
    storage.set(STORAGE_MARKET, code);
  };

  const startJob = (id: string) => {
    storage.set(STORAGE_JOB, id);
    setNotice(null);
    setJobId(id);
  };

  const leaveJob = useCallback(() => {
    storage.remove(STORAGE_JOB);
    setJobId(null);
  }, []);

  const jobGone = useCallback(() => {
    storage.remove(STORAGE_JOB);
    setNotice('Your previous check is no longer available in this browser session. You can start a new one.');
    setJobId(null);
  }, []);

  const settled = useCallback(() => {
    refreshQuota();
  }, [refreshQuota]);

  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="container">
          <p className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✓
            </span>
            DealCheck
          </p>
        </div>
      </header>
      <main id="main" ref={mainRef} className="container main">
        {jobId ? (
          <JobView key={jobId} jobId={jobId} onRestart={leaveJob} onGone={jobGone} onSettled={settled} />
        ) : (
          <CheckForm
            markets={markets}
            market={market}
            onMarketChange={changeMarket}
            quota={quota}
            values={values}
            onValuesChange={setValues}
            onCreated={startJob}
            notice={notice}
          />
        )}
      </main>
      <Footer />
    </div>
  );
}
