<?php
declare(strict_types=1);

$privateConfig = dirname(__DIR__) . '/config.php';
if (is_file($privateConfig)) {
    require $privateConfig;
}
require_once dirname(__DIR__) . '/src/Ics24Client.php';

const MAX_CLOCK_SKEW = 300;

function jsonResponse(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function requestPath(): string
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    return is_string($path) && $path !== '' ? $path : '/';
}

function fail(string $message, int $status = 400): never
{
    jsonResponse(['error' => $message], $status);
}

function requestBody(): string
{
    $body = file_get_contents('php://input');
    if ($body === false || strlen($body) > 65536) {
        fail('بدنه درخواست نامعتبر یا بیش از حد بزرگ است.', 413);
    }
    return $body;
}

function authenticateBridge(string $path, string $body): void
{
    $keyId = trim((string) getenv('BRIDGE_KEY_ID'));
    $secret = (string) getenv('BRIDGE_SHARED_SECRET');
    $receivedKey = (string) ($_SERVER['HTTP_X_BRIDGE_KEY'] ?? '');
    $timestamp = (string) ($_SERVER['HTTP_X_BRIDGE_TIMESTAMP'] ?? '');
    $nonce = (string) ($_SERVER['HTTP_X_BRIDGE_NONCE'] ?? '');
    $signature = (string) ($_SERVER['HTTP_X_BRIDGE_SIGNATURE'] ?? '');

    if ($keyId === '' || $secret === '' || $receivedKey !== $keyId || !ctype_digit($timestamp) || $nonce === '' || $signature === '') {
        fail('احراز هویت Bridge ناموفق است.', 401);
    }
    if (abs(time() - (int) $timestamp) > MAX_CLOCK_SKEW) {
        fail('زمان درخواست Bridge منقضی شده است.', 401);
    }

    $canonical = $timestamp . "\n" . $nonce . "\n" . strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') . "\n" . $path . "\n" . $body;
    $expected = hash_hmac('sha256', $canonical, $secret);
    if (!hash_equals($expected, $signature)) {
        fail('امضای درخواست Bridge نامعتبر است.', 401);
    }

    $storage = rtrim((string) (getenv('BRIDGE_STORAGE_PATH') ?: dirname(__DIR__) . '/storage'), '/\\');
    if (!is_dir($storage) && !mkdir($storage, 0700, true) && !is_dir($storage)) {
        fail('ذخیره‌سازی Bridge آماده نیست.', 500);
    }
    $noncePath = $storage . DIRECTORY_SEPARATOR . 'used-nonces.json';
    $handle = fopen($noncePath, 'c+');
    if ($handle === false || !flock($handle, LOCK_EX)) {
        fail('کنترل درخواست تکراری در دسترس نیست.', 503);
    }
    $raw = stream_get_contents($handle);
    $used = json_decode($raw ?: '{}', true);
    $used = is_array($used) ? $used : [];
    $now = time();
    foreach ($used as $knownNonce => $seenAt) {
        if (!is_int($seenAt) && !ctype_digit((string) $seenAt)) {
            unset($used[$knownNonce]);
        } elseif ($now - (int) $seenAt > MAX_CLOCK_SKEW) {
            unset($used[$knownNonce]);
        }
    }
    if (isset($used[$nonce])) {
        flock($handle, LOCK_UN);
        fclose($handle);
        fail('درخواست تکراری Bridge رد شد.', 409);
    }
    $used[$nonce] = $now;
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($used, JSON_UNESCAPED_UNICODE));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
}

function jsonInput(string $body): array
{
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) {
        fail('بدنه JSON معتبر نیست.');
    }
    return $decoded;
}

function stringField(array $input, string $field, int $maxLength = 100): string
{
    $value = $input[$field] ?? null;
    if (!is_string($value) || trim($value) === '' || strlen($value) > $maxLength) {
        fail('فیلد ' . $field . ' معتبر نیست.');
    }
    return trim($value);
}

