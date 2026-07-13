/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/views/**/*.ejs', './public/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Segoe UI', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
