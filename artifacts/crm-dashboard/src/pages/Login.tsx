import { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLogin, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import '@/customer-portal/portal.css';
import './login.css';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

const nafissLogoUrl = `${import.meta.env.BASE_URL}nafiss-financial-logo.png`;

const loginSchema = z.object({
  username: z.string().min(1, 'نام کاربری الزامی است'),
  password: z.string().min(1, 'رمز عبور الزامی است'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loginMutation = useLogin({
    mutation: {
      onSuccess: (data) => {
        // Optimistically set the auth session
        queryClient.setQueryData(getGetAuthSessionQueryKey(), data);
        setLocation('/');
      },
      onError: () => {
        setErrorMsg('نام کاربری یا رمز عبور اشتباه است.');
      }
    }
  });

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  const onSubmit = (data: LoginFormValues) => {
    setErrorMsg(null);
    loginMutation.mutate({ data });
  };

  return (
    <div className="cp cp-login staff-login" dir="rtl">
      <main className="cp-login-main">
        <div className="cp-login-panel">
          <img className="staff-login-logo" src={nafissLogoUrl} alt="نشان گروه مالی نفیس" />
          <h2>ورود به نفیس</h2>
          {errorMsg && (
            <div className="cp-alert" style={{ marginBottom: 16 }} role="alert" data-testid="error-login">
              {errorMsg}
            </div>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem className="flex flex-col text-right">
                    <FormLabel className="font-bold text-[#64748b] text-xs mb-1">نام کاربری</FormLabel>
                    <FormControl>
                      <input
                        {...field}
                        autoComplete="username"
                        className="cp-input-staff" style={{ width: "100%", minHeight: 44, padding: "10px 13px", borderRadius: 9, border: "1px solid #cad1dc", background: "#fffefa", color: "#192d55" }}
                        dir="ltr"
                        disabled={loginMutation.isPending}
                        data-testid="input-username"
                      />
                    </FormControl>
                    <FormMessage className="text-[#be123c] text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem className="flex flex-col text-right">
                    <FormLabel className="font-bold text-[#64748b] text-xs mb-1">رمز عبور</FormLabel>
                    <FormControl>
                      <input
                        type="password"
                        {...field}
                        autoComplete="current-password"
                        className="cp-input-staff" style={{ width: "100%", minHeight: 44, padding: "10px 13px", borderRadius: 9, border: "1px solid #cad1dc", background: "#fffefa", color: "#192d55" }}
                        dir="ltr"
                        disabled={loginMutation.isPending}
                        data-testid="input-password"
                      />
                    </FormControl>
                    <FormMessage className="text-[#be123c] text-xs" />
                  </FormItem>
                )}
              />

              <button
                type="submit"
                className="cp-btn cp-btn-primary"
                disabled={loginMutation.isPending}
                data-testid="button-submit-login"
              >
                {loginMutation.isPending ? 'در حال ورود...' : 'ورود'}
              </button>
            </form>
            <Link href="/customer/login" className="cp-link" style={{ display: "block", textAlign: "center", marginTop: 16 }} data-testid="link-customer-login">ورود مشتریان</Link>
          </Form>
    </div></main></div>
  );
}
