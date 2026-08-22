import { useParams, useNavigate } from 'react-router-dom';
import { ReceiptReviewForm } from '../components/ReceiptReviewForm';

export function ReceiptReview() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  if (!id) return null;

  return (
    <ReceiptReviewForm
      key={id}
      id={id}
      headerTitle="Review Receipt"
      onBack={() => navigate(-1)}
      onApproved={() => navigate('/', { replace: true })}
    />
  );
}
