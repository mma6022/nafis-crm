import { CalendarDays, X } from 'lucide-react';
import { DayPicker } from 'react-day-picker/persian';
import 'react-day-picker/style.css';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { dateToJalaliValue, jalaliValueToDate } from '@/lib/jalali';

const calendarStart = new Date(1920, 0, 1);
const calendarEnd = new Date(new Date().getFullYear() + 20, 11, 31);

export function PersianDatePicker({
  value,
  onChange,
  placeholder = 'انتخاب تاریخ شمسی',
  testId,
  birthDate = false,
  minValue,
  popoverClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  birthDate?: boolean;
  minValue?: string;
  popoverClassName?: string;
}) {
  const selected = value ? jalaliValueToDate(value) : undefined;
  const today = new Date();
  const minDate = minValue ? jalaliValueToDate(minValue) : undefined;
  const minimum = minDate ? new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()) : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`persian-date-trigger ${value ? 'has-value' : ''}`} data-testid={testId}>
          <CalendarDays size={15} />
          <span>{value || placeholder}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className={`persian-date-popover ${popoverClassName ?? ''}`} align="start" dir="rtl">
        <DayPicker
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (date) onChange(dateToJalaliValue(date));
          }}
          defaultMonth={selected}
          captionLayout="dropdown"
          startMonth={minimum ?? calendarStart}
          endMonth={birthDate ? today : calendarEnd}
          disabled={[...(birthDate ? [{ after: today }] : []), ...(minimum ? [{ before: minimum }] : [])]}
          reverseYears
          showOutsideDays
          dir="rtl"
        />
        {value ? <button type="button" className="persian-date-clear" onClick={() => onChange('')}><X size={13} /> پاک‌کردن تاریخ</button> : null}
      </PopoverContent>
    </Popover>
  );
}