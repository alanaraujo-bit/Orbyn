import OpenAI from 'openai';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { assertBreakerClosed, recordBreakerFailure, recordBreakerSuccess } from '@/lib/circuit-breaker';
import { requireUsableCapability } from '@/features/system/capabilities';
import { assertBudgetAvailable, recordAiCall, type AiTier } from './usage';

const log = createLogger('openai');

let client: OpenAI | undefined;

function getClient(): OpenAI {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) {
    throw new AppError('ai_unavailable', 'OPENAI_API_KEY não configurada.');
  }
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 2 });
  return client;
}

export function resetOpenAiClient(): void {
  client = undefined;
}

export function modelFor(tier: AiTier): string {
  const env = getEnv();
  return tier === 'fast' ? env.OPENAI_MODEL_FAST : env.OPENAI_MODEL;
}

export interface StructuredCallInput<T> {
  tier: AiTier;
  operation: string;
  /** Human-readable name for the JSON schema; a-z, 0-9, `_`. */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  parser: z.ZodType<T>;
  instructions: string;
  input: string;
  leadId?: string | null;
  conversationId?: string | null;
  jobId?: string | null;
  maxOutputTokens?: number;
}

export interface StructuredCallResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * The only path from this system to a language model. It enforces the budget,
 * the circuit breaker and the usage ledger, and always returns validated,
 * structured data - never free-form text that could drive an action directly.
 */
export async function callStructured<T>(input: StructuredCallInput<T>): Promise<StructuredCallResult<T>> {
  requireUsableCapability('ai_engine');
  assertBudgetAvailable();
  assertBreakerClosed('openai');

  const model = modelFor(input.tier);
  const openai = getClient();

  try {
    const response = await openai.responses.create({
      model,
      instructions: input.instructions,
      input: input.input,
      max_output_tokens: input.maxOutputTokens ?? 900,
      text: {
        format: {
          type: 'json_schema',
          name: input.schemaName,
          schema: input.jsonSchema,
          strict: true,
        },
      },
    });

    // `input_tokens` is the total; `cached_tokens` is the cheaper subset of it.
    const usage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };

    // A truncated response is not malformed JSON, it is an exhausted budget.
    // Say so, otherwise the operator chases a parsing bug that does not exist.
    if (response.status === 'incomplete' || response.incomplete_details?.reason === 'max_output_tokens') {
      recordAiCall({
        model,
        operation: input.operation,
        status: 'failed',
        usage,
        tier: input.tier,
        leadId: input.leadId,
        conversationId: input.conversationId,
        jobId: input.jobId,
        error: 'resposta truncada por max_output_tokens',
      });
      throw new AppError('ai_unsafe_output', 'Resposta do modelo truncada pelo limite de tokens de saída.', {
        details: { maxOutputTokens: input.maxOutputTokens ?? 900, outputTokens: usage.outputTokens },
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.output_text);
    } catch (error) {
      recordAiCall({
        model,
        operation: input.operation,
        status: 'failed',
        usage,
        tier: input.tier,
        leadId: input.leadId,
        conversationId: input.conversationId,
        jobId: input.jobId,
        error: 'resposta nao e JSON valido',
      });
      throw new AppError('ai_unsafe_output', 'Resposta do modelo não é JSON válido.', { cause: error });
    }

    const parsed = input.parser.safeParse(parsedJson);
    if (!parsed.success) {
      recordAiCall({
        model,
        operation: input.operation,
        status: 'failed',
        usage,
        tier: input.tier,
        leadId: input.leadId,
        conversationId: input.conversationId,
        jobId: input.jobId,
        error: 'schema mismatch',
      });
      throw new AppError('ai_unsafe_output', 'Resposta do modelo fora do schema esperado.', {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }

    const call = recordAiCall({
      model,
      operation: input.operation,
      status: 'succeeded',
      usage,
      tier: input.tier,
      leadId: input.leadId,
      conversationId: input.conversationId,
      jobId: input.jobId,
    });
    recordBreakerSuccess('openai');

    return {
      data: parsed.data,
      model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      costUsd: call.costUsd,
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'ai_unsafe_output') throw error;
    const message = error instanceof Error ? error.message : String(error);
    recordAiCall({
      model,
      operation: input.operation,
      status: 'failed',
      tier: input.tier,
      leadId: input.leadId,
      conversationId: input.conversationId,
      jobId: input.jobId,
      error: message,
    });
    const state = recordBreakerFailure('openai', message);
    log.error('openai call failed', { operation: input.operation, breaker: state });
    throw new AppError('ai_unavailable', 'Falha ao chamar o modelo de linguagem.', { cause: error, retryable: true });
  }
}
