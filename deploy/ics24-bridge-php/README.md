# ICS24 Bridge برای Plesk Windows

این سرویس یک API کوچک و مستقل است که روی `ics24.nafisvam.com` نصب می‌شود. CRM روی VPS ترکیه درخواست‌های استعلام را با HTTPS و امضای HMAC به این سرویس می‌فرستد؛ فقط همین سرویس با ICS24 ارتباط می‌گیرد. نام کاربری و رمز ICS24 هرگز به CRM ترکیه یا مرورگر ارسال نمی‌شوند.

## مسیرهای API

تمام مسیرهای زیر به‌جز `GET /healthz` نیازمند امضای HMAC هستند:

- `POST /v1/credit-checks/initiate` — بدنه: `nationalCode`, `mobileNumber`
- `POST /v1/credit-checks/{hashCode}/validate` — بدنه: `otp`
- `POST /v1/credit-checks/{hashCode}/renew`
- `GET /v1/credit-checks/{hashCode}/status`
- `GET /v1/reports/{reportCode}/json`
- `GET /v1/reports/{reportCode}/pdf`

پاسخ JSON مسیرها عمداً در قالب پاسخ MyCredit برگردانده می‌شود تا CRM بتواند همان parser فعلی را استفاده کند.

## نصب در Plesk Windows

1. برای دامنه `ics24.nafisvam.com` یک subdomain بسازید و Document Root را روی پوشه `public` این پروژه قرار دهید.
2. PHP نسخه 8.1 یا بالاتر را فعال کنید و extensionهای `curl`, `json`, `mbstring`, `openssl` را فعال نگه دارید.
3. کل پوشه پروژه را روی سرور کپی کنید. پوشه `src` باید کنار `public` باشد، نه داخل Document Root عمومی.
4. در تنظیمات PHP دامنه یا Environment Variables سرویس این مقادیر را ثبت کنید:

```text
ICS24_BASE_URL=https://mycredit.ics24.ir
ICS24_API_VERSION=2.0
ICS24_USERNAME=<نام کاربری ICS24>
ICS24_PASSWORD=<رمز ICS24>
BRIDGE_KEY_ID=crm-turkey
BRIDGE_SHARED_SECRET=<یک راز تصادفی حداقل 32 بایتی>
BRIDGE_STORAGE_PATH=<مسیر خارج از public برای storage>
```

اگر پنل Plesk امکان ثبت Environment Variable ندارد، همین مقادیر را با `putenv()` در فایل
`config.php` کنار پوشه‌های `public` و `src` قرار دهید. این فایل بیرون از Document Root است و
نباید داخل Git یا پوشه `public` قرار گیرد.

در Plesk Windows اگر پوشه `storage` مجوز نوشتن PHP ندارد، بدون دادن write به کل دامنه از
`public/App_Data/ics24-bridge` استفاده کنید. IIS پوشه `App_Data` را از دسترسی HTTP محافظت
می‌کند:

```php
putenv(
    'BRIDGE_STORAGE_PATH='
    . __DIR__
    . DIRECTORY_SEPARATOR . 'public'
    . DIRECTORY_SEPARATOR . 'App_Data'
    . DIRECTORY_SEPARATOR . 'ics24-bridge'
);
```

5. دسترسی نوشتن فقط به `BRIDGE_STORAGE_PATH` بدهید. این پوشه cache توکن و nonceهای مصرف‌شده را نگه می‌دارد و نباید عمومی باشد.
6. فایل `public/web.config` برای IIS URL Rewrite است. اگر Plesk روی سرور URL Rewrite را فعال نکرده باشد، آن را فعال کنید یا تمام مسیرهای `/v1/*` را به `index.php` بازنویسی کنید.
7. تست اولیه:

```text
GET https://ics24.nafisvam.com/healthz
```

پاسخ مورد انتظار:

```json
{"status":"ok","service":"ics24-bridge"}
```

## فعال‌سازی در CRM ترکیه

روی VPS ترکیه این environmentها را تنظیم کنید:

```text
ICS24_BRIDGE_URL=https://ics24.nafisvam.com
ICS24_BRIDGE_KEY_ID=crm-turkey
ICS24_BRIDGE_SHARED_SECRET=<همان راز ثبت‌شده در Plesk>
```

وقتی `ICS24_BRIDGE_URL` تنظیم باشد، کد CRM دیگر به `ICS24_BASE_URL` وصل نمی‌شود و تمام عملیات initiate، OTP، renew، status و report را از Bridge می‌گیرد. برای دریافت PDF نیز مسیر Bridge آماده است.

## قرارداد امضا

امضا با HMAC-SHA256 روی متن زیر ساخته می‌شود. در IIS/Plesk، `path` باید فرم
decode‌شده‌ای باشد که PHP در `REQUEST_URI` دریافت می‌کند:

```text
timestamp\nnonce\nMETHOD\n/path\nraw-body
```

هدرهای لازم:

```text
X-Bridge-Key: crm-turkey
X-Bridge-Timestamp: <Unix timestamp>
X-Bridge-Nonce: <unique random value>
X-Bridge-Signature: <hex HMAC-SHA256>
```

Bridge زمان درخواست را حداکثر پنج دقیقه معتبر می‌داند و nonce تکراری را رد می‌کند. در لاگ‌ها OTP، کد ملی، موبایل، توکن و PDF ثبت نمی‌شوند.

## نکته امنیتی

راز مشترک را در Git، فایل‌های عمومی Plesk، frontend یا chat قرار ندهید. اگر راز افشا شد، یک راز جدید بسازید و هم‌زمان در Plesk و VPS ترکیه جایگزین کنید.