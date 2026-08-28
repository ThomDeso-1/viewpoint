import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'vp_hide_add_home_tip';

function isMobile(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function isIOS(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function AddToHomeScreenTip() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isMobile() && !isStandalone() && !localStorage.getItem(DISMISSED_KEY)) {
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="banner banner-tip home-screen-tip">
      <span>
        {isIOS()
          ? "Tip: tap the Share button below, then \"Add to Home Screen\" — it's faster than opening Safari every time."
          : 'Tip: open your browser menu and choose "Add to Home Screen" — it\'s faster than opening your browser every time.'}
      </span>
      <button className="home-screen-tip-dismiss" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
