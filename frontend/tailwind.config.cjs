const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "src/**/*.{js,jsx}"),
  ],
  theme: {
    extend: {
      colors: {
        codex: {
          bg: "#0d0f12",
          panel: "#14171b",
          panel2: "#171a1f",
          border: "#262a31",
          text: "#e6e8ec",
          muted: "#9aa3b2",
          accent: "#2f7df6",
        },
      },
      boxShadow: {
        panel: "0 8px 30px rgba(0,0,0,0.35)",
      },
    },
  },
  plugins: [],
};
