import { Toaster } from 'react-hot-toast'

/**
 * Toast notifications — CORSA brand colors
 */
export function ToastProvider() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 4000,
        style: {
          fontFamily: "'IBM Plex Sans', sans-serif",
          fontSize: 14,
          borderRadius: 6,
        },
        success: {
          style: {
            background: '#E4F5EE',
            color: '#157A52',
            border: '1px solid #1E9E6B',
          },
          iconTheme: { primary: '#157A52', secondary: '#E4F5EE' },
        },
        error: {
          style: {
            background: '#FBE7E7',
            color: '#B23232',
            border: '1px solid #E24B4B',
          },
          iconTheme: { primary: '#B23232', secondary: '#FBE7E7' },
        },
      }}
    />
  )
}
