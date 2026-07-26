import { describe, expect, it } from 'vitest';
import { lookupReferenceModelMeta } from '../model-metadata';

describe('lookupReferenceModelMeta', () => {
  it('does not borrow another provider partition when provider is set', () => {
    // grok-4.3 is under xai; with an arbitrary custom provider only fallbacks apply (may be absent).
    // Must never silently steal xai metadata — that caused Vision ON in UI while
    // runtime model-sync left image off until a re-toggle save.
    const custom = lookupReferenceModelMeta('grok-4.3', 'custom-provider');
    const xai = lookupReferenceModelMeta('grok-4.3', 'xai');
    expect(xai).toMatchObject({ name: 'Grok 4.3', image: true });
    // grok-4.3 is not in generic fallbacks; must not steal xai partition.
    expect(custom).toBeNull();
  });

  it('still resolves bare-id display metadata when provider is omitted', () => {
    expect(lookupReferenceModelMeta('grok-4.3')).toMatchObject({
      name: 'Grok 4.3',
      image: true,
    });
  });
});
