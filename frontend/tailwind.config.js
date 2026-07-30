/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic surface/text tokens are driven by CSS variables (see
        // src/index.css) so they flip between the dark and light themes.
        // Channels are stored as `R G B` triplets → rgb(var(--token) / <alpha>)
        // keeps Tailwind opacity modifiers (bg-panel/70, text-ink/90) working.
        obsidian: "rgb(var(--c-obsidian) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        elevated: "rgb(var(--c-elevated) / <alpha-value>)",
        raised: "rgb(var(--c-raised) / <alpha-value>)",
        hairline: "rgb(var(--c-hairline) / <alpha-value>)",
        "hairline-strong": "rgb(var(--c-hairline-strong) / <alpha-value>)",
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        faint: "rgb(var(--c-faint) / <alpha-value>)",
        // The single bold accent: compass brass (deepened for light mode).
        brass: {
          DEFAULT: "rgb(var(--c-brass) / <alpha-value>)",
          bright: "rgb(var(--c-brass-bright) / <alpha-value>)",
          dim: "rgb(var(--c-brass-dim) / <alpha-value>)",
          wash: "rgb(var(--c-brass) / 0.10)",
        },
        // Functional live/streaming signal only
        signal: {
          DEFAULT: "rgb(var(--c-signal) / <alpha-value>)",
          dim: "rgb(var(--c-signal-dim) / <alpha-value>)",
        },
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        success: "rgb(var(--c-success) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
      },
      fontWeight: {
        400: "400",
        500: "500",
        600: "600",
        700: "700",
        800: "800",
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', "system-ui", "sans-serif"],
        sans: ['"Hanken Grotesk"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
      },
      boxShadow: {
        console: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 12px 40px -12px rgba(0,0,0,0.7)",
        glow: "0 0 0 1px rgba(199,165,89,0.35), 0 0 24px -6px rgba(199,165,89,0.35)",
        "glow-signal": "0 0 0 1px rgba(45,212,191,0.35), 0 0 24px -6px rgba(45,212,191,0.35)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "token-in": {
          "0%": { opacity: "0", filter: "blur(2px)" },
          "100%": { opacity: "1", filter: "blur(0)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.9)", opacity: "0.7" },
          "70%": { transform: "scale(1.6)", opacity: "0" },
          "100%": { opacity: "0" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.4s cubic-bezier(0.22,1,0.36,1) both",
        "fade-in": "fade-in 0.3s ease both",
        "token-in": "token-in 0.25s ease both",
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.22,1,0.36,1) infinite",
        sweep: "sweep 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
