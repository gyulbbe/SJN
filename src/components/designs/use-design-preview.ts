'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAdminProjectScope } from '@/components/repository-context';
import { useEditingCapabilities } from '@/components/editor/editing-capabilities';
import type { AssetReader } from '@/lib/render/compositor';
import { designPreviewMaterialIds } from '@/lib/render/design-preview-context';
import {
  acquireDesignPreviewSession,
  DesignPreviewCancelled,
  type DesignPreviewInput,
  type DesignPreviewResult,
} from '@/lib/render/design-preview';
import {
  DESIGN_PREVIEW_EVENT,
  getCachedDesignThumbnail,
  type DesignPreviewIdentity,
} from '@/lib/render/design-preview-cache';

type Input = Omit<DesignPreviewInput, 'design'> & {
  design: DesignPreviewInput['design'] | null;
  assetReader: AssetReader;
  enabled?: boolean;
  delayMs?: number;
};
type State = {
  url?: string;
  result?: DesignPreviewResult;
  designId?: string;
  requestSignature?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
};
export function useDesignPreview(source: Input) {
  const adminScope = useAdminProjectScope();
  const { guest } = useEditingCapabilities();
  const input = { ...source, transient: !!adminScope || guest || source.transient };
  const sessionKey = adminScope
    ? adminScope + input.projectId
    : input.transient
      ? `transient:${input.projectId}`
      : input.projectId;
  const channel = useId(),
    currentInput = useRef(input),
    url = useRef<string | undefined>(undefined);
  currentInput.current = input;
  const [state, setState] = useState<State>({ status: 'idle' });
  const [retryVersion, setRetryVersion] = useState(0);
  const signature = useMemo(() => {
    const ids = input.design ? designPreviewMaterialIds(input.design.scene, input.roomContext) : [];
    return JSON.stringify([
      input.projectId,
      input.transient,
      input.sharedRevision,
      input.design?.id,
      input.design?.renderRevision ?? input.design?.revision,
      input.design?.scene,
      input.purpose,
      input.edge,
      input.roomContext,
      ids.map((id) => input.materials[id]),
    ]);
  }, [
    input.projectId,
    input.transient,
    input.sharedRevision,
    input.design,
    input.purpose,
    input.edge,
    input.materials,
    input.roomContext,
  ]);
  const enabled = input.enabled !== false && !!input.design;
  useEffect(() => {
    if (!enabled) return;
    const session = acquireDesignPreviewSession(sessionKey, input.assetReader);
    let alive = true;
    const timer = setTimeout(
      () => {
        const captured = currentInput.current;
        if (!captured.design || !alive) return;
        setState((previous) => ({
          ...previous,
          status: 'loading',
          error: undefined,
          requestSignature: signature,
        }));
        void session.service
          .request(channel, { ...captured, design: captured.design })
          .then((result) => {
            if (!alive) return;
            const nextUrl = URL.createObjectURL(result.blob),
              previous = url.current;
            url.current = nextUrl;
            setState({
              status: 'ready',
              url: nextUrl,
              result,
              designId: captured.design!.id,
              requestSignature: signature,
            });
            if (previous) URL.revokeObjectURL(previous);
          })
          .catch((error) => {
            if (!alive || error instanceof DesignPreviewCancelled) return;
            setState((previous) => ({
              ...previous,
              status: 'error',
              requestSignature: signature,
              error: error instanceof Error ? error.message : '시안 미리보기를 준비하지 못했어요.',
            }));
          });
      },
      Math.max(0, input.delayMs ?? 0),
    );
    return () => {
      alive = false;
      clearTimeout(timer);
      session.service.cancel(channel);
      session.release();
    };
  }, [
    enabled,
    signature,
    retryVersion,
    channel,
    input.projectId,
    input.assetReader,
    input.delayMs,
    sessionKey,
  ]);
  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );
  const matchingDesign = state.designId === input.design?.id;
  return {
    ...state,
    url: matchingDesign ? state.url : undefined,
    status: !enabled
      ? ('idle' as const)
      : state.requestSignature === signature
        ? state.status
        : ('loading' as const),
    error: state.requestSignature === signature ? state.error : undefined,
    retry: () => setRetryVersion((value) => value + 1),
  };
}
export function useDesignThumbnail(input: Omit<Input, 'purpose' | 'edge'>) {
  return useDesignPreview({ ...input, purpose: 'thumbnail', edge: 360 });
}
export type ThumbnailIdentity = Omit<DesignPreviewIdentity, 'designId' | 'revision' | 'sharedRevision'> & {
  designId?: string | null;
  revision?: number;
  sharedRevision?: number;
};
export function useCachedDesignThumbnail(identity: ThumbnailIdentity): string | undefined {
  const adminScope = useAdminProjectScope();
  const { guest } = useEditingCapabilities();
  const transient = !!adminScope || guest;
  const [value, setValue] = useState<{ key: string; url?: string }>({ key: '' });
  const key = JSON.stringify(identity);
  const { projectId, designId, revision, sharedRevision, contextKey } = identity;
  useEffect(() => {
    if (transient || !designId || revision === undefined || sharedRevision === undefined) return;
    let alive = true,
      loadVersion = 0,
      currentUrl: string | undefined;
    const load = async () => {
      const version = ++loadVersion;
      const blob = await getCachedDesignThumbnail({
        projectId,
        designId,
        revision,
        sharedRevision,
        contextKey,
      });
      if (!alive || version !== loadVersion) return;
      const next = blob ? URL.createObjectURL(blob) : undefined;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = next;
      setValue({ key, url: next });
    };
    void load();
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === projectId) void load();
    };
    window.addEventListener(DESIGN_PREVIEW_EVENT, changed);
    const channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(DESIGN_PREVIEW_EVENT) : undefined;
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === projectId) void load();
      };
    return () => {
      alive = false;
      window.removeEventListener(DESIGN_PREVIEW_EVENT, changed);
      channel?.close();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [key, projectId, designId, revision, sharedRevision, contextKey, transient]);
  return !transient && value.key === key ? value.url : undefined;
}
