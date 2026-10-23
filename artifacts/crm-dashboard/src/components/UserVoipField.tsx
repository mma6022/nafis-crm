export function UserVoipField({ value, onChange, creating = false }: {
  value: string; onChange: (value: string) => void; creating?: boolean;
}) {
  const id = creating ? 'create-user-voip-extension' : 'user-voip-extension';
  return <div className="field">
    <label htmlFor={id}>داخلی تلفن ویپ</label>
    <input id={id} dir="ltr" value={value} maxLength={32} pattern="[A-Za-z0-9*#_.\-]*"
      placeholder="مثال: 201" autoComplete="off"
      aria-describedby={`${id}-help`} data-testid={`input-${id}`}
      onChange={event => onChange(event.target.value.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
        .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))))} />
    <span id={`${id}-help`} className="subtle-note">تماس‌ها و فایل‌های ضبط‌شدهٔ این داخلی به این کاربر مرتبط می‌شوند. برای حذف ارتباط، خالی بگذارید.</span>
  </div>;
}