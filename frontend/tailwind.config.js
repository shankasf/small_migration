/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sidebar: {
          bg: '#f9fafb',
          hover: '#f3f4f6',
          border: '#e5e7eb',
        },
        chat: {
          user: '#2563eb',
          assistant: '#f1f5f9',
        },
      },
    },
  },
  plugins: [],
};
