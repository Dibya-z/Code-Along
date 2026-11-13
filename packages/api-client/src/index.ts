import createClient from 'openapi-fetch';
import type { paths as ProductPaths, components } from './schema.js';
import type { paths as AuthPaths } from './auth-schema.js';
export type { ProductPaths, AuthPaths, components };
export const createProductClient = (
  origin: string,
  fetch: (request: Request) => Promise<Response>,
) =>
  createClient<ProductPaths>({
    baseUrl: origin,
    credentials: 'same-origin',
    fetch,
  });
export const createAuthClient = (
  origin: string,
  fetch: (request: Request) => Promise<Response>,
) =>
  createClient<AuthPaths>({
    baseUrl: origin,
    credentials: 'same-origin',
    fetch,
  });
