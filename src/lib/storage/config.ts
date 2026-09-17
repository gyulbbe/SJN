export type StorageMode = 'd1';
export type StorageReason =
  | 'invalid_configuration'
  | 'missing_bindings'
  | 'connection_failed'
  | 'initialization_timeout'
  | 'unsupported_runtime'
  | 'ready';
export type StorageStatus = {
  mode: StorageMode;
  ready: boolean;
  reason: StorageReason;
  authRequired: boolean;
};
export type RuntimeSettings = {
  APP_ENV?: string;
  STORAGE_MODE?: string;
  NEXT_PUBLIC_STORAGE_MODE?: string;
};
export function configuredStorage(settings: RuntimeSettings): StorageStatus {
  const selected = settings.STORAGE_MODE ?? settings.NEXT_PUBLIC_STORAGE_MODE ?? 'auto';
  if (selected === 'local') return blockedStatus('invalid_configuration');
  if (!['auto', 'd1'].includes(selected)) return blockedStatus('invalid_configuration');
  return {
    mode: 'd1',
    ready: false,
    reason: 'ready',
    authRequired: true,
  };
}
export const STORAGE_MESSAGES: Record<StorageReason, string> = {
  ready: '',
  invalid_configuration: '서버 설정을 확인하지 못했어요. 연결을 복구한 뒤 로그인해 주세요.',
  missing_bindings: '서버 저장소 연결 설정이 필요해요.',
  connection_failed: '서버 저장소에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.',
  initialization_timeout: '서버 연결 확인 시간이 초과됐어요. 다시 확인해 주세요.',
  unsupported_runtime: '이 실행 환경에서 선택한 서버 저장소를 사용할 수 없어요.',
};
export function blockedStatus(reason: StorageReason): StorageStatus {
  return { mode: 'd1', ready: false, reason, authRequired: true };
}