function normalizeDigits(string $value): string
{
    return strtr($value, [
        '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4',
        '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
        '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4',
        '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
    ]);
}

function nationalCode(string $value): string
{
    $code = preg_replace('/\D/', '', normalizeDigits($value)) ?? '';
    if (!preg_match('/^\d{10}$/', $code) || preg_match('/^(\d)\1{9}$/', $code)) {
        fail('کد ملی معتبر نیست.');
    }
    $sum = 0;
    for ($index = 0; $index < 9; $index++) {
        $sum += ((int) $code[$index]) * (10 - $index);
    }
    $remainder = $sum % 11;
    $check = $remainder < 2 ? $remainder : 11 - $remainder;
    if ($check !== (int) $code[9]) {
        fail('کد ملی معتبر نیست.');
    }
    return $code;
}

function mobile(string $value): string
{
    $digits = preg_replace('/\D/', '', normalizeDigits($value)) ?? '';
    if (preg_match('/^09\d{9}$/', $digits)) {
        return $digits;
    }
    if (preg_match('/^989\d{9}$/', $digits)) {
        return '0' . substr($digits, 2);
    }
    fail('شماره موبایل معتبر ایرانی نیست.');
}

function pathPart(string $value): string
{
    if ($value === '' || strlen($value) > 180 || !preg_match('/^[A-Za-z0-9._~+=-]+$/', $value)) {
        fail('شناسه سرویس معتبر نیست.');
    }
    return $value;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$path = requestPath();
if ($path === '/healthz') {
    jsonResponse(['status' => 'ok', 'service' => 'ics24-bridge']);
}

$body = requestBody();
authenticateBridge($path, $body);
$client = new Ics24Client();
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

try {
    if ($path === '/v1/credit-checks/initiate' && $method === 'POST') {
        $input = jsonInput($body);
        $hashCode = $client->initiate(nationalCode(stringField($input, 'nationalCode', 30)), mobile(stringField($input, 'mobileNumber', 30)));
        jsonResponse(['data' => $hashCode]);
    }

    if (preg_match('~^/v1/credit-checks/([^/]+)/validate$~', $path, $matches) === 1 && $method === 'POST') {
        $input = jsonInput($body);
        jsonResponse($client->validate(pathPart(rawurldecode($matches[1])), stringField($input, 'otp', 20)));
    }

    if (preg_match('~^/v1/credit-checks/([^/]+)/renew$~', $path, $matches) === 1 && $method === 'POST') {
        jsonResponse($client->renew(pathPart(rawurldecode($matches[1]))));
    }

    if (preg_match('~^/v1/credit-checks/([^/]+)/status$~', $path, $matches) === 1 && $method === 'GET') {
        jsonResponse($client->status(pathPart(rawurldecode($matches[1]))));
    }

    if (preg_match('~^/v1/reports/([^/]+)/json$~', $path, $matches) === 1 && $method === 'GET') {
        jsonResponse($client->reportJson(pathPart(rawurldecode($matches[1]))));
    }

    if (preg_match('~^/v1/reports/([^/]+)/pdf$~', $path, $matches) === 1 && $method === 'GET') {
        $file = $client->reportPdf(pathPart(rawurldecode($matches[1])));
        header('Content-Type: ' . $file['contentType']);
        header('Content-Disposition: attachment; filename="credit-report.pdf"');
        header('Content-Length: ' . strlen($file['content']));
        echo $file['content'];
        exit;
    }

    fail('مسیر Bridge پیدا نشد.', 404);
} catch (Ics24BridgeException $error) {
    error_log('ICS24 bridge provider request failed.');
    jsonResponse(['error' => $error->getMessage()], 502);
} catch (Throwable $error) {
    error_log('ICS24 bridge unexpected internal error.');
    jsonResponse(['error' => 'خطای داخلی Bridge اعتبارسنجی.'], 500);
}