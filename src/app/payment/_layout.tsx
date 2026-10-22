import { Stack } from 'expo-router';

export default function PaymentLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: 'Quay lại',
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#007AFF',
      }}
    >
      <Stack.Screen name="[id]" options={{ title: 'Chi tiết thanh toán' }} />
    </Stack>
  );
}
