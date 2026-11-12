import { Notice } from '@code-along/design-system';
import { ApiError } from './client.ts';
export function errorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.body &&
    typeof error.body === 'object'
  ) {
    const values = Object.values(error.body).flat();
    const messages = values.filter((v): v is string => typeof v === 'string');
    if (messages.length) return messages.join(' ');
  }
  return error instanceof Error
    ? error.message
    : 'The request could not be completed. Please try again.';
}
export function Failure({ error }: { error: unknown }) {
  return <Notice tone="error">{errorMessage(error)}</Notice>;
}
