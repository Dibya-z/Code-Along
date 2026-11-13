import { Pool } from 'pg';
import * as Y from 'yjs';
import { ProductCheckpointStore } from '../../src/persistence/checkpoint-store.ts';
const pool = new Pool({
  user: 'code_along_collaboration',
  max: 1,
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 200,
});
pool.on('error', () => {
  process.send?.({ error: 'database_unavailable' });
  process.exitCode = 1;
});
try {
  const scope = {
    document_id: process.env['PRODUCT_DOCUMENT_ID']!,
    generation: 1,
  };
  const stored = await new ProductCheckpointStore(pool).load(scope);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stored.binary);
  process.send?.({
    source: doc.getText('source').toString(),
    revision: stored.durable_revision,
  });
  doc.destroy();
} catch {
  process.send?.({ error: 'recovery_failed' });
  process.exitCode = 1;
} finally {
  await pool.end();
  process.disconnect?.();
}
