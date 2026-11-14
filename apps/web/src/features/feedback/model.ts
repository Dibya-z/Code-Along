import type {
  Assessment,
  FeedbackDraft,
  FeedbackPublication,
  FeedbackPublish,
  FeedbackSave,
  FeedbackScope,
} from './types.ts';
import {
  draftProblem,
  validateDraft,
  validatePublication,
} from './validation.ts';

export interface PublicationAttempt {
  readonly body: FeedbackPublish;
  readonly draft: FeedbackDraft;
}
export interface FeedbackState {
  readonly saved: FeedbackDraft | null;
  readonly comments: string;
  readonly assessment: Assessment | null;
  readonly reading: boolean;
  readonly phase: 'idle' | 'saving' | 'publishing' | 'uncertain' | 'confirmed';
  readonly attempt: PublicationAttempt | null;
  readonly receipt: FeedbackPublication | null;
  readonly error: unknown;
  readonly loadError: unknown;
  readonly reloadRequired: boolean;
}
export interface FeedbackIO {
  authorize: (signal: AbortSignal) => Promise<void>;
  draft: (signal: AbortSignal) => Promise<FeedbackDraft>;
  save: (body: FeedbackSave, signal: AbortSignal) => Promise<unknown>;
  publish: (body: FeedbackPublish, signal: AbortSignal) => Promise<unknown>;
}
/** Local edits, the last saved CAS revision and the original publication are separate memory-only values. */
export class FeedbackModel {
  private state: FeedbackState = Object.freeze({
    saved: null,
    comments: '',
    assessment: null,
    reading: false,
    phase: 'idle',
    attempt: null,
    receipt: null,
    error: null,
    loadError: null,
    reloadRequired: false,
  });
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private busy = false;
  constructor(
    private readonly scope: FeedbackScope,
    private readonly active: () => boolean,
    private readonly io: FeedbackIO,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private current() {
    return !this.abort.signal.aborted && this.active();
  }
  private update(patch: Partial<FeedbackState>) {
    if (!this.current()) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  edit(comments: string, assessment: Assessment | null) {
    if (!this.busy) this.update({ comments, assessment, error: null });
  }
  async load(replace = false) {
    if (!this.current() || this.busy) return;
    this.busy = true;
    this.update({ reading: true, loadError: null });
    try {
      await this.io.authorize(this.abort.signal);
      if (!this.current()) return;
      const draft = validateDraft(
        await this.io.draft(this.abort.signal),
        this.scope.submissionId,
      );
      if (!this.current()) return;
      this.update({
        saved: draft,
        reading: false,
        error: null,
        reloadRequired: false,
        ...(replace || !this.state.saved
          ? { comments: draft.comments, assessment: draft.assessment_status }
          : {}),
      });
    } catch (loadError) {
      this.update({ reading: false, loadError });
    } finally {
      this.busy = false;
    }
  }
  async save() {
    const { saved, comments, assessment, reloadRequired } = this.state;
    if (!saved || reloadRequired || !this.current() || this.busy) return;
    const problem = draftProblem(comments, assessment);
    if (problem) {
      this.update({ error: new Error(problem) });
      return;
    }
    const body = Object.freeze({
      expected_revision: saved.revision,
      comments,
      assessment_status: assessment,
    });
    const wasConfirmed = this.state.phase === 'confirmed';
    this.busy = true;
    this.update({ phase: 'saving', error: null });
    try {
      await this.io.authorize(this.abort.signal);
      if (!this.current()) return;
      const draft = validateDraft(
        await this.io.save(body, this.abort.signal),
        this.scope.submissionId,
      );
      if (!this.current()) return;
      if (
        draft.revision !== body.expected_revision + 1 ||
        draft.comments !== body.comments ||
        draft.assessment_status !== body.assessment_status ||
        draft.last_edited_by?.id !== this.scope.accountId
      )
        throw new Error(
          'The saved draft response did not match your changes. Reload the saved draft before another save.',
        );
      this.update({
        saved: draft,
        phase: this.state.attempt
          ? 'uncertain'
          : wasConfirmed
            ? 'confirmed'
            : 'idle',
      });
    } catch (error) {
      this.update({
        error,
        phase: this.state.attempt ? 'uncertain' : 'idle',
        reloadRequired: true,
      });
    } finally {
      this.busy = false;
    }
  }
  async publish() {
    if (!this.current() || this.busy || this.state.phase === 'confirmed')
      return;
    let attempt = this.state.attempt;
    if (!attempt) {
      const { saved, comments, assessment } = this.state;
      if (!saved || this.state.reloadRequired) return;
      const problem = draftProblem(
        saved.comments,
        saved.assessment_status,
        true,
      );
      if (
        problem ||
        saved.comments !== comments ||
        saved.assessment_status !== assessment
      ) {
        this.update({
          error: new Error(
            problem ?? 'Save these draft changes before publishing.',
          ),
        });
        return;
      }
      attempt = Object.freeze({
        body: Object.freeze({
          expected_revision: saved.revision,
          client_request_id: crypto.randomUUID(),
        }),
        draft: saved,
      });
    }
    // Retain this exact draft and nonce before any authentication or network await.
    const original = attempt;
    this.busy = true;
    this.update({ attempt: original, phase: 'publishing', error: null });
    try {
      await this.io.authorize(this.abort.signal);
      if (!this.current()) return;
      const response = await this.io.publish(original.body, this.abort.signal);
      if (!this.current()) return;
      const receipt = await validatePublication(response, this.scope);
      if (!this.current()) return;
      if (
        receipt.publisher.id !== this.scope.accountId ||
        receipt.comments !== original.draft.comments ||
        receipt.assessment_status !== original.draft.assessment_status
      )
        throw new Error(
          'This publication response did not match the saved draft you chose.',
        );
      this.update({
        receipt,
        attempt: null,
        phase: 'confirmed',
        error: null,
        reloadRequired: true,
      });
    } catch (error) {
      this.update({ phase: 'uncertain', error });
    } finally {
      this.busy = false;
    }
  }
  setAside() {
    if (!this.busy) this.update({ attempt: null, phase: 'idle', error: null });
  }
  destroy() {
    this.abort.abort();
    this.listeners.clear();
  }
}
