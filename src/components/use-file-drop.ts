'use client';
import { useRef, useState, type DragEvent } from 'react';

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Props for a file drop area. Only file drags react (dragging text or an element does nothing).
 * While disabled the drop is still swallowed, so the browser does not open the file and leave the
 * page. A handled drag stops here, so a nested area wins over the one around it.
 */
export function useFileDrop({
  disabled = false,
  onFiles,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  // Entering a child fires enter on it before leave on the parent; count so the highlight holds.
  const depth = useRef(0);
  const dropProps = {
    onDragEnter(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current++;
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      setDragging(false);
      if (!disabled) onFiles(Array.from(event.dataTransfer.files));
    },
  };
  return { dragging: dragging && !disabled, dropProps };
}
