/**
 * Compose process-wide chat admission in front of a route handler.
 *
 * Uses the shipped `admitChatRequest` budget/fairness controller — it does not
 * introduce a second admission path. Call this *outside* `withInjectionGuard`
 * so a large `/v1/responses` or `/v1/messages` body is reserved (or 503-shed)
 * before `request.clone()` / `.json()`.
 *
 * Since the working-set budget landed (`chatWorkBudget.ts`), an admitted large-context request
 * also reserves its ESTIMATED working set for the whole response lifetime (including the SSE
 * stream). The byte stage bounds one request's bytes; this second reservation bounds the sum of
 * all in-flight large-context work, which is the quantity that actually fills the V8 heap.
 */
import {
  admitChatRequest,
  CHAT_ADMISSION_QUEUE_MAX_MS,
  releaseChatAdmissionAfterHandler,
  resolveSessionId,
  type ChatAdmissionController,
} from "./chatBodyAdmission";
import {
  admitChatWork,
  CHAT_WORK_QUEUE_MAX_MS,
  composeChatWorkLease,
  declaredBodyBytes,
  type ChatWorkBudget,
} from "./chatWorkBudget";

type RouteHandler = (request: Request, ...args: any[]) => Promise<Response> | Response;

export function withChatAdmission(
  handler: RouteHandler,
  options: {
    controller?: ChatAdmissionController;
    queueMs?: number;
    largeBodyBytes?: number;
    hardMaxBytes?: number;
    /** Working-set budget/queue overrides — tests inject a deterministic budget. */
    workBudget?: ChatWorkBudget;
    workQueueMs?: number;
  } = {}
): RouteHandler {
  return async function admittedHandler(request: Request, ...args: any[]) {
    const sessionId = resolveSessionId(request);
    const declaredBytes = declaredBodyBytes(request.headers);
    const admission = await admitChatRequest(request, {
      sessionId,
      queueMs: options.queueMs ?? CHAT_ADMISSION_QUEUE_MAX_MS,
      controller: options.controller,
      largeBodyBytes: options.largeBodyBytes,
      hardMaxBytes: options.hardMaxBytes,
    });
    if (admission.admit === false) return admission.response;
    const work = await admitChatWork({
      lane: sessionId,
      bodyBytes: declaredBytes,
      waitMs: options.workQueueMs ?? CHAT_WORK_QUEUE_MAX_MS,
      signal: request.signal,
      budget: options.workBudget,
    });
    if (work.admit === false) {
      admission.lease?.release();
      return work.response;
    }
    try {
      return await releaseChatAdmissionAfterHandler(
        Promise.resolve(handler(admission.request, ...args)),
        composeChatWorkLease(admission.lease, work.lease)
      );
    } catch (error) {
      admission.lease?.release();
      work.lease.release();
      throw error;
    }
  };
}