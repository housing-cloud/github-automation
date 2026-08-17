/**
 * The preview-labels explainer.
 *
 * The assertions are about **meaning**, not layout: each label has to be named
 * along with the effect a reviewer would act on, since the whole point of the
 * comment is that someone reads it and knows which label to add.
 */

import { describe, expect, it } from 'vitest';
import {
  PR_OPENED_COMMENT_MARKER,
  PREVIEW_LABELS,
  prOpenedComment,
} from './pr-opened';

describe('prOpenedComment', () => {
  it('names all three labels', () => {
    const body = prOpenedComment();
    for (const label of ['preview', 'no-preview', 'preserve-preview']) {
      expect(body).toContain(`\`${label}\``);
    }
  });

  it('describes what each label does', () => {
    const body = prOpenedComment();
    for (const label of PREVIEW_LABELS) {
      expect(body).toContain(label.effect);
    }
  });

  /** The three behaviours the user asked to be explained, in substance. */
  it('explains that no-preview suppresses the preview while it is present', () => {
    const body = prOpenedComment().toLowerCase();
    expect(body).toContain('do not run a preview');
    expect(body).toContain('while this label is present');
  });

  it('explains that preview is transitional and will become the default', () => {
    const body = prOpenedComment().toLowerCase();
    expect(body).toContain('transitional');
    expect(body).toContain('default');
  });

  it('explains that preserve-preview survives the PR closing', () => {
    const body = prOpenedComment().toLowerCase();
    expect(body).toContain('after the pr is closed');
    expect(body).toContain('torn down');
  });

  /**
   * `no-preview` beating `preview` is the one case a reviewer cannot guess, and
   * getting it wrong means expecting a preview that never comes.
   */
  it('says which label wins when both are applied', () => {
    expect(prOpenedComment()).toContain('Wins over `preview`');
  });

  it('warns that a preserved stack keeps consuming resources', () => {
    expect(prOpenedComment().toLowerCase()).toContain('consuming resources');
  });

  it('links the pstack dashboard when one is configured', () => {
    expect(
      prOpenedComment({ pstackBaseUrl: 'https://pstack.housing.cloud' }),
    ).toContain('https://pstack.housing.cloud');
    expect(prOpenedComment()).not.toContain('dashboard');
  });

  it('renders a table row per label', () => {
    const rows = prOpenedComment()
      .split('\n')
      .filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(PREVIEW_LABELS.length);
  });

  /** The marker is what stops a second copy appearing; it must be stable. */
  it('has a marker distinct from the other tracked comments', () => {
    expect(PR_OPENED_COMMENT_MARKER).toBe(
      'hou-event-automation:preview-labels',
    );
  });
});
