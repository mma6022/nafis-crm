import { useState } from 'react';
import { useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLogin, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
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
    <div className="min-h-[100dvh] bg-[#f8fafc] flex flex-col items-center justify-center px-4 py-8 font-sans relative overflow-hidden" dir="rtl">
      <div className="absolute inset-0 z-0 pointer-events-none opacity-[0.4]" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '30px 30px' }} />
      
      <div className="mb-8 text-center relative z-10 flex flex-col items-center">
        <div className="h-16 mb-5 flex items-center justify-center">
          <img src={nafissLogoUrl} alt="گروه مالی نفیس" className="h-full w-auto object-contain drop-shadow-sm" />
        </div>
        <h1 className="text-xl font-black text-[#0f172a] tracking-tight flex items-center gap-2">
          گروه مالی نفیس 
          <span className="text-[#94a3b8] font-normal text-2xl mx-1">|</span> 
          پنل مدیریت مشتریان
        </h1>
      </div>
      
      <div className="relative z-10 w-full max-w-[400px]">
        <div className="bg-white rounded-2xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-[#e2e8f0] p-6 sm:p-8">
          <div className="mb-6">
            <h2 className="font-black text-[#0f172a] text-xl mb-1">ورود به سیستم</h2>
            <p className="text-[#64748b] text-sm">برای دسترسی به فضای کاری وارد شوید</p>
          </div>

          {errorMsg && (
            <div className="bg-[#fff1f2] border border-[#fecdd3] rounded-xl p-4 text-right mb-6 text-[#be123c] text-sm font-medium" data-testid="error-login">
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
                        className="border border-[#e2e8f0] bg-[#f8fafc] text-[#0f172a] focus:border-[#1c3687] focus:ring-2 focus:ring-[#1c3687]/10 rounded-xl h-11 px-4 text-left transition-all outline-none"
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
                        className="border border-[#e2e8f0] bg-[#f8fafc] text-[#0f172a] focus:border-[#1c3687] focus:ring-2 focus:ring-[#1c3687]/10 rounded-xl h-11 px-4 text-left transition-all outline-none"
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
                className="w-full mt-2 bg-[#1c3687] hover:bg-[#152b6e] text-white shadow-[0_4px_12px_rgba(28,54,135,0.15)] hover:shadow-[0_6px_16px_rgba(28,54,135,0.2)] hover:-translate-y-[1px] font-bold rounded-xl h-11 transition-all text-sm disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none"
                disabled={loginMutation.isPending}
                data-testid="button-submit-login"
              >
                {loginMutation.isPending ? 'در حال ورود...' : 'ورود'}
              </button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}