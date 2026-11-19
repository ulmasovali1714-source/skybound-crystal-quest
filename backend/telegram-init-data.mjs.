
/**
 * Verify Telegram Mini App initData with the standard Web Crypto API.
 * Run this on a trusted server or serverless runtime. Never ship the bot token
 * to the browser. The returned user is authenticated only after HMAC and
 * auth_date checks pass.
 */
export async function verifyTelegramInitData(initData, botToken, options = {}) {
  const maxAgeSeconds = Number.isSafeInteger(options.maxAgeSeconds) ? options.maxAgeSeconds : 86_400;
  const nowSeconds = Number.isSafeInteger(options.nowSeconds) ? options.nowSeconds : Math.floor(Date.now() / 1000);
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 16_384) {
    throw new Error('Missing or oversized Telegram initData.');
  }
  if (typeof botToken !== 'string' || botToken.length < 20) {
    throw new Error('Telegram bot token is not configured on this server.');
  }
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required by this server runtime.');

  const params = new URLSearchParams(initData);
  const values = new Map();
  for (const [key, value] of params.entries()) {
    if (values.has(key)) throw new Error(`Duplicate Telegram initData field: ${key}`);
    values.set(key, value);
  }

  const suppliedHashHex = values.get('hash');
  if (!suppliedHashHex || !/^[a-f0-9]{64}$/i.test(suppliedHashHex)) {
    throw new Error('Telegram initData hash is missing or malformed.');
  }
  const authDate = Number(values.get('auth_date'));
  if (!Number.isSafeInteger(authDate)) throw new Error('Telegram auth_date is missing or invalid.');
  if (authDate > nowSeconds + 60) throw new Error('Telegram initData auth_date is in the future.');
  if (nowSeconds - authDate > maxAgeSeconds) throw new Error('Telegram initData has expired.');

  const dataCheckString = [...values.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left < right ? -1 : (left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const encoder = new TextEncoder();
  const derivationKey = await crypto.subtle.importKey(
    'raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const secretKeyBytes = await crypto.subtle.sign('HMAC', derivationKey, encoder.encode(botToken));
  const webAppKey = await crypto.subtle.importKey(
    'raw', secretKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const suppliedHash = new Uint8Array(suppliedHashHex.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));
  const isValid = await crypto.subtle.verify('HMAC', webAppKey, suppliedHash, encoder.encode(dataCheckString));
  if (!isValid) throw new Error('Telegram initData signature did not verify.');

  let user;
  try {
    user = JSON.parse(values.get('user') || 'null');
  } catch {
    throw new Error('Telegram initData user field is not valid JSON.');
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error('Telegram initData has no valid Telegram user ID.');
  }

  return Object.freeze({
    telegramId: String(user.id),
    firstName: typeof user.first_name === 'string' ? user.first_name : '',
    lastName: typeof user.last_name === 'string' ? user.last_name : '',
    username: typeof user.username === 'string' ? user.username : null,
    photoUrl: typeof user.photo_url === 'string' ? user.photo_url : null,
    authDate,
    startParam: values.get('start_param') || null,
  });
}
