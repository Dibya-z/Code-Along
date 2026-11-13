import { api } from '../../api/client.ts';
import type { EditorDocument } from '../editor/model/document.ts';
import type { components } from '@code-along/api-client';

export type DocumentTicket = components['schemas']['TicketOutput'];
/** Admission secrets are exchanged only in the provider auth frame, never URLs or storage. */
export async function documentTicket(
  projectId: string,
  file: EditorDocument,
  scope: 'read' | 'write',
  clientSessionId: string,
  signal: AbortSignal,
): Promise<DocumentTicket> {
  const ticket = await api<DocumentTicket>(
    `/api/v1/projects/${projectId}/documents/${file.metadata.document_id}/ticket/`,
    {
      method: 'POST',
      signal,
      body: {
        generation: file.metadata.generation,
        scope,
        client_session_id: clientSessionId,
        awareness_client_id: file.doc.clientID,
      } satisfies components['schemas']['TicketBodyRequest'],
    },
  );
  if (
    !ticket ||
    typeof ticket.ticket !== 'string' ||
    !ticket.ticket ||
    ticket.ticket.length > 4096 ||
    ticket.document_name !==
      `${file.metadata.document_id}:${file.metadata.generation}` ||
    typeof ticket.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(ticket.expires_at)) ||
    Date.parse(ticket.expires_at) <= Date.now()
  )
    throw new Error('Collaboration admission could not be verified.');
  return ticket;
}
