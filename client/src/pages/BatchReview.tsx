import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { listReceipts } from '../api/client';
import { ReceiptReviewForm } from '../components/ReceiptReviewForm';

const SWIPE_THRESHOLD = 70;

export function BatchReview() {
  const navigate = useNavigate();
  const [ids, setIds] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    listReceipts()
      .then((groups) => {
        const flat = groups.flatMap((g) => g.receipts);
        const reviewable = flat
          .filter((r) => r.status === 'captured' || r.status === 'extracted')
          .map((r) => r.id);
        setIds(reviewable);
      })
      .catch(() => setIds([]));
  }, []);

  const goNext = () => setIndex((i) => i + 1);
  const goPrev = () => setIndex((i) => Math.max(0, i - 1));

  const handleTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchEnd = (e: TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) goNext();
      else goPrev();
    }
  };

  if (ids === null) {
    return (
      <div className="review-page">
        <div className="loading-screen"><div className="loading-spinner" /></div>
      </div>
    );
  }

  if (ids.length === 0 || index >= ids.length) {
    return (
      <div className="review-page">
        <div className="batch-done">
          <p className="empty-title">All caught up</p>
          <p className="empty-subtitle">Every receipt has been reviewed.</p>
          <button className="btn-primary" onClick={() => navigate('/', { replace: true })}>
            Back to Receipts
          </button>
        </div>
      </div>
    );
  }

  const currentId = ids[index];

  return (
    <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <ReceiptReviewForm
        key={currentId}
        id={currentId}
        headerTitle="Review Receipt"
        headerRight={
          <span className="batch-progress">
            {index + 1} of {ids.length}
          </span>
        }
        onBack={() => navigate('/', { replace: true })}
        onApproved={goNext}
      />
      <div className="review-content" style={{ paddingTop: 0 }}>
        <div className="batch-nav">
          <button className="btn-secondary" onClick={goPrev} disabled={index === 0}>
            ← Previous
          </button>
          <button className="btn-secondary" onClick={goNext}>
            Skip →
          </button>
        </div>
      </div>
    </div>
  );
}
