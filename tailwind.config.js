/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        wine: '#5a1d2c',
        burgundy: '#2d1018',
        plum: '#120d0f',
        cream: '#503107',
        champagne: '#d9c09c',
        ember: '#b9895a',
        mist: '#cab79d',
      },
      boxShadow: {
        luxury: '0 30px 80px rgba(0,0,0,0.35)',
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', 'serif'],
        sans: ['Inter', 'sans-serif'],
      },
      backgroundImage: {
        'hero-glow': 'radial-gradient(circle at top, rgba(154, 80, 94, 0.35), transparent 48%)',
      },
      animation: {
        'fade-slow': 'fadeUp 1s ease-out both',
        'float-soft': 'floatSoft 7s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        floatSoft: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      },
    },
  },
  plugins: [],
}
