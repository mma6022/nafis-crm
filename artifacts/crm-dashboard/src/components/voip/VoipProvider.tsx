import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';
import {
  Invitation, Inviter, Registerer, RegistererState, SessionState, UserAgent, Web, type Session,
} from 'sip.js';
import { lookupVoipContact, voipRequest, type VoipConfig, type VoipContact, type VoipCallEvent } from './voip-api';

export type LiveCall = {
  callId: string; phone: string; direction: 'incoming' | 'outgoing';
  status: 'ringing' | 'answering' | 'answered' | 'ending';
  startedAt: string; answeredAt?: string | null; customer?: VoipContact | null;
};
type Connection = 'disconnected' | 'connecting' | 'registered' | 'error';
type PhoneContext = {
  config: VoipConfig | undefined; isConfigLoading: boolean; configError: Error | null;
  refetchConfig: () => void; connection: Connection; connectionDetail: string; call: LiveCall | null;
  error: string; logError: string; muted: boolean; canCall: boolean;
  connect: (password: string) => Promise<void>; disconnect: () => Promise<void>;
  dial: (phone: string) => Promise<void>; answer: () => Promise<void>; reject: () => Promise<void>;
  hangup: () => Promise<void>; toggleMute: () => void; sendDtmf: (tone: string) => Promise<void>;
  clearError: () => void; retryLogs: () => Promise<void>;
};
const PhoneContext = createContext<PhoneContext | null>(null);
const timestamp = () => new Date().toISOString();

function dialNumber(value: string): string {
  return value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[\s()-]/g, '');
}
function eventFor(call: LiveCall, status: VoipCallEvent['status'], endedAt?: string): VoipCallEvent {
  return {
    callId: call.callId, direction: call.direction, phone: call.phone, status,
    startedAt: call.startedAt, answeredAt: call.answeredAt ?? null, endedAt: endedAt ?? null,
  };
}

