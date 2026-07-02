import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../providers/port.js';
import type {
  TurnCallBudget,
  TurnCallBucket,
  TurnCallDenial,
  TurnCallOutcome,
  TurnCallPurpose,
} from './turn-call-budget.js';

export interface BudgetedProviderCall {
  readonly budget?: TurnCallBudget;
  readonly purpose: TurnCallPurpose;
  readonly bucket: TurnCallBucket;
  readonly provider: ProviderId;
  readonly parentCallId?: string;
}

export class TurnCallDeniedError extends Error {
  public readonly denial: TurnCallDenial;

  constructor(message: string, denial: TurnCallDenial) {
    super(message);
    this.name = 'TurnCallDeniedError';
    this.denial = denial;
  }
}

export function runBudgetedProvider(
  provider: Provider,
  request: ProviderRequest,
  signal: AbortSignal,
  call: BudgetedProviderCall,
): AsyncIterable<ProviderEvent> {
  if (!call.budget) {
    return provider.run(request, signal);
  }

  const budget = call.budget;

  let begun = false;
  let settled = false;
  let finishFn: ((outcome: TurnCallOutcome) => void) | undefined;
  let delegateIterator: AsyncIterator<ProviderEvent> | undefined;
  let hasTerminal = false;

  function settle(outcome: TurnCallOutcome): void {
    if (settled || !finishFn) return;
    settled = true;
    finishFn(outcome);
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      return {
        async next(): Promise<IteratorResult<ProviderEvent>> {
          if (!begun) {
            begun = true;

            const result = budget.begin({
              purpose: call.purpose,
              bucket: call.bucket,
              ...(call.parentCallId !== undefined ? { parentCallId: call.parentCallId } : {}),
            });

            if (!result.allowed) {
              throw new TurnCallDeniedError(
                `budget denied: ${result.denial.reason}`,
                result.denial,
              );
            }

            finishFn = result.finish;

            if (signal.aborted) {
              settle('cancelled');
              return { done: true, value: undefined };
            }

            const stream = provider.run(request, signal);
            delegateIterator = stream[Symbol.asyncIterator]();
          }

          if (!delegateIterator) {
            return { done: true, value: undefined };
          }

          let result: IteratorResult<ProviderEvent>;
          try {
            result = await delegateIterator.next();
          } catch (err) {
            if (!hasTerminal) {
              if (signal.aborted) {
                settle('cancelled');
              } else {
                settle('threw');
              }
              throw err;
            }
            throw err;
          }

          if (result.done) {
            if (!hasTerminal) {
              settle('empty');
            }
            return { done: true, value: undefined };
          }

          const event = result.value;

          if (event.type === 'done') {
            hasTerminal = true;
            settle('succeeded');
            return { done: false, value: event };
          }

          if (event.type === 'error') {
            hasTerminal = true;
            settle('provider-error');
            return { done: false, value: event };
          }

          return { done: false, value: event };
        },

        async return(value?: unknown): Promise<IteratorResult<ProviderEvent>> {
          if (begun && !settled) {
            settle('abandoned');
          }

          let result: IteratorResult<ProviderEvent> = { done: true, value: undefined };
          if (delegateIterator?.return) {
            try {
              result = (await delegateIterator.return(value as never)) as IteratorResult<ProviderEvent>;
            } catch {
              // Delegate return errors are swallowed — settlement already recorded.
            }
          }
          return result;
        },

        async throw(value?: unknown): Promise<IteratorResult<ProviderEvent>> {
          if (delegateIterator?.throw) {
            return (await delegateIterator.throw(value)) as IteratorResult<ProviderEvent>;
          }
          throw value;
        },
      };
    },
  };
}
