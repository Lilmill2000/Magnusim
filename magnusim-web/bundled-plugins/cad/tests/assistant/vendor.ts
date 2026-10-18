// The app's vendor-name check (scripts/__tests__/vendor-names.test.mjs) for the Assistant's texts:
// the same words, base64 here as there, so this file passes that check itself.
// SPDX-License-Identifier: GPL-3.0-or-later
const WORDS = ['KD88IVthLXpdKShjbGF1ZGV8YW50aHJvcGljfG9wZW5haXxjaGF0Z3B0fGNvcGlsb3QpKD8hW2Etel0p', 'KD88IVthLXowLTldKWdwdCg/IVthLXpdKQ=='].map(
  (b) => new RegExp(Buffer.from(b, 'base64').toString('utf8'), 'i'),
);

/** Whether `text` names a vendor (a whole word, any case). */
export function namesVendor(text: string): boolean {
  return WORDS.some((re) => re.test(text));
}
