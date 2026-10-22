import { Stack } from 'expo-router';

export default function AccountLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#f2f2f7' },
        headerTintColor: '#007AFF',
        headerTitleStyle: { color: '#1a1a1a', fontWeight: '600' },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="profile" options={{ title: 'Hồ sơ' }} />
      <Stack.Screen name="security" options={{ title: 'Bảo mật' }} />
      <Stack.Screen name="privacy" options={{ title: 'Quyền riêng tư' }} />
    </Stack>
  );
}
