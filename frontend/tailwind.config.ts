import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f2f1ff",
          100: "#e6e4ff",
          200: "#cfcbff",
          300: "#a8a0ff",
          400: "#8b7bff",
          500: "#6c4fff",
          600: "#5433f0",
          700: "#4426c4",
          800: "#38209c",
          900: "#2e1c7d",
          950: "#1b1050",
        },
        accent: {
          50: "#effefb",
          100: "#c8fff2",
          200: "#93ffe6",
          300: "#54f5d6",
          400: "#22ddbf",
          500: "#0bbfa4",
          600: "#059885",
          700: "#08796b",
          800: "#0b6056",
          900: "#0d4f48",
        },
        surface: {
          light: "#ffffff",
          subtle: "#f6f5fb",
          dark: "#0f0e17",
          "dark-subtle": "#171625",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      borderRadius: {
        xl2: "1.25rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
