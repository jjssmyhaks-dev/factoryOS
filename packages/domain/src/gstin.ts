/**
 * GSTIN helpers (groundwork for E8-S3 validators).
 *
 * Format per CBIC: 2-digit state code + 10-char PAN + entity code + check char
 * + registration number. The *checksum* algorithm is deliberately NOT
 * implemented here — it needs confirmation against the official spec; E8-S3
 * ships it with failing-example tests after a spike (logged in
 * docs/open-questions.md).
 */

export const STATE_CODE_TO_NAME: Record<string, string> = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

const GSTIN_RE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])([Z])([0-9A-Z])$/;

export function isValidGstinFormat(gstin: string): boolean {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/.test(gstin)) return false;
  const stateCode = gstin.slice(0, 2);
  return stateCode in STATE_CODE_TO_NAME;
}

/** Place of supply state code derived from the GSTIN (E8-S3). */
export function stateCodeFromGstin(gstin: string): string | null {
  const m = GSTIN_RE.exec(gstin);
  if (!m) return null;
  const code = m[1] as string;
  return code in STATE_CODE_TO_NAME ? code : null;
}

export function panFromGstin(gstin: string): string | null {
  const m = GSTIN_RE.exec(gstin);
  return m ? (m[2] as string) : null;
}
