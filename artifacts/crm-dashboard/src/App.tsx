import { type ReactNode, useEffect, useRef } from 'react';
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
import LoanPlans from '@/pages/LoanPlans';
import LoanApplications from '@/pages/LoanApplications';
import LoanApplicationDetail from '@/pages/LoanApplicationDetail';
import Users from '@/pages/Users';
import Contracts from '@/pages/Contracts';
import NotificationSettingsPage from '@/pages/NotificationSettings';
import { CrmShell } from '@/components/CrmShell';
import LoginPage from '@/pages/Login';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from 'wouter';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';

const queryClient = new QueryClient();

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

function PermissionRoute({ permission, children }: { permission: string; children: ReactNode }) {
  const { data: session, isLoading } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  if (isLoading) return <LoadingSplash />;
  if (!session?.user) return <Redirect to="/login" />;
  if (session.user.role !== 'admin' && !session.user.permissions?.includes(permission)) return <Redirect to="/" />;
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
        <Switch>
          <Route path="/" component={HomeRoute} />
          <Route path="/login" component={LoginPage} />
          
          <Route>
            <ProtectedRoute>
              <RoutedErrorBoundary>
                <CrmShell>
                  <Switch>
                    <Route path="/customers"><PermissionRoute permission="customers.view"><Customers /></PermissionRoute></Route>
                    <Route path="/customers/:id"><PermissionRoute permission="customers.view"><CustomerDetail /></PermissionRoute></Route>
                    <Route path="/reminders"><PermissionRoute permission="reminders.view"><Reminders /></PermissionRoute></Route>
                    <Route path="/calls"><PermissionRoute permission="calls.view"><Calls /></PermissionRoute></Route>
                    <Route path="/consultations"><PermissionRoute permission="consultations.view"><Consultations /></PermissionRoute></Route>
                    <Route path="/loan-plans"><PermissionRoute permission="loan_plans.view"><LoanPlans /></PermissionRoute></Route>
                    <Route path="/loan-applications"><PermissionRoute permission="loan_applications.view"><LoanApplications /></PermissionRoute></Route>
                    <Route path="/loan-applications/:id"><PermissionRoute permission="loan_applications.view"><LoanApplicationDetail /></PermissionRoute></Route>
                    <Route path="/contracts"><PermissionRoute permission="contracts.view"><Contracts /></PermissionRoute></Route>
                    <Route path="/users">
                      <PermissionRoute permission="users.view"><Users /></PermissionRoute>
                    </Route>
                    <Route path="/settings/notifications">
                      <PermissionRoute permission="notifications.view"><NotificationSettingsPage /></PermissionRoute>
                    </Route>
                    <Route component={NotFound} />
                  </Switch>
                </CrmShell>
              </RoutedErrorBoundary>
            </ProtectedRoute>
          </Route>
        </Switch>
        <Toaster />
      </TooltipProvider>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={basePath}>
        <AppWithRoutes />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;