import { Stack } from 'expo-router';

export default function DebtsLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: 'Quay lại',
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#007AFF',
      }}
    >
      <Stack.Screen name="[userId]" options={{ title: 'Chi tiết công nợ' }} />
    </Stack>
  );
}
