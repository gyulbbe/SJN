import type { SceneCandidate } from './pipeline-contract';
import type { ParsedFixtureAppearance } from './fixture-appearance-observation';
import { estimateAssemblyObservationBounds } from './estimated-assembly-bounds';

export const PROMOTED_BASIN_COMPONENT_REVISION = 'observed-basin-component-v1';
export const PROMOTED_BASIN_COMPONENT_REASON =
  '전체 세면대 분류로 바뀐 볼 영역은 최초의 별도 세면볼 관측과 명시적 지지 관계로 연결했어요. 원래 종류·영역은 보존하고 지지대 한 개에 결합해요.';

const sameBounds = (a: SceneCandidate, b: SceneCandidate) =>
  (['left', 'top', 'right', 'bottom'] as const).every((key) => a.bounds[key] === b.bounds[key]);
const userControlled = (item: SceneCandidate) => Object.values(item.provenance ?? {}).includes('user');

/**
 * Resolves a role for an already observed supportedBy assembly, never a new relation or fixture.
 * Appearance uses whole-fixture names even for a separately detected vessel bowl. A broad vanity
 * label must not erase that original component role and create a second complete vanity.
 */
export function observedBasinComponent(
  child: SceneCandidate,
  parent: SceneCandidate,
  appearance?: Pick<ParsedFixtureAppearance, 'decisions'>,
): SceneCandidate | null {
  if (child.kind === 'basin') return child;
  if (child.kind !== 'vanity' || parent.kind !== 'vanity' || child.id === parent.id) return null;
  const source = appearance?.decisions.find((entry) => entry.candidateId === child.id);
  const support = appearance?.decisions.find((entry) => entry.candidateId === parent.id);
  if (!source || !support) return null;
  if (
    !['applied', 'confirmed'].includes(source.status) ||
    !['applied', 'confirmed'].includes(support.status) ||
    source.original.kind !== 'basin' ||
    source.original.basinStyle !== 'vanity' ||
    support.original.kind !== 'vanity' ||
    source.effective.kind !== child.kind ||
    support.effective.kind !== parent.kind ||
    source.original.id !== child.id ||
    source.effective.id !== child.id ||
    support.original.id !== parent.id ||
    support.effective.id !== parent.id ||
    !['open_counter_basin', 'enclosed_vanity'].includes(source.observation.kind) ||
    !['open_counter_basin', 'enclosed_vanity'].includes(support.observation.kind) ||
    source.observation.context !== 'physical' ||
    support.observation.context !== 'physical' ||
    [child, parent, source.original, source.effective, support.original, support.effective].some(
      (item) => item.reflection !== 'physical' || userControlled(item) || !!item.validation?.issues.length,
    ) ||
    !sameBounds(child, source.original) ||
    !sameBounds(child, source.effective) ||
    !sameBounds(parent, support.original) ||
    !sameBounds(parent, support.effective)
  )
    return null;
  const component: SceneCandidate = { ...child, kind: 'basin', basinStyle: 'vanity' };
  return estimateAssemblyObservationBounds(parent, [component]).status === 'combined' ? component : null;
}
