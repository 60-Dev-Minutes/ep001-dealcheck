// Cloudflare Turnstile, loaded on demand and rendered explicitly (no inline script; CSP-friendly).
import { useCallback, useEffect, useRef, useState } from 'react';

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'flexible' | 'compact';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  'timeout-callback'?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable')));
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(new Error('Turnstile failed to load'));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

export type TurnstileStatus = 'off' | 'loading' | 'ready' | 'solved' | 'expired' | 'error';

export function useTurnstile(siteKey: string | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef('');
  const [status, setStatus] = useState<TurnstileStatus>(siteKey ? 'loading' : 'off');

  useEffect(() => {
    if (!siteKey) {
      setStatus('off');
      return;
    }
    let alive = true;
    setStatus('loading');
    loadTurnstile()
      .then((ts) => {
        const el = containerRef.current;
        if (!alive || !el) return;
        widgetId.current =
          ts.render(el, {
            sitekey: siteKey,
            action: 'investigate',
            theme: 'auto',
            size: 'flexible',
            callback: (t) => {
              token.current = t;
              setStatus('solved');
            },
            'expired-callback': () => {
              token.current = '';
              setStatus('expired');
            },
            'timeout-callback': () => {
              token.current = '';
              setStatus('expired');
            },
            'error-callback': () => {
              token.current = '';
              setStatus('error');
            },
          }) ?? null;
        setStatus((s) => (s === 'loading' ? 'ready' : s));
      })
      .catch(() => {
        if (alive) setStatus('error');
      });
    return () => {
      alive = false;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
      token.current = '';
    };
  }, [siteKey]);

  const reset = useCallback(() => {
    token.current = '';
    if (widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      setStatus('ready');
    }
  }, []);

  const getToken = useCallback(() => (siteKey ? token.current : ''), [siteKey]);

  return { containerRef, status, required: Boolean(siteKey), getToken, reset };
}
