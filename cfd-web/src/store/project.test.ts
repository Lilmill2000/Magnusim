import { describe, expect, it } from 'vitest';
import { useProjectStore } from './project';

describe('project hydration ownership', () => {
  it('reads the nested active study and clears old geometry when changing projects', () => {
    const store = useProjectStore.getState();
    store.setHydrate('first', {simulation: {simulation: {id: 'study-2'}}, project: {active_geometry_id: 'geo-2'}});
    expect(useProjectStore.getState().activeSimId).toBe('study-2');
    expect(useProjectStore.getState().activeGeometryId).toBe('geo-2');
    store.setHydrate('empty', {});
    expect(useProjectStore.getState().activeSimId).toBeNull();
    expect(useProjectStore.getState().activeGeometryId).toBeNull();
  });
});
