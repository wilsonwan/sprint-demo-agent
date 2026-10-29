import { useEffect, useState } from 'react';
import type { Demo } from './api';
import { subscribe } from './live';

// A demo's shared document, live (the demo:<id> topic on /api/live sends it again after every change).
export function useDemo(demoId: string | null) {
  const [demo, setDemo] = useState<Demo | null>(null);
  useEffect(() => {
    setDemo(null);
    if (!demoId) return;
    return subscribe(`demo:${demoId}`, (d: Demo | null) => setDemo(d));
  }, [demoId]);
  return demo;
}

// Polls the thread list (titles change when the agent starts a demo).
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => load().then((v) => live && setValue(v)).catch(() => {});
    tick();
    const timer = setInterval(tick, ms);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
