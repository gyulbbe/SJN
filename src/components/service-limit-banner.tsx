'use client';
import { useEffect, useState } from 'react';
import type { ServiceLimit } from '@/lib/platform/service-limit';
import {
  aiLimitHint,
  limitGroup,
  readServiceLimits,
  SERVICE_LIMIT_EVENT,
  serviceLimitMessage,
  type LimitGroup,
} from '@/lib/service-limit-notice';

/**
 * The spent daily limits the screens have heard of (service-limit-notice.ts), each until its time to
 * come back: hidden then by a timer on this page's clock, with no request to check.
 */
export function useServiceLimits(group?: LimitGroup) {
  const [limits, setLimits] = useState<ServiceLimit[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const now = Date.now();
      const current = readServiceLimits(now);
      setLimits(current);
      const next = Math.min(
        ...current.flatMap((limit) => (limit.resetAt ? [Date.parse(limit.resetAt) - now] : [])),
      );
      // Past the time it comes back the notice goes; a later answer can bring it back.
      if (Number.isFinite(next)) timer = setTimeout(update, Math.min(Math.max(next, 0) + 50, 2 ** 31 - 1));
    };
    update();
    window.addEventListener(SERVICE_LIMIT_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(SERVICE_LIMIT_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return group ? limits.filter((limit) => limitGroup(limit) === group) : limits;
}

/** At the top of every page, public ones too: one line a kind, not fixed over the page. */
export function ServiceLimitBanner() {
  const limits = useServiceLimits();
  if (!limits.length) return null;
  return (
    <div data-testid="service-limit-banner">
      {limits.map((limit) => (
        <div
          key={limitGroup(limit)}
          role="status"
          data-service={limit.service}
          className="border-b border-[#ecd29f] bg-[#fff0d4] px-4 py-2 text-center text-[13px] leading-snug break-keep text-[#7a5512]"
        >
          {serviceLimitMessage(limit)}
        </div>
      ))}
    </div>
  );
}

/** Beside an AI button while the day's AI allocation is spent; the button still works. */
export function AiLimitHint() {
  const [limit] = useServiceLimits('ai');
  if (!limit) return null;
  return (
    <span data-testid="ai-limit-hint" className="text-[12px] leading-snug text-[#8a5a00]">
      {aiLimitHint(limit)}
    </span>
  );
}
