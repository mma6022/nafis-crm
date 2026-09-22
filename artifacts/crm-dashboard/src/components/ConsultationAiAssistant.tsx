import { useState, useRef, useEffect } from 'react';
import { Bot, Send, ThumbsUp, ThumbsDown, Check, X, CheckCheck, Loader2, ListChecks } from 'lucide-react';
import {
  useListConsultationAiConversations,
  useCreateConsultationAiConversation,
  useListConsultationAiMessages,
  useSendConsultationAiMessage,
  useSubmitConsultationAiFeedback,
  getListConsultationAiConversationsQueryKey,
  getListConsultationAiMessagesQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

export function ConsultationAiAssistant({ customerId, onInsertNote }: { customerId: number; onInsertNote: (text: string) => void }) {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [requestError, setRequestError] = useState('');

  useEffect(() => {
    setActiveConversationId(null);
    setInput('');
    setRequestError('');
  }, [customerId]);
  
  const convs = useListConsultationAiConversations(
    { customerId },
    { query: { enabled: !!customerId, queryKey: getListConsultationAiConversationsQueryKey({ customerId }) } }
  );

  useEffect(() => {
    if (convs.data && convs.data.length > 0 && !activeConversationId) {
      setActiveConversationId(convs.data[0].id);
    }
  }, [convs.data, activeConversationId]);

  const messages = useListConsultationAiMessages(
    activeConversationId ?? 0,
    { query: { enabled: !!activeConversationId, queryKey: getListConsultationAiMessagesQueryKey(activeConversationId ?? 0) } }
  );

  const createConv = useCreateConsultationAiConversation();
  const sendMessage = useSendConsultationAiMessage();
  const submitFeedback = useSubmitConsultationAiFeedback();

  const sendText = async (text: string, conversationId?: number) => {
    if (!text.trim() || !customerId) return;
    setRequestError('');
    setInput('');
    const textarea = document.querySelector('.ai-input-area textarea') as HTMLTextAreaElement;
    if (textarea) textarea.style.height = '36px';
    
    let convId = conversationId ?? activeConversationId;
    let tempId: number | null = null;
    try {
      if (!convId) {
        const newConv = await createConv.mutateAsync({ data: { customerId, title: text.slice(0, 50) } });
        convId = newConv.id;
        setActiveConversationId(convId);
        queryClient.invalidateQueries({ queryKey: getListConsultationAiConversationsQueryKey({ customerId }) });
      }

      tempId = Date.now();
      queryClient.setQueryData<any[]>(getListConsultationAiMessagesQueryKey(convId), (old) => {
        return [...(old || []), { id: tempId, conversationId: convId, role: 'user', content: text, createdAt: new Date().toISOString() }];
      });

      await sendMessage.mutateAsync({ id: convId, data: { content: text } });
      await queryClient.invalidateQueries({ queryKey: getListConsultationAiMessagesQueryKey(convId) });
    } catch {
      if (convId && tempId) {
        queryClient.setQueryData<any[]>(getListConsultationAiMessagesQueryKey(convId), (old) =>
          (old || []).filter((message) => message.id !== tempId),
        );
      }
      setInput(text);
      setRequestError('پاسخ دستیار دریافت نشد. دوباره تلاش کنید.');
    }
  };

  const handleSend = () => sendText(input.trim());

  const startGuidedConsultation = async () => {
    if (!customerId || createConv.isPending || sendMessage.isPending) return;
    setRequestError('');
    try {
      const conversation = await createConv.mutateAsync({
        data: { customerId, title: 'مشاوره مرحله‌ای جدید' },
      });
      setActiveConversationId(conversation.id);
      await queryClient.invalidateQueries({
        queryKey: getListConsultationAiConversationsQueryKey({ customerId }),
      });
      await sendText(
        'مشاوره مرحله‌ای را شروع کن. اطلاعات ثبت‌شده را بررسی کن و اولین سؤال ضروری را از مشتری بپرس.',
        conversation.id,
      );
    } catch {
      setRequestError('شروع مشاوره مرحله‌ای ممکن نشد. دوباره تلاش کنید.');
    }
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.data]);

  return (
    <div className="ai-assistant-panel" data-testid="ai-assistant-panel">
      <div className="ai-header">
        <Bot size={18} />
        <div>
          <h4>دستیار هوشمند مشاوره</h4>
          <span className="disclaimer">پاسخ‌ها را پیش از ارائه به مشتری بررسی کنید.</span>
        </div>
        <button
          type="button"
          className="ai-guided-start"
          onClick={startGuidedConsultation}
          disabled={createConv.isPending || sendMessage.isPending}
        >
          <ListChecks size={14} />
          مشاوره مرحله‌ای جدید
        </button>
      </div>
      
      <div className="ai-messages">
        {!activeConversationId && !convs.isLoading && (
          <div className="ai-empty">
            <Bot size={24} />
            <p>برای دریافت پیشنهاد دقیق، مشاوره مرحله‌ای را شروع کنید تا دستیار سؤال‌های لازم را یکی‌یکی بپرسد.</p>
            <button type="button" className="ai-empty-start" onClick={startGuidedConsultation}>
              <ListChecks size={15} />
              شروع مشاوره مرحله‌ای
            </button>
          </div>
        )}
        
        {messages.isLoading && activeConversationId && (
          <div className="ai-loading"><Loader2 className="animate-spin" size={20} /> در حال دریافت تاریخچه...</div>
        )}
        {(convs.isError || messages.isError) && (
          <div className="ai-request-error">دریافت تاریخچه گفتگو ممکن نشد.</div>
        )}

        {messages.data?.map((msg) => (
          <div key={msg.id} className={`ai-message ${msg.role}`}>
            <span className="ai-message-author">{msg.role === 'user' ? 'پاسخ مشتری / کارشناس' : 'دستیار مشاوره'}</span>
            <div className="ai-message-content">{msg.content}</div>
            {msg.role === 'assistant' && (
              <div className="ai-message-actions">
                <button onClick={() => onInsertNote(msg.content)} className="ai-action-btn" title="افزودن به یادداشت">
                  <CheckCheck size={14} /> استفاده
                </button>
                <FeedbackWidget messageId={msg.id} onSubmit={(rating, correctedAnswer) => {
                  submitFeedback.mutate({ id: msg.id, data: { rating, correctedAnswer } });
                }} />
              </div>
            )}
          </div>
        ))}
        {sendMessage.isPending && (
          <div className="ai-message assistant ai-typing">
            <div className="typing-dot"></div><div className="typing-dot"></div><div className="typing-dot"></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-input-area">
        {requestError ? <div className="ai-request-error" role="alert">{requestError}</div> : null}
        <div className="ai-composer">
          <textarea
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = '36px';
              e.target.style.height = Math.min(e.target.scrollHeight, 112) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="پیام"
            aria-label="متن پیام"
            disabled={sendMessage.isPending || createConv.isPending}
          />
          <button type="button" onClick={handleSend} disabled={!input.trim() || sendMessage.isPending || createConv.isPending} className="ai-send-btn" aria-label="ارسال پیام">
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function FeedbackWidget({ messageId, onSubmit }: { messageId: number, onSubmit: (rating: 'up' | 'down', correctedAnswer?: string) => void }) {
  const [status, setStatus] = useState<'idle' | 'up' | 'down' | 'correcting'>('idle');
  const [correction, setCorrection] = useState('');

  if (status === 'up' || status === 'down') {
    return <span className="ai-feedback-thanks">بازخورد ثبت شد</span>;
  }

  if (status === 'correcting') {
    return (
      <div className="ai-correction-popover">
        <input 
          autoFocus
          value={correction} 
          onChange={(e) => setCorrection(e.target.value)} 
          placeholder="پاسخ صحیح چیست؟" 
        />
        <button onClick={() => { onSubmit('down', correction); setStatus('down'); }}><Check size={14} /></button>
        <button onClick={() => setStatus('idle')}><X size={14} /></button>
      </div>
    );
  }

  return (
    <>
      <button onClick={() => { onSubmit('up'); setStatus('up'); }} className="ai-action-btn" title="پاسخ مفید بود"><ThumbsUp size={14} /></button>
      <button onClick={() => setStatus('correcting')} className="ai-action-btn" title="پاسخ نادرست بود"><ThumbsDown size={14} /></button>
    </>
  );
}
