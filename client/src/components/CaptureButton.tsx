import { useRef, useState } from 'react';
import { uploadImages } from '../api/client';

interface Props {
  onCapture: () => void;
}

export function CaptureButton({ onCapture }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setMenuOpen(false);

    try {
      await uploadImages(Array.from(files));
      onCapture();
    } catch (err) {
      alert('Upload failed. Please try again.');
    } finally {
      setUploading(false);
      // Reset file inputs so the same file can be re-selected
      if (cameraRef.current) cameraRef.current.value = '';
      if (galleryRef.current) galleryRef.current.value = '';
    }
  };

  return (
    <>
      {/* Backdrop */}
      {menuOpen && <div className="fab-backdrop" onClick={() => setMenuOpen(false)} />}

      <div className="fab-container">
        {/* Mini action buttons */}
        {menuOpen && (
          <div className="fab-menu">
            <button
              className="fab-option"
              onClick={() => cameraRef.current?.click()}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 6.5A1.5 1.5 0 013.5 5h2.382a1 1 0 00.894-.553l.448-.894A1 1 0 018.118 3h3.764a1 1 0 01.894.553l.448.894A1 1 0 0014.118 5H16.5A1.5 1.5 0 0118 6.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 14.5v-8z" strokeLinejoin="round" />
                <circle cx="10" cy="10.5" r="3" />
              </svg>
              <span>Camera</span>
            </button>
            <button
              className="fab-option"
              onClick={() => galleryRef.current?.click()}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="16" height="14" rx="2" />
                <circle cx="7" cy="8" r="1.5" />
                <path d="M2 14l4-4 3 3 3-4 6 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Photo Library</span>
            </button>
          </div>
        )}

        {/* Main FAB */}
        <button
          className={`fab-main ${uploading ? 'fab-uploading' : ''}`}
          onClick={() => !uploading && setMenuOpen(!menuOpen)}
          disabled={uploading}
        >
          {uploading ? (
            <div className="loading-spinner loading-spinner-sm" />
          ) : menuOpen ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => handleFiles(e.target.files)}
        hidden
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        hidden
      />
    </>
  );
}
