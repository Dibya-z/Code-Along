import { Pool } from 'pg';
import { CheckpointStore } from '../../src/persistence/checkpoint-store.ts';
import {
  createProofServer,
  type Admission,
} from '../../src/protocol/proof-server.ts';

const grants = JSON.parse(
  process.env['PROOF_ADMISSIONS'] ?? '[]',
) as (Admission & { token: string })[];
const pool = new Pool({
  user: 'checkpoint_writer',
  max: 3,
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 200,
});
pool.on('error', () => {
  process.send?.({ error: 'database_unavailable' });
  process.exit(1); // Unexpected idle failure closes the owned fixture, never logs driver data.
});
const server = createProofServer({
  store: new CheckpointStore(pool),
  debounce: 60000,
  async admit(token, name) {
    const grant = grants.find(
      (g) => g.token === token && name === `${g.document_id}:${g.generation}`,
    );
    if (!grant) throw new Error('admission_denied');
    return grant;
  },
});
await server.listen();
process.send?.({ port: server.address.port });
process.on('disconnect', () => {
  void server
    .destroy()
    .then(() => pool.end())
    .finally(() => process.exit(0));
});
