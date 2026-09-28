import { useParams, useNavigate } from 'react-router-dom';
import { ReceiptReviewForm } from '../receipts/ReceiptReviewForm';

export function ReceiptReview() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  if (!id) return null;

  return (
    <ReceiptReviewForm
      key={id}
      id={id}
      headerTitle="Receipt"
      onBack={() => navigate(-1)}
      onSaved={() => navigate('/', { replace: true })}
    />
  );
}
