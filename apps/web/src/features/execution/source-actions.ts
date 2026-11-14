import type { ReactNode } from 'react';
import type { components } from '@code-along/api-client';
import type { CapturedRun } from '../editor/model/snapshot.ts';
import type { ExecutionSnapshot } from './controller.ts';
import type { WorkExecutionContext } from './practice.ts';

export type ClientPracticeEvidence = Readonly<
  components['schemas']['ClientPracticeEvidence']
>;
export interface SourceCandidate {
  readonly captured: CapturedRun;
  readonly task: WorkExecutionContext;
  readonly practice: ClientPracticeEvidence | null;
}
export interface SourceActions {
  readonly canCapture: boolean;
  readonly conflict: string | null;
  readonly retained: SourceCandidate | null;
  readonly retainedEarlier: boolean;
  captureCurrent: () => Promise<SourceCandidate>;
}
export interface SourceActionPortal {
  readonly target: HTMLElement | null;
  readonly render: (actions: SourceActions) => ReactNode;
}

/** Local faults and Stop are not runtime evidence, even when their UI phase is terminal. */
export function retainedSource(
  snapshot: ExecutionSnapshot,
): SourceCandidate | null {
  if (!snapshot.captured || !snapshot.task) return null;
  const terminal = snapshot.terminal;
  const matched = terminal?.runId === snapshot.runId;
  const common = matched
    ? {
        run_id: terminal.runId,
        source_manifest_sha256: snapshot.captured.manifest.sha256,
        status: terminal.status,
      }
    : null;
  const practice: ClientPracticeEvidence | null = common
    ? snapshot.practice
      ? Object.freeze({
          ...common,
          kind: 'visible_checks' as const,
          practice_manifest_sha256: snapshot.practice.sha256,
          published_checks_sha256: snapshot.practice.published_checks_sha256,
          checks_sha256: snapshot.practice.checks.sha256,
          check_origin: snapshot.practice.check_origin,
        })
      : Object.freeze({ ...common, kind: 'run' as const })
    : null;
  return Object.freeze({
    captured: snapshot.captured,
    task: snapshot.task,
    practice,
  });
}
