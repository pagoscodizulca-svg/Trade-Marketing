import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  titulo: string;
  onClose: () => void;
  children: ReactNode;
  ancho?: string;
}

export function Modal({ titulo, onClose, children, ancho = 'max-w-lg' }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/60 p-0 sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className={`bg-white w-full ${ancho} max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl`}
      >
        <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-3 border-b border-zinc-200">
          <h2 className="text-lg font-black text-ink">{titulo}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="w-10 h-10 grid place-items-center rounded-lg hover:bg-zinc-100 text-zinc-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
