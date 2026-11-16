import { DiscordError } from './discord-channels.js';

export const sourceParameter = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description:
    'Optional caller-supplied source string. Prefer the full originating client conversation URL; otherwise the declared client name plus session ID; otherwise the declared client name. Any client or domain is supported. Displayed visibly in the new-thread caption, including forks, after HTML stripping and formatting sanitization. Never added to agent input, fetched, or used as identity or authority. No automatic clientInfo wiring. Omit when unknown; do not add it to the prompt merely for attribution.',
};

/** Render untrusted attribution as visible text, keeping only channel tags and raw URLs active. */
export function displaySource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  )
    throw new DiscordError('SOURCE_INVALID');

  // Do not decode entities: reject them so encoded tags/controls cannot change interpretation.
  if (
    /&(?:#(?:[xX][0-9a-fA-F]+|[0-9]+);?|[a-zA-Z][a-zA-Z0-9]*;|(?:lt|gt|amp|quot)(?![a-zA-Z0-9=]))/i.test(
      value
    )
  )
    throw new DiscordError('SOURCE_INVALID');

  // Quotes may contain >. Preserve Discord channel tags and angle URLs before stripping HTML.
  const stripped = value.replace(
    /<#[1-9][0-9]{16,19}>|<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^<>\s]+>|<!--[\s\S]*?(?:-->|$)|<![^>]*(?:>|$)|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*(?:>|$)/g,
    (token) => (/^<(?:#|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/.test(token) ? token : '')
  );
  const displayed = stripped
    .replace(/<#[1-9][0-9]{16,19}>|<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^<>\s]+>|[^]/g, (token) => {
      if (/^<#[1-9][0-9]{16,19}>$/.test(token)) return token;
      // Drop angle brackets from raw URLs; sanitize their punctuation like all other text.
      const text = token.length > 1 ? token.slice(1, -1) : token;
      return text.replace(/@/g, '@\u200b').replace(/[\\\x60*_{}[\]()|~<>]/g, '\\$&');
    })
    .trim();
  if (!displayed || displayed.length > 1600) throw new DiscordError('SOURCE_INVALID');
  return displayed;
}
