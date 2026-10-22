import { Stack } from 'expo-router';

export default function ExpenseLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: 'Quay lại',
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#007AFF',
      }}
    >
      <Stack.Screen name="[expenseId]" options={{ title: 'Chi tiết khoản chi' }} />
      <Stack.Screen name="[expenseId]/edit" options={{ title: 'Sửa khoản chi', presentation: 'modal' }} />
    </Stack>
  );
}
