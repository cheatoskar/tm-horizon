import { useEffect, type ReactNode } from 'react';
import { openOverlay } from './webLayer';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../i18n';

/** Renders overlays at the app root (.app keeps the TAS colours): a dialog opened from inside a card (which moves on hover, a CSS transform)
 * or inside the page's stacking context would otherwise be placed relative to that card, not the window. */
export const toBody = (node: ReactNode) => (typeof document === 'undefined' ? node : createPortal(node, document.querySelector('.app') ?? document.body));

/** A dialog over the app, centred in the window. The embedded browser hides itself while one is open (hub.confirm / hub.dialog). */
export function Modal({ title, onClose, children, actions, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  const t = useT();
  // The embedded browser hides while a dialog is open (it is a native view no HTML can cover).
  useEffect(() => openOverlay(), []);
  return toBody(
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="bbtn" aria-label={t('common.close')} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-text">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
  );
}
