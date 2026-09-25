import { describe, expect, it, vi } from 'vitest';
import {
  bodiesFromEvent,
  faceIdsFromEvent,
  publishBodySelection,
  publishFaceSelection,
  subscribeBodyPicks,
  subscribeFacePicks,
  toggleFaceId,
} from './pick';

describe('face picks', () => {
  it('round-trips through the document event', () => {
    const seen = vi.fn();
    const stop = subscribeFacePicks(seen);
    publishFaceSelection(['face 10@Body1', 'face 13@Body1']);
    stop();
    publishFaceSelection(['face 99@Body1']);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(['face 10@Body1', 'face 13@Body1']);
  });

  it('ignores a malformed detail', () => {
    expect(faceIdsFromEvent(null)).toEqual([]);
    expect(faceIdsFromEvent({ ids: 'nope' })).toEqual([]);
  });

  it('toggles ids', () => {
    expect(toggleFaceId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleFaceId(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('body picks', () => {
  it('round-trips through the document event', () => {
    const seen = vi.fn();
    const stop = subscribeBodyPicks(seen);
    publishBodySelection([{ name: 'Body1', idx: 0 }]);
    stop();
    publishBodySelection([{ name: 'Body2', idx: 1 }]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([{ name: 'Body1', idx: 0 }]);
  });

  it('drops unnamed bodies and a malformed detail', () => {
    expect(bodiesFromEvent(null)).toEqual([]);
    expect(bodiesFromEvent({ bodies: [{ name: '  ', idx: 2 }] })).toEqual([]);
    expect(bodiesFromEvent({ bodies: [{ name: 'Body1' }] })).toEqual([
      { name: 'Body1', idx: -1 },
    ]);
  });
});
