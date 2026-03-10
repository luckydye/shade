/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#1e1e1e",
        toolbar: "#2d2d2d",
        accent: "#3b82f6",
      },
    },
  },
  plugins: [],
};
