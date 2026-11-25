import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { identifyStage, logEvent, reportStage, researchStage, setState, stopJob, type ResolvedProduct } from './pipeline';

export const CLARIFICATION_WINDOW_MS = 10 * 60 * 1000;
export const JOB_RUNTIME_MS = 120 * 1000;

const PAID = { retries: { limit: 0, delay: '1 second', backoff: 'constant' }, timeout: '3 minutes' } as const;
const LOCAL = { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' } as const;

/** Durable investigation job. Paid steps never auto-retry (avoids double charging). */
export class InvestigationWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: Readonly<WorkflowEvent<{ jobId: string }>>, step: WorkflowStep): Promise<void> {
    const { jobId } = event.payload;
    const env = this.env;
    try {
      const ident = await step.do('identify', PAID, () => identifyStage(env, jobId));
      if (ident.kind === 'stopped') return;

      let product: ResolvedProduct;
      let resolved: Parameters<typeof reportStage>[2];
      let assessedMinor: number | null = null;
      let assessedRetailer: string | null = null;
      if (ident.kind === 'ambiguous') {
        const expires = new Date(Date.now() + CLARIFICATION_WINDOW_MS).toISOString();
        await step.do('await-clarification', LOCAL, async () => {
          await setState(env.DB, jobId, 'awaiting_clarification', {
            detail: 'awaiting_clarification',
            clarification_json: JSON.stringify({ kind: 'variant', question: ident.question, candidates: ident.candidates.map(({ id, label, detail }) => ({ id, label, detail })), expires_at: expires }),
          });
          return true;
        });
        let choice: string;
        try {
          const ev = await step.waitForEvent<{ candidate_id: string }>('clarification', { type: 'clarification', timeout: '10 minutes' });
          choice = ev.payload.candidate_id;
        } catch {
          await step.do('abandon-clarification', LOCAL, async () => { await stopJob(env, jobId, 'cancelled', null); return true; });
          return;
        }
        const cand = ident.candidates.find((c) => c.id === choice);
        if (!cand) {
          await step.do('invalid-clarification', LOCAL, async () => { await stopJob(env, jobId, 'failed', 'INVALID_INPUT'); return true; });
          return;
        }
        product = cand.product;
        resolved = { kind: 'clarified', product, synthetic: ident.synthetic, searches: ident.searches, fetches: ident.fetches, ms: ident.ms };
      } else {
        product = ident.product;
        resolved = ident;
        assessedMinor = ident.offer?.observation.amount_minor ?? null;
        assessedRetailer = ident.offer?.observation.retailer ?? null;
      }

      const research = await step.do('research', PAID, () => researchStage(env, jobId, product, assessedMinor, assessedRetailer));
      if ('kind' in research) return;
      await step.do('report', LOCAL, () => reportStage(env, jobId, resolved, research));
    } catch (err) {
      await step.do('fail', LOCAL, async () => {
        await logEvent(env.DB, jobId, 'workflow_error', err instanceof Error ? err.message.slice(0, 300) : 'unknown');
        await stopJob(env, jobId, 'failed', 'INTERNAL');
        return true;
      });
    }
  }
}
