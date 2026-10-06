// Typed calls for the feedback feature (packages/contracts feedback.ts), through the app's ApiClient.request
// (same-origin, JSON, contracts-validated).

import {
  FEEDBACK_ACCESS_ROUTE,
  FEEDBACK_ROUTE,
  FeedbackAccess,
  type FeedbackInput,
  FeedbackItem,
  FeedbackList,
  FeedbackSent,
  type FeedbackStatus,
  feedbackItemPath,
} from '@draftroom/contracts'
import { type ApiClient, api } from '../../api/client.ts'

export function feedbackApi(client: ApiClient = api) {
  const r = client.request
  return {
    send: (input: FeedbackInput) => r('POST', FEEDBACK_ROUTE, { body: input, schema: FeedbackSent }),
    /** Whether the signed-in person reads the inbox (everybody else: false). */
    access: (signal?: AbortSignal) => r('GET', FEEDBACK_ACCESS_ROUTE, { schema: FeedbackAccess, signal }),
    list: (
      query: { status: FeedbackStatus | 'all'; cursor?: string | null; limit?: number },
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams({ status: query.status })
      if (query.cursor) params.set('cursor', query.cursor)
      if (query.limit) params.set('limit', String(query.limit))
      return r('GET', `${FEEDBACK_ROUTE}?${params}`, { schema: FeedbackList, signal })
    },
    setStatus: (id: string, status: FeedbackStatus) =>
      r('PATCH', feedbackItemPath(id), { body: { status }, schema: FeedbackItem }),
  }
}
