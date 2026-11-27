import { useEffect, useState, type CSSProperties } from 'react';
import { bridge } from './transport';

export function AttachmentImage({ path, alt, className, style, onPreview }: {
  path: string; alt: string; className?: string; style?: CSSProperties; onPreview: (src: string) => void;
}) {
  const [src, setSrc] = useState(path.startsWith('data:') ? path : '');
  useEffect(() => {
    if (path.startsWith('data:')) { setSrc(path); return; }
    let disposed = false;
    void bridge.call<string>('transport.resource', { path }).then(data => { if (!disposed) setSrc(data); }).catch(() => {});
    return () => { disposed = true; };
  }, [path]);
  return <img src={src || undefined} alt={alt} className={className} style={style} onClick={() => src && onPreview(src)} />;
}
