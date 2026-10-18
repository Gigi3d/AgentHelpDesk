/** Tokens come straight from the Frontend Plan's visual system table. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: '#FFFFFF',
        surface: '#F7F8FA',
        line: '#E6E8EE',
        ink: '#111827',
        muted: '#5B6475',
        blue: { DEFAULT: '#2554F5', tint: '#EAF0FF', text: '#1D4ED8' },
        pink: { DEFAULT: '#E6007A', bright: '#FF2D87', tint: '#FFE8F3', text: '#B8005F', hover: '#C8006A' },
        // The DEFAULT steps are 4.4:1 on white, so they are for large text, icons and fills.
        // Small text uses the darker -text step: success-text 6.3:1, error-text 5.8:1 on its tint.
        success: { DEFAULT: '#0F8A5F', text: '#0B6E4B', tint: '#E7F6EF' },
        warning: { DEFAULT: '#B45309', tint: '#FEF3E2' },
        error: { DEFAULT: '#D92D20', text: '#B42318', tint: '#FDECEA' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        label: ['12px', { lineHeight: '16px', letterSpacing: '0.04em' }],
        table: ['14px', '20px'],
        body: ['15px', '22px'],
        title: ['28px', { lineHeight: '34px', letterSpacing: '-0.01em' }],
      },
      borderRadius: { ctl: '8px', card: '12px' },
      boxShadow: { pop: '0 8px 28px rgba(17,24,39,.12), 0 1px 3px rgba(17,24,39,.08)' },
      keyframes: {
        pulsering: { '0%': { boxShadow: '0 0 0 0 rgba(37,84,245,.45)' }, '100%': { boxShadow: '0 0 0 10px rgba(37,84,245,0)' } },
        wake: { '0%': { opacity: '0', transform: 'scale(.55)' }, '60%': { opacity: '1', transform: 'scale(1.12)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        flow: { '0%': { backgroundPosition: '0 0' }, '100%': { backgroundPosition: '16px 0' } },
        fadein: { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { pulsering: 'pulsering 1.4s ease-out infinite', fadein: 'fadein 140ms ease-out', wake: 'wake 420ms cubic-bezier(.2,.8,.2,1) both', flow: 'flow .7s linear infinite' },
    },
  },
  plugins: [],
};
