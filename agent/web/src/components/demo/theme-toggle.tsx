import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useIcons } from '@/lib/icon-context';

// Light / Dark / System, saved by next-themes (the D key still flips light and dark).
export function ThemeToggle() {
  const icons = useIcons();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const options = [
    { id: 'light', label: 'Light', Icon: icons.sun },
    { id: 'dark', label: 'Dark', Icon: icons.moon },
    { id: 'system', label: 'System', Icon: icons.monitor },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg border bg-background p-0.5">
      {options.map(({ id, label, Icon }) => {
        const active = mounted && theme === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => setTheme(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-xs transition-colors ${
              active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
