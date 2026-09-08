

interface ClipButtonProps {
  label: string
  onClick?: () => void
  size?: 'normal' | 'large'
  disabled?: boolean
  id?: string
}

/**
 * Botón naranja con clip-path diagonal — identidad visual CORSA
 */
export function ClipButton({ label, onClick, size = 'normal', disabled, id }: ClipButtonProps) {
  return (
    <div
      className="clip-btn-wrap"
      style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
    >
      <div className="clip-btn-corner"/>
      <button
        id={id}
        className={`clip-btn${size === 'large' ? ' large' : ''}`}
        onClick={onClick}
        disabled={disabled}
      >
        {label}
      </button>
    </div>
  )
}