export function VoipProvider({ children }: { children: ReactNode }) {
  const { data: auth } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const user = auth?.user;
  const canView = Boolean(user && (user.role === 'admin' || user.permissions?.includes('calls.view')));
  const canCall = Boolean(canView && (user?.role === 'admin' || user?.permissions?.includes('calls.create')));
  const qc = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['voip-config', user?.id], queryFn: () => voipRequest<VoipConfig>('/config'),
    enabled: canView, refetchInterval: 30000, retry: false,
  });
  const config = canView ? configQuery.data : undefined;
  const [connection, setConnection] = useState<Connection>('disconnected');
  const [connectionDetail, setConnectionDetail] = useState('اتصال این مرورگر به داخلی برقرار نیست.');
  const [call, setCall] = useState<LiveCall | null>(null);
  const [error, setError] = useState('');
  const [logError, setLogError] = useState('');
  const [muted, setMuted] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const ua = useRef<UserAgent | null>(null);
  const registerer = useRef<Registerer | null>(null);
  const activeSession = useRef<Session | null>(null);
  const activeCall = useRef<LiveCall | null>(null);
  const terminalStatus = useRef<VoipCallEvent['status'] | null>(null);
  const pending = useRef(new Map<string, VoipCallEvent>());
  const flushing = useRef(false);
  const epoch = useRef(0);
  const connected = useRef(false);
  const operationBusy = useRef(false);
  const registrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseTabLock = useRef<(() => void) | null>(null);
  const ringAudio = useRef<AudioContext | null>(null);

  function showCall(value: LiveCall | null) {
    activeCall.current = value;
    setCall(value);
  }
  async function retryLogs() {
    if (flushing.current || !pending.current.size) return;
    flushing.current = true;
    const generation = epoch.current;
    try {
      for (const [id, event] of pending.current) {
        await voipRequest('/calls', event, 'POST');
        if (generation !== epoch.current) return;
        if (pending.current.get(id) === event) pending.current.delete(id);
      }
      setLogError(pending.current.size ? 'ثبت آخرین وضعیت تماس هنوز کامل نشده است.' : '');
      await qc.invalidateQueries({ queryKey: ['voip-calls'] });
    } catch {
      if (generation === epoch.current) setLogError('سابقه تماس در CRM ذخیره نشد. این تب را نبندید و «تلاش دوباره» را بزنید.');
    } finally {
      flushing.current = false;
    }
  }
  function log(event: VoipCallEvent) {
    pending.current.set(event.callId, event);
    void retryLogs();
  }
  function finish(status?: VoipCallEvent['status']) {
    const value = activeCall.current;
    if (value) {
      log(eventFor(value, status ?? terminalStatus.current ?? (value.answeredAt ? 'completed' : value.direction === 'incoming' ? 'missed' : 'failed'), timestamp()));
    }
    activeSession.current = null;
    terminalStatus.current = null;
    showCall(null);
    setMuted(false);
    if (audio.current) audio.current.srcObject = null;
  }
  function bindSession(session: Session, value: LiveCall) {
    activeSession.current = session;
    terminalStatus.current = null;
    showCall(value);
    setMuted(false);
    log(eventFor(value, 'ringing'));
    void lookupVoipContact(value.phone).then(result => {
      if (activeCall.current?.callId === value.callId) showCall({ ...activeCall.current, customer: result.customer });
    }).catch(() => {
      // Caller ID remains visible; a lookup failure never exposes an unscoped customer.
    });
    session.stateChange.addListener(state => {
      if (activeSession.current !== session) return;
      if (state === SessionState.Established) {
        const current = activeCall.current;
        if (!current) return;
        const answered = { ...current, status: 'answered' as const, answeredAt: timestamp() };
        showCall(answered);
        log(eventFor(answered, 'answered'));
        const handler = session.sessionDescriptionHandler;
        if (handler instanceof Web.SessionDescriptionHandler && audio.current) {
          audio.current.srcObject = handler.remoteMediaStream;
          void audio.current.play().catch(() => setError('مرورگر پخش صدا را مسدود کرده است؛ دکمه پخش صدای تماس را بزنید.'));
        }
      }
      if (state === SessionState.Terminated) finish();
    });
  }
  async function stopConnection(finalState: Connection = 'disconnected') {
    connected.current = false;
    // Reflect failure immediately; SIP disposal may wait for an in-flight request.
    setConnection(finalState);
    setConnectionDetail(finalState === 'error'
      ? 'ثبت داخلی برقرار نیست؛ توضیح خطا را بررسی کنید.'
      : 'اتصال این مرورگر به داخلی برقرار نیست.');
    if (registrationTimer.current) clearTimeout(registrationTimer.current);
    registrationTimer.current = null;
    const previous = ua.current;
    const previousRegisterer = registerer.current;
    const release = releaseTabLock.current;
    const ringingContext = ringAudio.current;
    releaseTabLock.current = null;
    ringAudio.current = null;
    ua.current = null;
    registerer.current = null;
    if (activeSession.current) {
      const handler = activeSession.current.sessionDescriptionHandler;
      if (handler instanceof Web.SessionDescriptionHandler) {
        handler.localMediaStream.getTracks().forEach(track => track.stop());
      }
      finish(activeCall.current?.answeredAt ? 'completed' : 'failed');
    }
    // Ownership ends when local references/media are detached, not when the
    // SIP SDK's graceful transaction/socket shutdown eventually finishes.
    // A rejected registration must be retryable even if teardown is delayed.
    release?.();
    void ringingContext?.close().catch(() => {});
    try { await previousRegisterer?.dispose(); } catch { /* Transport may already be unavailable. */ }
    try { await previous?.stop(); } catch { /* Local tracks and state have already been cleared. */ }
  }
  async function disconnect() {
    if (operationBusy.current) return;
    operationBusy.current = true;
    try { await stopConnection(); await retryLogs(); } finally { operationBusy.current = false; }
  }
  async function connect(password: string) {
    if (operationBusy.current || ua.current) return;
    setError('');
    if (!canCall || !config?.enabled || !config.wssUrl || !config.extension || !password) {
      setError('مدیر باید اتصال و داخلی شما را تنظیم کند؛ سپس رمز داخلی را وارد کنید.'); return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setError('تماس مرورگری به HTTPS، مرورگر سازگار و اجازه میکروفن نیاز دارد.'); return;
    }
    operationBusy.current = true;
    setConnection('connecting');
    setConnectionDetail('در حال باز کردن ارتباط امن WebSocket با سرور ویپ…');
    const generation = epoch.current;
    try {
      // A SIP registration in a second tab can steal inbound calls from the first.
      if (navigator.locks) {
        const acquired = await new Promise<boolean>((resolve) => {
          void navigator.locks.request(`crm-voip-${user?.id}`, { ifAvailable: true }, async lock => {
            if (!lock) { resolve(false); return; }
            await new Promise<void>(release => { releaseTabLock.current = release; resolve(true); });
          }).catch(() => resolve(false));
        });
        if (!acquired) throw new Error('tab_busy');
      }
      if (generation !== epoch.current) { releaseTabLock.current?.(); return; }
      ringAudio.current = new AudioContext();
      void ringAudio.current.resume().catch(() => {});
      const uri = UserAgent.makeURI(`sip:${config.extension}@${config.sipDomain}`);
      if (!uri) throw new Error('invalid_uri');
      const instance = new UserAgent({
        uri, authorizationUsername: config.authorizationUsername || config.extension,
        authorizationPassword: password,
        transportOptions: { server: config.wssUrl, connectionTimeout: 10, traceSip: false },
        logBuiltinEnabled: false, logConfiguration: false,
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: { iceServers: config.stunUrls.map(url => ({ urls: url })) },
        },
        delegate: {
          onConnect: () => {
            if (ua.current === instance) setConnectionDetail('ارتباط WebSocket باز شد؛ در انتظار تأیید ثبت داخلی توسط سرور SIP…');
          },
          onDisconnect: () => {
            if (ua.current !== instance) return;
            connected.current = false;
            setError('اتصال تلفن قطع شد. برای دریافت تماس‌ها دوباره متصل شوید.');
            void stopConnection('error');
          },
          onInvite: invitation => {
            if (ua.current !== instance || !connected.current) { void invitation.reject({ statusCode: 480 }).catch(() => {}); return; }
            const rawPhone = dialNumber(invitation.remoteIdentity.uri.user ?? '');
            const phone = /^\+?\d{2,20}$/.test(rawPhone) ? rawPhone : 'anonymous';
            const incoming: LiveCall = { callId: crypto.randomUUID(), phone, direction: 'incoming', status: 'ringing', startedAt: timestamp() };
            if (activeSession.current) {
              log(eventFor(incoming, 'missed', timestamp()));
              void invitation.reject({ statusCode: 486 }).catch(() => {});
              return;
            }
            bindSession(invitation, incoming);
          },
        },
      });
      ua.current = instance;
      const registration = new Registerer(instance);
      registerer.current = registration;
      registration.stateChange.addListener(state => {
        if (ua.current !== instance) return;
        if (state === RegistererState.Registered) {
          if (registrationTimer.current) clearTimeout(registrationTimer.current);
          connected.current = true;
          setConnection('registered');
          setConnectionDetail('سرور SIP ثبت این داخلی را تأیید کرده است.');
          setError('');
        } else if (state === RegistererState.Unregistered) {
          connected.current = false;
          setConnection('error');
          setError('داخلی ثبت نشد یا اعتبار اتصال پایان یافت؛ تنظیمات و رمز داخلی را بررسی کنید.');
          // SIP.js emits Unregistered BEFORE onReject and clears its pending
          // flag after both callbacks. Preserve the agent through that turn so
          // onReject can report the actual SIP code before asynchronous disposal.
          queueMicrotask(() => { if (ua.current === instance) void stopConnection('error'); });
        }
      });
      await instance.start();
      if (ua.current !== instance || generation !== epoch.current) return;
      await registration.register({
        requestDelegate: {
          onReject: response => {
            if (ua.current !== instance) return;
            const code = response.message.statusCode;
            setConnection('error');
            setError(`سرور SIP ثبت داخلی را نپذیرفت (کد ${code})؛ نام کاربری احراز، رمز داخلی و مجاز بودن WebRTC برای این داخلی را بررسی کنید.`);
            queueMicrotask(() => { if (ua.current === instance) void stopConnection('error'); });
          },
        },
      });
      if (!connected.current && ua.current === instance) {
        registrationTimer.current = setTimeout(() => {
          if (ua.current !== instance || connected.current) return;
          setError('مهلت ثبت داخلی تمام شد؛ آدرس WSS و فعال‌بودن WebRTC را بررسی کنید.');
          void stopConnection('error');
        }, 20000);
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message === 'tab_busy'
        ? 'تلفن در تب دیگری فعال است؛ ابتدا آن اتصال را قطع کنید.'
        : 'اتصال برقرار نشد. آدرس WebRTC، گواهی امن و مشخصات داخلی باید توسط ارائه‌دهنده تأیید شوند.');
      await stopConnection('error');
    } finally { operationBusy.current = false; }
  }
  async function dial(raw: string) {
    setError('');
    const phone = dialNumber(raw);
    if (!/^\+?\d{2,20}$/.test(phone)) { setError('شماره تلفن معتبر وارد کنید.'); return; }
    if (!canCall || !connected.current || !ua.current || !config) { setError('ابتدا داخلی خود را در بخش تلفن شرکت متصل کنید.'); return; }
    if (activeSession.current) { setError('ابتدا تماس فعلی را پایان دهید.'); return; }
    const uri = UserAgent.makeURI(`sip:${phone}@${config.sipDomain}`);
    if (!uri) { setError('شماره تلفن معتبر نیست.'); return; }
    const invitation = new Inviter(ua.current, uri, { sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    bindSession(invitation, { callId: crypto.randomUUID(), phone, direction: 'outgoing', status: 'ringing', startedAt: timestamp() });
    try {
      await invitation.invite({ requestDelegate: { onReject: response => {
        if (activeSession.current !== invitation) return;
        terminalStatus.current = [486, 603].includes(response.message.statusCode ?? 0) ? 'rejected' : 'failed';
        setError('تماس پاسخ داده نشد یا مقصد/سرور آن را نپذیرفت.');
      } } });
    } catch {
      if (activeSession.current === invitation) finish('failed');
      await invitation.dispose().catch(() => {});
      setError('تماس برقرار نشد؛ دسترسی میکروفن و اتصال تلفن را بررسی کنید.');
    }
  }
  async function answer() {
    const session = activeSession.current;
    const current = activeCall.current;
    if (!(session instanceof Invitation) || current?.status !== 'ringing') return;
    showCall({ ...current, status: 'answering' });
    try {
      await session.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    } catch {
      if (activeSession.current === session) {
        setError('پاسخ به تماس انجام نشد؛ اجازه استفاده از میکروفن را بررسی کنید.');
        await session.reject({ statusCode: 480 }).catch(() => {});
        if (activeSession.current === session) finish('failed');
      }
    }
  }
  async function endCall(rejected = false) {
    const session = activeSession.current;
    const current = activeCall.current;
    if (!session || !current || current.status === 'ending') return;
    terminalStatus.current = current.answeredAt ? 'completed' : rejected ? 'rejected' : 'failed';
    showCall({ ...current, status: 'ending' });
    try {
      if (session.state === SessionState.Established) await session.bye();
      else if (session instanceof Invitation) await session.reject({ statusCode: 603 });
      else if (session instanceof Inviter) await session.cancel();
    } catch {
      setError('ارسال پایان تماس با خطا روبه‌رو شد؛ تماس محلی بسته شد.');
    } finally {
      await session.dispose().catch(() => {});
      if (activeSession.current === session) finish();
    }
  }
  function toggleMute() {
    const handler = activeSession.current?.sessionDescriptionHandler;
    if (!(handler instanceof Web.SessionDescriptionHandler) || !activeCall.current?.answeredAt) return;
    const tracks = handler.localMediaStream.getAudioTracks();
    const nextMuted = tracks.some(track => track.enabled);
    tracks.forEach(track => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  }
  async function sendDtmf(tone: string) {
    const session = activeSession.current;
    if (!session || session.state !== SessionState.Established || !/^[0-9*#]$/.test(tone)) return;
    try {
      const handler = session.sessionDescriptionHandler;
      const sender = handler instanceof Web.SessionDescriptionHandler
        ? handler.peerConnection?.getSenders().find(item => item.track?.kind === 'audio') : undefined;
      if (sender?.dtmf?.canInsertDTMF) {
        sender.dtmf.insertDTMF(tone, 160);
        return;
      }
      await session.info({ requestOptions: {
        body: { contentDisposition: 'render', contentType: 'application/dtmf-relay', content: `Signal=${tone}\r\nDuration=160` },
      } });
    } catch { setError('ارسال کلید شماره‌گیر انجام نشد.'); }
  }

  useEffect(() => {
    const interval = setInterval(() => { void retryLogs(); }, 15000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (activeCall.current || pending.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { clearInterval(interval); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  useEffect(() => {
    // Revoked permissions, logout and changed configuration invalidate an existing SIP identity.
    return () => {
      void stopConnection();
    };
  }, [user?.id, canCall, config?.enabled, config?.wssUrl, config?.sipDomain, config?.extension, config?.authorizationUsername]);
  useEffect(() => {
    return () => {
      epoch.current += 1;
      pending.current.clear();
      setLogError('');
    };
  }, [user?.id]);
  useEffect(() => {
    if (call?.direction !== 'incoming' || call.status !== 'ringing') return;
    const beep = () => {
      const context = ringAudio.current;
      if (!context || context.state !== 'running') return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(0.06, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.4);
    };
    beep();
    const timer = setInterval(beep, 1600);
    return () => clearInterval(timer);
  }, [call?.callId, call?.status]);

  return <PhoneContext.Provider value={{
    config, isConfigLoading: configQuery.isLoading, configError: configQuery.error,
    refetchConfig: () => { void configQuery.refetch(); }, connection, connectionDetail, call, error, logError, muted, canCall,
    connect, disconnect, dial, answer, reject: () => endCall(true), hangup: () => endCall(),
    toggleMute, sendDtmf, clearError: () => setError(''), retryLogs,
  }}>
    {children}
    <audio ref={audio} autoPlay playsInline />
    {call?.status === 'answered' && error.includes('پخش صدا') && <button
      type="button" className="btn btn-primary" style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 100 }}
      onClick={() => { void audio.current?.play().then(() => setError('')).catch(() => setError('پخش صدا هنوز مسدود است؛ مجوز صدای سایت را بررسی کنید.')); }}>
      پخش صدای تماس
    </button>}
  </PhoneContext.Provider>;
}
export function useVoip(): PhoneContext {
  const context = useContext(PhoneContext);
  if (!context) throw new Error('VoipProvider is required');
  return context;
}