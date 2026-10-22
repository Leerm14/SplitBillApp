import { Stack } from 'expo-router';

export default function GroupLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: 'Quay lại',
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#007AFF',
      }}
    >
      <Stack.Screen name="new" options={{ title: 'Tạo nhóm', presentation: 'modal' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Chi tiết nhóm' }} />
      <Stack.Screen name="[id]/add-expense" options={{ title: 'Thêm khoản chi', presentation: 'modal' }} />
      <Stack.Screen name="[id]/pay" options={{ title: 'Gửi thanh toán', presentation: 'modal' }} />
      <Stack.Screen name="[id]/edit" options={{ title: 'Chỉnh sửa nhóm', presentation: 'modal' }} />
      <Stack.Screen name="[id]/members" options={{ title: 'Thành viên' }} />
      <Stack.Screen name="[id]/invite" options={{ title: 'Mời thành viên', presentation: 'modal' }} />
      <Stack.Screen name="[id]/expense" options={{ headerShown: false }} />
      <Stack.Screen name="[id]/debts" options={{ headerShown: false }} />
    </Stack>
  );
}
