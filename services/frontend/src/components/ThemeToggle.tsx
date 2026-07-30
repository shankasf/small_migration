import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cx } from './ui';

type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

// Sun/moon theme switch. `variant="pill"` renders a labelled control for the
// expanded sidebar; `variant="icon"` is a bare square for rails / top bars.
export default function ThemeToggle({
  variant = 'icon',
  className,
}: {
  variant?: 'pill' | 'icon';
  className?: string;
}) {
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  const toggle = () => {
    const next: Theme = isDark ? 'light' : 'dark';
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(next);
    try {
      localStorage.setItem('circini_theme', next);
    } catch {
      /* storage unavailable — theme still flips for this page */
    }
    setTheme(next);
  };

  if (variant === 'pill') {
    return (
      <button
        onClick={toggle}
        title={label}
        aria-label={label}
        className={cx(
          'flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-panel px-2.5 py-2 text-[13px] font-500 text-muted transition-colors hover:border-hairline-strong hover:text-ink',
          className,
        )}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-elevated text-brass">
          {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </span>
        {isDark ? 'Light mode' : 'Dark mode'}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      className={cx(
        'rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-ink',
        className,
      )}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
