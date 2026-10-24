import { type ReactNode, Suspense, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/Dashboard';
import Customers from '@/pages/Customers';
import CustomerDetail from '@/pages/CustomerDetail';
import Reminders from '@/pages/Reminders';
import Calls from '@/pages/Calls';
import Consultations from '@/pages/Consultations';
import CallbackRequests from '@/pages/CallbackRequests';
import LoanPlans from '@/pages/LoanPlans';
import LoanApplications from '@/pages/LoanApplications';
import LoanApplicationDetail from '@/pages/LoanApplicationDetail';
import Users from '@/pages/Users';
import Contracts from '@/pages/Contracts';
import NotificationSettingsPage from '@/pages/NotificationSettings';
import WalletManagement from '@/pages/WalletManagement';
import { CrmShell } from '@/components/CrmShell';
import LoginPage from '@/pages/Login';
import PhonePage from '@/pages/Phone';
import Releases from '@/pages/Releases';
import WalletTopUp from '@/pages/WalletTopUp';
import GoodsPurchases from '@/pages/GoodsPurchases';
import GoodsPurchaseDetail from '@/pages/GoodsPurchaseDetail';
import PaymentOrders from '@/pages/PaymentOrders';
import BankAccounts from '@/pages/BankAccounts';
import Accounting from '@/pages/Accounting';
import SalesCommissions from '@/pages/SalesCommissions';
import StaffWallet from '@/features/staff-wallet/StaffWallet';
import ManualVerifications from '@/pages/ManualVerifications';
import CreditRankOverrides from '@/pages/CreditRankOverrides';
import InstagramInbox from '@/pages/InstagramInbox';
import MessengersPage from '@/pages/Messengers';
import { SocialMonitorReports } from '@/features/SocialMonitorReports';
import '@/features/social-monitor-reports.css';
import { VoipProvider } from '@/components/voip/VoipProvider';
import { AfterCallPopup } from '@/components/voip/AfterCallPopup';
import MobileCalls from '@/pages/MobileCalls';
import SalesReports from '@/pages/SalesReports';
import { VoipDock } from '@/components/voip/VoipDock';
import StaffChatPage from '@/chat/StaffChatPage';
import InternalChatPage from '@/internal-chat/InternalChatPage';
import CustomerPortal from '@/customer-portal/Portal';
import { PageLoaderBridge, PageLoaderSuspense } from '@/lib/page-loader/PageLoaderBridge';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from 'wouter';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';

const queryClient = new QueryClient();
// Retain list preferences until logout/auth change clears this client.
queryClient.setQueryDefaults(['table-view-state'], { gcTime: Infinity });

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function AuthStateQueryClientCacheInvalidator({ userId }: { userId: number | undefined | null }) {
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (
      prevUserIdRef.current !== undefined &&
      prevUserIdRef.current !== userId
    ) {
      queryClient.clear();
    }
    prevUserIdRef.current = userId;
  }, [userId, queryClient]);

  return null;
}

function LoadingSplash() {
  return (
    <div className="min-h-[100dvh] bg-[#f3f5f8] flex flex-col items-center justify-center font-sans relative overflow-hidden" dir="rtl">
      <img
        src={`${import.meta.env.BASE_URL}nafiss-financial-logo.png`}
        alt="گروه مالی نفیس"
        className="w-48 h-auto object-contain animate-pulse"
      />
    </div>
  );
}

function HomeRoute() {
  const { data: session, isLoading } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });

  if (isLoading) return <LoadingSplash />;
  
  if (session?.user) {
    const permissions = session.user.permissions ?? [];
    if (session.user.role !== 'admin' && !permissions.includes('dashboard.view')) {
      const firstAllowed = [
        ['customers.view', '/customers'],
        ['reminders.view', '/reminders'],
        ['calls.view', '/calls'],
        ['consultations.view', '/consultations'],
        ['loan_plans.view', '/loan-plans'],
        ['goods_purchases.view', '/goods-purchases'],
        ['payment_orders.view', '/payment-orders'],
        ['goods_finance.view', '/sales-commissions'],
        ['reports.view', '/sales-reports'],
        ['bank_accounts.view', '/bank-accounts'],
        ['accounting.view', '/accounting'],
        ['contracts.view', '/contracts'],
        ['users.view', '/users'],
        ['notifications.view', '/settings/notifications'],
      ].find(([permission]) => permissions.includes(permission));
      return <Redirect to={firstAllowed?.[1] ?? '/login'} />;
    }
    return (
      <CrmShell>
        <Dashboard />
      </CrmShell>
    );
  }
  
  return <Redirect to="/login" />;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { data: session, isLoading } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });

  if (isLoading) return <LoadingSplash />;

  if (session?.user) {
    return <>{children}</>;
  }

  return <Redirect to="/login" />;
}

function AdminOnlyRoute({ children }: { children: ReactNode }) {
  const { data: session, isLoading } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  if (isLoading) return <LoadingSplash />;
  if (!session?.user) return <Redirect to="/login" />;
  if (session.user.role !== 'admin') return <Redirect to="/" />;
  return <>{children}</>;
}

