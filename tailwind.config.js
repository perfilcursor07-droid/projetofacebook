/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/views/**/*.ejs', './public/**/*.js'],
  theme: {
    extend: {
      maxWidth: {
        '8xl': '88rem',
      },
      fontFamily: {
        sans: ['Segoe UI', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
