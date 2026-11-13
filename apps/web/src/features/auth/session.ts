import type { components } from '@code-along/api-client';
import { productApi } from '../../api/product.ts';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, clearCsrf } from '../../api/client.ts';
import { queryClient } from '../../app/providers.tsx';
import { announceSessionChange } from '../recovery/session-events.ts';
export type Identity = components['schemas']['CurrentUserOutput'];
export async function getIdentity(): Promise<Identity | null> {
  try {
    return await productApi.me();
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    )
      return null;
    throw error;
  }
}
export function useIdentity() {
  return useQuery({ queryKey: ['me'], queryFn: getIdentity });
}
export interface AuthResult {
  meta?: { is_authenticated?: boolean };
  errors?: { param?: string; message: string; code?: string }[];
}
export async function authenticate(
  action: string,
  body?: unknown,
  method = 'POST',
): Promise<AuthResult> {
  try {
    return await api<AuthResult>(`/api/v1/auth/browser/v1/auth/${action}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      typeof error.body === 'object' &&
      error.body &&
      !('errors' in error.body)
    )
      return error.body as AuthResult;
    throw error;
  } finally {
    clearCsrf();
  }
}
export function authErrors(error: unknown): {
  message: string;
  fields: Record<string, string>;
} {
  if (
    error instanceof ApiError &&
    error.body &&
    typeof error.body === 'object' &&
    'errors' in error.body &&
    Array.isArray(error.body.errors)
  ) {
    const fields: Record<string, string> = {};
    const messages: string[] = [];
    for (const item of error.body.errors as {
      param?: unknown;
      message?: unknown;
    }[]) {
      if (typeof item.message === 'string') {
        if (typeof item.param === 'string') fields[item.param] = item.message;
        else messages.push(item.message);
      }
    }
    return {
      message: messages.join(' ') || 'Please check the details below.',
      fields,
    };
  }
  return {
    message:
      error instanceof Error
        ? error.message
        : 'The request failed. Please try again.',
    fields: {},
  };
}
export async function replaceSession(
  destination = '/workspaces',
  broadcast = true,
): Promise<void> {
  if (broadcast) announceSessionChange();
  await queryClient.cancelQueries();
  queryClient.clear();
  clearCsrf();
  window.location.replace(destination);
}

export function safeDestination(value: string | null): string {
  return value &&
    (/^\/invitations\/[A-Za-z0-9_-]{43}$/.test(value) ||
      /^\/workspaces(?:\/[a-f0-9-]{36})?$/.test(value) ||
      /^\/projects\/[a-f0-9-]{36}$/.test(value) ||
      /^\/drafts(?:\/[a-f0-9-]{36})?$/.test(value))
    ? value
    : '/workspaces';
}
