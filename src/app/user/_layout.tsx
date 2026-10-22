import { Stack } from 'expo-router';

export default function UserLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#f2f2f7' },
        headerTintColor: '#007AFF',
        headerTitleStyle: { color: '#1a1a1a', fontWeight: '600' },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="[id]" options={{ title: 'Hồ sơ' }} />
    </Stack>
  );
}
