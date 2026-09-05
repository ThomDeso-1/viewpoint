import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { listReceipts } from '../shared/api';
import { ReceiptReviewForm } from '../receipts/ReceiptReviewForm';
import { Screen } from '../ui/Screen';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';

const SWIPE_THRESHOLD = 70;

export function BatchReview() {
  const navigate = useNavigate();
  const [ids, setIds] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    listReceipts()
      .then((groups) => {
        const reviewable = groups
          .flatMap((g) => g.receipts)
          .filter((r) => r.status === 'captured' || r.status === 'extracted')
          .map((r) => r.id);
        setIds(reviewable);
      })
      .catch(() => setIds([]));
  }, []);

  const goNext = () => setIndex((i) => i + 1);
  const goPrev = () => setIndex((i) => Math.max(0, i - 1));

  // Keyboard: left / right arrows step through the queue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      <Screen width="read">
        <div className="loading-screen">
          <div className="loading-spinner" />
        </div>
      </Screen>
    );
  }

  if (ids.length === 0 || index >= ids.length) {
    return (
      <Screen width="read">
        <EmptyState icon="check" title="All caught up">
          Every receipt has been reviewed.
          <span className="vp-empty-action">
            <Button variant="primary" onClick={() => navigate('/', { replace: true })}>
              Back to Receipts
            </Button>
          </span>
        </EmptyState>
      </Screen>
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
          <span className="vp-batch-progress">
            {index + 1} of {ids.length}
          </span>
        }
        footer={
          <div className="vp-batch-nav">
            <Button variant="secondary" onClick={goPrev} disabled={index === 0}>
              ← Previous
            </Button>
            <Button variant="secondary" onClick={goNext}>
              Skip →
            </Button>
          </div>
        }
        onBack={() => navigate('/', { replace: true })}
        onApproved={goNext}
      />
    </div>
  );
}
