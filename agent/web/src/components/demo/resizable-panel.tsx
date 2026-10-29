import { useEffect, useRef, useState } from 'react';

// The right panel's width, set by dragging its left edge (or arrow keys on the handle).
// Kept between MIN and whatever leaves the chat CHAT_MIN wide; remembered per browser.
// Double-click the handle for the default width.
const MIN = 380;
const CHAT_MIN = 480;
const defaultWidth = () => Math.round(Math.min(760, Math.max(440, window.innerWidth * 0.42)));

export function ResizablePanel({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => Number(localStorage.getItem('panelWidth')) || defaultWidth());
  const [dragging, setDragging] = useState(false);

  // The most it can take: everything right of the chat's minimum width.
  const clamp = (w: number) => {
    const row = ref.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.max(MIN, Math.min(w, row - CHAT_MIN)));
  };
  const set = (w: number) => {
    const next = clamp(w);
    setWidth(next);
    localStorage.setItem('panelWidth', String(next));
  };

  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // preventDefault (no text selection while dragging) also stops the browser's dblclick, so
  // a second press within 350 ms that doesn't move counts as the double-click.
  const lastPress = useRef(0);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    if (e.timeStamp - lastPress.current < 350) {
      lastPress.current = 0;
      set(defaultWidth());
      return;
    }
    lastPress.current = e.timeStamp;
    const right = ref.current!.getBoundingClientRect().right;
    setDragging(true);
    const startX = e.clientX;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) lastPress.current = 0; // a drag, not half a double-click
      set(right - ev.clientX);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside ref={ref} style={{ width }} className="relative hidden shrink-0 border-l bg-surface-1 lg:block">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the demo panel"
        aria-valuenow={width}
        aria-valuemin={MIN}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') set(width + 24);
          if (e.key === 'ArrowRight') set(width - 24);
        }}
        className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none select-none outline-none"
      >
        <span
          className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
            dragging ? 'bg-[color:var(--fluid-accent)]' : 'bg-transparent group-hover:bg-[color:var(--fluid-accent)]/60 group-focus-visible:bg-[color:var(--fluid-accent)]'
          }`}
        />
      </div>
      {/* While dragging, keep the text from being selected and the cursor steady. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
      {children}
    </aside>
  );
}
