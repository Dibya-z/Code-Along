import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
