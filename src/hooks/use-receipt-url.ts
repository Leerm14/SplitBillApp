import { useQuery } from '@tanstack/react-query';

import { getReceiptUrl, RECEIPT_URL_TTL_SECONDS } from '@/api/expenses';

/**
 * MVP-01: Signed URL ngắn hạn của ảnh hóa đơn. Làm mới trước khi hết hạn; không lưu vào cache bền
 * (query-persister bỏ qua khóa 'receipt-url').
 */
export function useReceiptUrl(receiptPath: string | null | undefined) {
  return useQuery({
    queryKey: ['receipt-url', receiptPath],
    queryFn: () => getReceiptUrl(receiptPath!),
    enabled: !!receiptPath,
    staleTime: (RECEIPT_URL_TTL_SECONDS - 60) * 1000,
    gcTime: (RECEIPT_URL_TTL_SECONDS - 30) * 1000,
    retry: 1,
  });
}
