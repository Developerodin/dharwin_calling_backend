/**
 * Phone number normalization and validation (E.164).
 */

/**
 * @param {string} phone - raw phone string
 * @param {string} [countryCode] - ISO country code hint (IN, US, GB, AU, CA …)
 */
function normalizePhone(phone, countryCode) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits.length) return null;

  // Already prefixed with a known country dial code
  if (digits.startsWith('91') && digits.length >= 12) return `+${digits}`;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  if (digits.startsWith('44') && digits.length >= 12) return `+${digits}`;
  if (digits.startsWith('61') && digits.length >= 11) return `+${digits}`;

  if (digits.length === 10) {
    const cc = String(countryCode || '').toUpperCase();
    if (cc === 'US' || cc === 'CA') return `+1${digits}`;
    if (cc === 'GB') return `+44${digits}`;
    if (cc === 'AU') return `+61${digits}`;
    return `+91${digits}`; // default to India
  }

  if (phone.trim().startsWith('+')) return phone.trim();
  return `+${digits}`;
}

/** Returns true when the number is an obvious placeholder (all zeros, repeated single digit, etc.). */
function isPlaceholderPhone(phone) {
  if (!phone) return true;
  const d = String(phone).replace(/\D/g, '');
  if (!d.length) return true;
  if (/^0+$/.test(d)) return true;
  if (d.length >= 10 && /^(\d)\1+$/.test(d)) return true;
  return false;
}

function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  return /^\+[1-9]\d{1,14}$/.test(phone.trim());
}

/**
 * Stricter checks so Bolna (and carriers) won't reject the number — e.g. +10000000000 passes E.164 regex but is invalid NANP.
 */
function validateNanpNational(n10) {
  if (!n10 || n10.length !== 10) return false;
  if (/^0+$/.test(n10)) return false;
  const npa0 = n10[0];
  const nxx0 = n10[3];
  if (npa0 === '0' || npa0 === '1') return false;
  if (nxx0 === '0' || nxx0 === '1') return false;
  return true;
}

function validatePhonePlausible(phone) {
  if (!validatePhone(phone)) return false;
  const digits = phone.replace(/\D/g, '');
  if (!digits.length) return false;

  if (digits.startsWith('1') && digits.length === 11) {
    return validateNanpNational(digits.slice(1));
  }

  if (digits.startsWith('91') && digits.length === 12) {
    const national = digits.slice(2);
    if (/^0+$/.test(national)) return false;
    if (/^(\d)\1{9}$/.test(national)) return false;
    return true;
  }

  if (/^(\d)\1+$/.test(digits)) return false;

  return true;
}

export { normalizePhone, validatePhone, validatePhonePlausible, isPlaceholderPhone };

