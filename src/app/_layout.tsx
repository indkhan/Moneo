import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { FinanceDataProvider } from '@/components/finance-data-provider';

export default function RootLayout() {
  return <FinanceDataProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false, animation: 'fade' }} /></FinanceDataProvider>;
}
