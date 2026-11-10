import { CalendarDays, X } from 'lucide-react';
import { DayPicker } from 'react-day-picker/persian';
import 'react-day-picker/style.css';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { dateToJalaliValue, jalaliValueToDate } from '@/lib/jalali';

function faDateDigits(value: string): string {
  return value.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] ?? d);
}

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
  noFuture = false,
  displayDigits = false,
  formatDisplay,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  birthDate?: boolean;
  minValue?: string;
  popoverClassName?: string;
  /** Disable days after today (e.g. a real deposit date). */
  noFuture?: boolean;
  /** Show Persian digits in the trigger. The stored value stays Latin. */
  displayDigits?: boolean;
  /** Optional visible label (e.g. «۱۹ آبان ۱۴۰۵»). The stored value stays Jalali YYYY/MM/DD. */
  formatDisplay?: (value: string) => string;
  ariaLabel?: string;
}) {
  const selected = value ? jalaliValueToDate(value) : undefined;
  const today = new Date();
  const minDate = minValue ? jalaliValueToDate(minValue) : undefined;
  const minimum = minDate ? new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()) : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`persian-date-trigger ${value ? 'has-value' : ''}`} data-testid={testId} aria-label={ariaLabel}>
          <CalendarDays size={15} />
          <span dir={formatDisplay && value ? 'rtl' : 'ltr'}>{value ? (formatDisplay ? formatDisplay(value) : (displayDigits ? faDateDigits(value) : value)) : placeholder}</span>
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
          endMonth={birthDate || noFuture ? today : calendarEnd}
          disabled={[...(birthDate || noFuture ? [{ after: today }] : []), ...(minimum ? [{ before: minimum }] : [])]}
          reverseYears
          showOutsideDays
          dir="rtl"
        />
        {value ? <button type="button" className="persian-date-clear" onClick={() => onChange('')}><X size={13} /> پاک‌کردن تاریخ</button> : null}
      </PopoverContent>
    </Popover>
  );
}