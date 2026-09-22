import { CalendarDays, X } from 'lucide-react';
import { DayPicker } from 'react-day-picker/persian';
import 'react-day-picker/style.css';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { dateToJalaliValue, jalaliValueToDate } from '@/lib/jalali';

export function PersianDatePicker({
  value,
  onChange,
  placeholder = 'انتخاب تاریخ شمسی',
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  const selected = value ? jalaliValueToDate(value) : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`persian-date-trigger ${value ? 'has-value' : ''}`} data-testid={testId}>
          <CalendarDays size={15} />
          <span>{value || placeholder}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="persian-date-popover" align="start" dir="rtl">
        <DayPicker
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (date) onChange(dateToJalaliValue(date));
          }}
          defaultMonth={selected}
          showOutsideDays
          dir="rtl"
        />
        {value ? <button type="button" className="persian-date-clear" onClick={() => onChange('')}><X size={13} /> پاک‌کردن تاریخ</button> : null}
      </PopoverContent>
    </Popover>
  );
}