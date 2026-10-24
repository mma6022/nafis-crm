import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { useVoip } from './VoipProvider';
import { Phone, PhoneIncoming, PhoneOutgoing, Mic, MicOff, PhoneOff, Hash } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Link } from 'wouter';

export function VoipDock() {
  const { call, answer, reject, hangup, sendDtmf, toggleMute, muted, error, logError, clearError, retryLogs } = useVoip();
  const [dtmfMode, setDtmfMode] = useState(false);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (call?.status === 'answered' && call.answeredAt) {
      const interval = setInterval(() => {
        setDuration(Math.max(0, Math.floor((Date.now() - new Date(call.answeredAt!).getTime()) / 1000)));
      }, 1000);
      return () => clearInterval(interval);
    }
    setDuration(0);
    return undefined;
  }, [call?.status, call?.answeredAt]);

  if (!call && !error && !logError) return null;

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const handleDtmf = (tone: string) => {
    sendDtmf(tone);
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      left: 24,
      backgroundColor: '#1e293b',
      color: 'white',
      borderRadius: 12,
      boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
      padding: 16,
      width: 320,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      direction: 'rtl'
    }}>
      {error && (
        <div style={{ backgroundColor: '#ef4444', padding: '8px 12px', borderRadius: 6, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={clearError} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer' }}>×</button>
        </div>
      )}
      
      {logError && (
        <div style={{ backgroundColor: '#f59e0b', padding: '8px 12px', borderRadius: 6, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#1e293b' }}>
          <span>خطای گزارش: {logError}</span>
          <button onClick={retryLogs} style={{ background: 'transparent', border: 'none', color: '#1e293b', cursor: 'pointer', textDecoration: 'underline' }}>تلاش مجدد</button>
        </div>
      )}

      {call && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div className={call.status === 'ringing' ? 'animate-pulse' : ''} style={{
                width: 40, height: 40, borderRadius: '50%', 
                backgroundColor: call.status === 'ringing' ? '#ef4444' : '#10b981',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                {call.direction === 'incoming' ? <PhoneIncoming size={20} color="white" /> : <PhoneOutgoing size={20} color="white" />}
              </div>
              <div>
                <strong style={{ display: 'block', fontSize: 16 }} dir="ltr">
                  {call.customer ? <>{call.customer.name} <CustomerIdBadge id={call.customer.id} /></> : call.phone}
                </strong>
                {call.customer && <span style={{ display: 'block', fontSize: 11, color: '#cbd5e1' }}>کارشناس فروش: {call.customer.customerSalespersonName || 'بدون تخصیص'}</span>}
                <span style={{ fontSize: 13, color: '#94a3b8' }}>
                  {call.status === 'ringing' ? (call.direction === 'incoming' ? 'تماس ورودی...' : 'در حال زنگ زدن...') :
                   call.status === 'answering' ? 'در حال پاسخ...' :
                   call.status === 'answered' ? `در حال مکالمه - ${formatDuration(duration)}` :
                   call.status === 'ending' ? 'در حال قطع...' : call.status}
                </span>
              </div>
            </div>
          </div>

          {call.customer && (
            <div style={{ fontSize: 13, backgroundColor: '#334155', padding: '8px 12px', borderRadius: 6 }}>
              مشتری CRM: <Link href={`/customers/${call.customer.id}`} style={{ color: '#60a5fa', textDecoration: 'none' }}>پرونده مشتری</Link>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {call.status === 'ringing' && call.direction === 'incoming' && (
              <>
                <button 
                  onClick={answer}
                  style={{ flex: 1, backgroundColor: '#10b981', color: 'white', border: 'none', padding: '10px 0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <Phone size={18} /> پاسخ
                </button>
                <button 
                  onClick={reject}
                  style={{ flex: 1, backgroundColor: '#ef4444', color: 'white', border: 'none', padding: '10px 0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <PhoneOff size={18} /> رد تماس
                </button>
              </>
            )}

            {(call.status === 'answered' || (call.status === 'ringing' && call.direction === 'outgoing')) && (
              <>
                {call.status === 'answered' && (
                  <>
                    <button 
                      onClick={toggleMute}
                      style={{ width: 44, height: 44, backgroundColor: muted ? '#f59e0b' : '#334155', color: 'white', border: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                      title="میکروفون"
                    >
                      {muted ? <MicOff size={20} /> : <Mic size={20} />}
                    </button>
                    <button 
                      onClick={() => setDtmfMode(!dtmfMode)}
                      style={{ width: 44, height: 44, backgroundColor: dtmfMode ? '#3b82f6' : '#334155', color: 'white', border: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                      title="صفحه کلید"
                    >
                      <Hash size={20} />
                    </button>
                  </>
                )}
                <button 
                  onClick={hangup}
                  style={{ flex: 1, backgroundColor: '#ef4444', color: 'white', border: 'none', padding: '10px 0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <PhoneOff size={18} /> قطع تماس
                </button>
              </>
            )}
          </div>

          {dtmfMode && call.status === 'answered' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(key => (
                <button
                  key={key}
                  onClick={() => handleDtmf(key)}
                  style={{ backgroundColor: '#475569', color: 'white', border: 'none', padding: '12px 0', borderRadius: 6, fontSize: 16, cursor: 'pointer' }}
                >
                  {key}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
