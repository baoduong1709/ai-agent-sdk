import type { Guardrail, GuardrailVerdict, Guardrails } from './types.js';

/** The guardrails of each stage, in the order they run. */
export interface GuardrailLists {
  input: Guardrail[];
  output: Guardrail[];
}

export function guardrailLists(value: Guardrails | undefined, label: string): GuardrailLists {
  if (value === undefined) return { input: [], output: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object with input and output`);
  const list = (stage: 'input' | 'output') => {
    const entry = value[stage];
    const items = entry === undefined ? [] : Array.isArray(entry) ? entry : [entry];
    if (items.some((item) => typeof item !== 'function')) throw new TypeError(`${label}.${stage} must be a function or an array of functions`);
    return items;
  };
  return { input: list('input'), output: list('output') };
}

/** What a stage of guardrails decided about a text. */
export type GuardrailDecision =
  | { allowed: true; text: string; rewritten: boolean }
  | { allowed: false; code: 'input_blocked' | 'output_blocked' | 'guardrail_failed'; message: string; reply?: string };

const maxReason = 500;

/** Reads a verdict; a verdict of an unknown shape is treated as a failed guardrail, so it blocks. */
export function readVerdict(verdict: GuardrailVerdict): { allowed: true; text?: string } | { allowed: false; reason?: string; reply?: string } | undefined {
  if (verdict === true || verdict === undefined) return { allowed: true };
  if (verdict === false) return { allowed: false };
  if (!verdict || typeof verdict !== 'object') return undefined;
  if (verdict.allowed === true) {
    const { text } = verdict;
    if (text === undefined) return { allowed: true };
    return typeof text === 'string' && text.trim() ? { allowed: true, text } : undefined;
  }
  if (verdict.allowed === false) {
    const { reason, reply } = verdict;
    if ((reason !== undefined && typeof reason !== 'string') || (reply !== undefined && (typeof reply !== 'string' || !reply.trim()))) return undefined;
    return { allowed: false, ...(reason ? { reason: reason.slice(0, maxReason) } : {}), ...(reply ? { reply: reply.trim() } : {}) };
  }
  return undefined;
}

export interface MaskOptions {
  /** Mask e-mail addresses. Default true. */
  email?: boolean;
  /** Mask phone numbers written with a country code (+84 ...) or a leading 0 (09x ...). Default true. */
  phone?: boolean;
  /** Mask payment card numbers that pass the Luhn check. Default true. */
  card?: boolean;
}

const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const cardPattern = /(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d.,]\d)/g;
const phonePattern = /(?<![\w+])(?:\+\d|0)[\d .()-]{7,18}\d(?![\w])/g;

function luhn(digits: string) {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Masks personal data in a text, for logs as well as for a guardrail. */
export function maskText(text: string, { email = true, phone = true, card = true }: MaskOptions = {}) {
  let masked = text;
  if (email) masked = masked.replace(emailPattern, '[email]');
  if (card) {
    masked = masked.replace(cardPattern, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[card]' : match;
    });
  }
  if (phone) {
    masked = masked.replace(phonePattern, (match) => {
      const digits = match.replace(/\D/g, '').length;
      // A leading 0 is a national number of 10 or 11 digits; with a country code, 8 to 15 digits.
      const fits = match.startsWith('+') ? digits >= 8 && digits <= 15 : digits >= 10 && digits <= 11;
      return fits ? '[phone]' : match;
    });
  }
  return masked;
}

/**
 * A guardrail that replaces e-mail addresses, phone numbers and card numbers with [email], [phone] and [card]. As an
 * input guardrail it keeps them from the model and the session; as an output guardrail, from the reply.
 */
export function maskPII(options: MaskOptions = {}): Guardrail {
  return ({ text }) => {
    const masked = maskText(text, options);
    return masked === text ? true : { allowed: true, text: masked };
  };
}

/** Phrases that try to override the system prompt, in English and Vietnamese (matched without diacritics). */
const injectionPatterns = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|preceding|all|your|system)\b.{0,20}\b(instructions?|prompts?|rules|directions|guidelines)\b/,
  /\b(reveal|show|print|repeat|output|tell me)\b.{0,30}\b(system prompt|hidden (instructions?|prompt)|initial (instructions?|prompt)|developer (message|instructions?))\b/,
  /\byou are now\b.{0,30}\b(dan|jailbroken|unrestricted|unfiltered|developer mode)\b/,
  /\b(developer|jailbreak|god) mode\b.{0,20}\b(on|enabled|activated)\b/,
  /\b(bo qua|phot lo|lo di|quen|bat ke|vo hieu hoa)\b.{0,30}\b(huong dan|chi dan|chi thi|quy tac|lenh|cau lenh|prompt|loi nhac)\b.{0,20}\b(truoc|tren|cu|he thong|ban dau|da cho|truoc do)\b/,
  /\b(tiet lo|hien thi|in ra|cho (toi|minh|tao) xem|doc lai|nhac lai)\b.{0,30}\b(system prompt|prompt he thong|loi nhac he thong|chi dan he thong|huong dan he thong|chi thi he thong|huong dan an|chi dan an)\b/,
  /\btu (bay )?gio\b.{0,20}\bban (la|dong vai)\b.{0,40}\b(khong (co )?(gioi han|rang buoc|kiem duyet)|dan)\b/,
];

/** Lower case, without Vietnamese diacritics, with spaces collapsed. */
function plainText(text: string) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ');
}

export interface InjectionOptions {
  /** What the user reads when the message is blocked. */
  reply?: string;
  /** More patterns, matched against the text in lower case without diacritics. */
  patterns?: RegExp[];
}

/**
 * An input guardrail that blocks messages trying to override the agent's instructions or read its system prompt. It
 * matches known phrases in English and Vietnamese, so it is a first line of defense: tools still need authorize and
 * beforeTool to protect data.
 */
export function blockPromptInjection({ reply, patterns = [] }: InjectionOptions = {}): Guardrail {
  if (!Array.isArray(patterns) || patterns.some((pattern) => !(pattern instanceof RegExp))) throw new TypeError('patterns must be an array of RegExp');
  if (reply !== undefined && (typeof reply !== 'string' || !reply.trim())) throw new TypeError('reply must be a non-empty string');
  const all = [...injectionPatterns, ...patterns];
  return ({ text }) => {
    const plain = plainText(text);
    // A pattern with the g or y flag keeps its position between calls; it is reset so each message is read whole.
    const found = all.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(plain);
    });
    return found
      ? { allowed: false, reason: 'prompt_injection', reply: reply ?? 'I cannot follow that request. Please ask about something I can help with.' }
      : true;
  };
}
