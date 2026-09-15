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
          fontFamily: "var(--font-body)",
          fontSize: 14,
          borderRadius: 12,
        },
        success: {
          style: {
            background: 'var(--color-success-tint)',
            color: 'var(--color-success-text)',
            border: '1px solid #1E9E6B',
          },
          iconTheme: { primary: 'var(--color-success-text)', secondary: 'var(--color-success-tint)' },
        },
        error: {
          style: {
            background: 'var(--color-danger-tint)',
            color: 'var(--color-danger-text)',
            border: '1px solid #E24B4B',
          },
          iconTheme: { primary: 'var(--color-danger-text)', secondary: 'var(--color-danger-tint)' },
        },
      }}
    />
  )
}