function PermissionRoute({ permission, children }: { permission: string | string[]; children: ReactNode }) {
  const { data: session, isLoading } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  if (isLoading) return <LoadingSplash />;
  if (!session?.user) return <Redirect to="/login" />;
  const needed = Array.isArray(permission) ? permission : [permission];
  if (session.user.role !== 'admin' && !needed.some((p) => session.user.permissions?.includes(p))) return <Redirect to="/" />;
  return <>{children}</>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function AppWithRoutes() {
  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  
  return (
    <>
      <AuthStateQueryClientCacheInvalidator userId={session?.user?.id} />
      <TooltipProvider>
        <VoipProvider>
          <AfterCallPopup />
          <Switch>
            <Route path="/" component={HomeRoute} />
            <Route path="/login" component={LoginPage} />
            <Route path="/wallet/top-up/result" component={WalletTopUp} />
            <Route path="/wallet/top-up" component={WalletTopUp} />
            <Route path={/^\/~[A-Za-z0-9_-]{14}\/?$/} component={WalletTopUp} />
            
            <Route>
              <ProtectedRoute>
                <RoutedErrorBoundary>
                  <CrmShell>
                    <Switch>
                      <Route path="/chat"><PermissionRoute permission="customers.view"><StaffChatPage /></PermissionRoute></Route>
                      <Route path="/internal-chat"><PermissionRoute permission="internal_chat.use"><InternalChatPage /></PermissionRoute></Route>
                      <Route path="/customers"><PermissionRoute permission="customers.view"><Customers /></PermissionRoute></Route>
                      <Route path="/mobile-calls"><PermissionRoute permission="calls.view"><MobileCalls /></PermissionRoute></Route>
                      <Route path="/customers/:id"><PermissionRoute permission="customers.view"><CustomerDetail /></PermissionRoute></Route>
                      <Route path="/wallet-management"><PermissionRoute permission={['wallets.view', 'payment_orders.pay']}><WalletManagement /></PermissionRoute></Route>
                      <Route path="/reminders"><PermissionRoute permission="reminders.view"><Reminders /></PermissionRoute></Route>
                      <Route path="/calls"><PermissionRoute permission="calls.view"><Calls /></PermissionRoute></Route>
                      <Route path="/instagram-inbox"><InstagramInbox /></Route>
                      <Route path="/phone"><PermissionRoute permission="calls.view"><PhonePage /></PermissionRoute></Route>
                      <Route path="/consultations"><PermissionRoute permission="consultations.view"><Consultations /></PermissionRoute></Route>
                      <Route path="/callback-requests"><PermissionRoute permission="callbacks.view"><CallbackRequests /></PermissionRoute></Route>
                    <Route path="/loan-plans"><PermissionRoute permission="loan_plans.view"><LoanPlans /></PermissionRoute></Route>
                    <Route path="/loan-applications"><PermissionRoute permission="loan_applications.view"><LoanApplications /></PermissionRoute></Route>
                    <Route path="/loan-applications/:id"><PermissionRoute permission="loan_applications.view"><LoanApplicationDetail /></PermissionRoute></Route>
                    <Route path="/goods-purchases"><PermissionRoute permission="goods_purchases.view"><GoodsPurchases /></PermissionRoute></Route>
                    <Route path="/goods-purchases/:id"><PermissionRoute permission="goods_purchases.view"><GoodsPurchaseDetail /></PermissionRoute></Route>
                    <Route path="/payment-orders"><PermissionRoute permission="payment_orders.view"><PaymentOrders /></PermissionRoute></Route>
                    <Route path="/payment-orders/:id"><PermissionRoute permission="payment_orders.view"><PaymentOrders /></PermissionRoute></Route>
                    <Route path="/bank-accounts"><PermissionRoute permission={['bank_accounts.view', 'bank_accounts.manage']}><BankAccounts /></PermissionRoute></Route>
                    <Route path="/accounting"><PermissionRoute permission="accounting.view"><Accounting /></PermissionRoute></Route>
                    <Route path="/sales-reports"><PermissionRoute permission="reports.view"><SalesReports /></PermissionRoute></Route>
                    <Route path="/sales-commissions"><PermissionRoute permission="goods_finance.view"><SalesCommissions /></PermissionRoute></Route>
                    <Route path="/my-wallet"><PermissionRoute permission="goods_finance.view"><StaffWallet /></PermissionRoute></Route>
                    <Route path="/messengers"><PermissionRoute permission="internal_chat.use"><MessengersPage /></PermissionRoute></Route>
                     <Route path="/manual-verifications"><AdminOnlyRoute><ManualVerifications /></AdminOnlyRoute></Route>
                    <Route path="/credit-rank-overrides"><AdminOnlyRoute><CreditRankOverrides /></AdminOnlyRoute></Route>
                    <Route path="/contracts"><PermissionRoute permission="contracts.view"><Contracts /></PermissionRoute></Route>
                    <Route path="/users">
                      <PermissionRoute permission="users.view"><Users /></PermissionRoute>
                    </Route>
                    <Route path="/settings/notifications">
                      <PermissionRoute permission="notifications.view"><NotificationSettingsPage /></PermissionRoute>
                    </Route>
                    <Route path="/social-monitor-reports">
                      <AdminOnlyRoute><SocialMonitorReports /></AdminOnlyRoute>
                    </Route>
                    <Route path="/settings/releases">
                      <AdminOnlyRoute><Releases /></AdminOnlyRoute>
                    </Route>
                    <Route component={NotFound} />
                  </Switch>
                </CrmShell>
              </RoutedErrorBoundary>
            </ProtectedRoute>
          </Route>
        </Switch>
        <VoipDock />
        </VoipProvider>
        <Toaster />
      </TooltipProvider>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={basePath}>
        {/* Full-screen loader on route changes that wait on data / lazy chunks (portal + staff); see PageLoaderBridge */}
        <PageLoaderBridge />
        <Suspense fallback={<PageLoaderSuspense />}>
          <AppEntry />
        </Suspense>
      </WouterRouter>
    </QueryClientProvider>
  );
}

function AppEntry() {
  const [location] = useLocation();
  // Customer auth is isolated from staff session, permission checks, shell and VoIP.
  return location === '/customer' || location.startsWith('/customer/')
    ? <CustomerPortal />
    : <AppWithRoutes />;
}

export default App;