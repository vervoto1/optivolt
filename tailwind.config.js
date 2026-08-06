// Mirrors the inline `tailwind.config` the Play CDN build used in
// index.html. `npm run build:css` compiles app/vendor/tailwind.css from it —
// re-run after adding new Tailwind classes anywhere under app/.
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/index.html", "./app/main.js", "./app/src/**/*.js"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        card: { DEFAULT: "#ffffff", dark: "#111827" },
        ink: { DEFAULT: "#0f172a", soft: "#475569" },
      },
      boxShadow: {
        soft: "0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06)",
      },
      borderRadius: { pill: "9999px" },
    },
  },
};
